import { verifyCodexFamilySources } from "@agentlive/adapters";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FileLock, atomicJson } from "@agentlive/storage";
import { idSchema, canonicalJson } from "@agentlive/protocol";
import { originOf } from "@agentlive/client/transport";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const policySchema = z.object({
  version: z.literal(1),
  converterVersion: z.string().min(1).max(200),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface FrozenImportMigrationState {
  directory: string;
  binding: {
    serverOrigin: string;
    nativeAgent: "codex" | "claude" | "kimi" | "opencode";
    nativeSessionId: string;
    streamId: string;
    revision: string;
  };
  imported: unknown;
  read(name: string, optional?: boolean): Promise<unknown>;
}
/** Inspect bounded metadata while excluding writers. Never open/recover the journal
 * or return credential-bearing binding fields and arbitrary manifest values. */
async function inspectMigrationState(
  directory: string,
  options: {
    nativeSource?: string;
    sourceRoot?: string;
    verifyFamily?: boolean;
    familySources?: readonly string[];
    signal?: AbortSignal;
    relocation?: { operationId: string; expectedManifestHash: string };
    execute?: (state: FrozenImportMigrationState) => Promise<void>;
  } = {},
) {
  options.signal?.throwIfAborted();
  const relocated = new Map<string, string>();
  if (options.familySources?.length && !options.verifyFamily)
    throw new Error("Child source mappings require --verify-family");
  if ((options.familySources?.length ?? 0) > 199)
    throw new Error("Too many child source mappings");
  for (const entry of options.familySources ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1)
      throw new Error("Expected --family-source child-id=path");
    const identity = entry.slice(0, separator);
    if (!idSchema.safeParse(identity).success || relocated.has(identity))
      throw new Error("Invalid or duplicate child source mapping");
    relocated.set(identity, entry.slice(separator + 1));
  }
  const path = resolve(directory);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Expected a publisher binding directory");
  const root = await realpath(path);
  const lock = await FileLock.acquire(join(root, ".publisher.lock"));
  async function read(name: string, optional = false): Promise<unknown> {
    let file;
    try {
      file = await open(
        join(root, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw new Error(`Cannot read migration metadata: ${name}`);
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 1024 * 1024 ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("Invalid metadata file");
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const chunk = await file.read(bytes, size, bytes.length - size, size);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size === bytes.length) throw new Error("Metadata exceeds limit");
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new Error(`Invalid migration metadata: ${name}`);
    } finally {
      await file.close();
    }
  }
  try {
    const binding = z
      .object({
        version: z.literal(1),
        serverOrigin: z.string(),
        nativeAgent: z.enum(["codex", "claude", "kimi", "opencode"]),
        nativeSessionId: idSchema,
        streamId: idSchema.nullable(),
        revision: idSchema.nullable(),
        acknowledgedSeq: z.number().int().nonnegative().safe(),
        pendingCredentialRotation: z.unknown().optional(),
      })
      .parse(await read("binding.json"));
    const origin = originOf(binding.serverOrigin);
    if (
      origin !== binding.serverOrigin ||
      (binding.streamId === null) !== (binding.revision === null)
    )
      throw new Error("Invalid binding identity");
    const imported = await read("import.json", true),
      published = await read("publish.json", true),
      resumed = await read("resume-import.json", true);
    const policy = (value: unknown) => {
      if (value === undefined) return null;
      const parsed = policySchema.parse(value);
      return {
        converterVersion: parsed.converterVersion,
        filterFingerprint: parsed.filterFingerprint,
        manifestHash: hash(value),
      };
    };
    let sourceBoundary = null;
    if (imported !== undefined) {
      const source = z
        .object({
          nativeSessionId: z.literal(binding.nativeSessionId),
          sourceBytes: z.number().int().nonnegative().safe(),
          sourcePrefix: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(imported);
      sourceBoundary = {
        bytes: source.sourceBytes,
        prefixHash: source.sourcePrefix,
      };
    }
    let sourceVerification:
      | {
          verifiedBytes: number;
          remainingBytes: number;
          completeLineBoundary: boolean;
        }
      | undefined;
    const verifySource = async (
      candidate: string,
      boundary: { bytes: number; prefixHash: string },
    ) => {
      const file = await open(
        resolve(candidate),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size < boundary.bytes)
          throw new Error(
            "Native source is not a regular file or was truncated",
          );
        if (
          binding.nativeAgent === "opencode" &&
          before.size !== boundary.bytes
        )
          throw new Error("OpenCode export size differs from frozen import");
        const digest = createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let offset = 0,
          lastByte: number | undefined;
        while (offset < boundary.bytes) {
          options.signal?.throwIfAborted();
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, boundary.bytes - offset),
            offset,
          );
          if (!bytesRead)
            throw new Error("Native source changed during verification");
          digest.update(buffer.subarray(0, bytesRead));
          lastByte = buffer[bytesRead - 1];
          offset += bytesRead;
        }
        if (digest.digest("hex") !== boundary.prefixHash)
          throw new Error("Native source prefix differs from frozen import");
        const after = await file.stat();
        const current = await lstat(resolve(candidate));
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          current.isSymbolicLink() ||
          current.dev !== before.dev ||
          current.ino !== before.ino
        )
          throw new Error("Native source changed during verification");
        const verified = {
          verifiedBytes: offset,
          remainingBytes: before.size - offset,
          completeLineBoundary: offset === 0 || lastByte === 10,
        };
        if (
          binding.nativeAgent !== "opencode" &&
          verified.remainingBytes > 0 &&
          !verified.completeLineBoundary
        )
          throw new Error(
            "Appended native source does not start at a complete-line boundary",
          );
        options.signal?.throwIfAborted();
        return verified;
      } finally {
        await file.close();
      }
    };
    if (options.nativeSource !== undefined) {
      if (!sourceBoundary)
        throw new Error(
          "Native source verification requires a frozen import boundary",
        );
      sourceVerification = await verifySource(
        options.nativeSource,
        sourceBoundary,
      );
    }
    let familyVerification:
      | {
          verifiedSources: number;
          verifiedBytes: number;
          remainingBytes: number;
        }
      | undefined;
    if (options.verifyFamily) {
      if (!sourceVerification || imported === undefined)
        throw new Error(
          "Family verification requires --native-source and a frozen import",
        );
      const { familySources } = z
        .object({
          familySources: z
            .array(
              z.object({
                sourcePath: z.string().min(1),
                nativeAgent: idSchema,
                boundary: z.object({
                  offset: z.number().int().nonnegative().safe(),
                  prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
                }),
              }),
            )
            .max(199)
            .default([]),
        })
        .parse(imported);
      for (const identity of relocated.keys())
        if (!familySources.some((child) => child.nativeAgent === identity))
          throw new Error(
            "Child source mapping does not belong to the imported family",
          );
      const identities = new Set<string>();
      familyVerification = {
        verifiedSources: 0,
        verifiedBytes: 0,
        remainingBytes: 0,
      };
      for (const child of familySources) {
        if (identities.has(child.nativeAgent))
          throw new Error("Duplicate imported family identity");
        identities.add(child.nativeAgent);
        let verified;
        try {
          verified = await verifySource(
            relocated.get(child.nativeAgent) ?? child.sourcePath,
            {
              bytes: child.boundary.offset,
              prefixHash: child.boundary.prefixHash,
            },
          );
        } catch {
          options.signal?.throwIfAborted();
          throw new Error("Imported family source verification failed");
        }
        familyVerification.verifiedSources++;
        familyVerification.verifiedBytes += verified.verifiedBytes;
        familyVerification.remainingBytes += verified.remainingBytes;
        if (
          !Number.isSafeInteger(familyVerification.verifiedBytes) ||
          !Number.isSafeInteger(familyVerification.remainingBytes)
        )
          throw new Error("Family source size exceeds supported range");
      }
    }
    const transition =
      resumed === undefined
        ? null
        : z
            .object({
              complete: z.boolean(),
              revision: idSchema,
              operationId: idSchema,
            })
            .parse(resumed);
    if (transition && imported === undefined)
      throw new Error("Resume metadata lacks an import");
    let relocationReceipt:
      | {
          operationId: string;
          beforeHash: string;
          afterHash: string;
          completed: true;
        }
      | undefined;
    if (options.relocation) {
      const operationId = idSchema.parse(options.relocation.operationId);
      const expected = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(options.relocation.expectedManifestHash);
      if (
        imported === undefined ||
        published !== undefined ||
        resumed !== undefined ||
        binding.pendingCredentialRotation !== undefined
      )
        throw new Error(
          "Source relocation requires an import without publishing, resume or credential transitions",
        );
      if (!familyVerification || relocated.size === 0)
        throw new Error(
          "Source relocation requires verified root/family sources and explicit child mappings",
        );
      if (binding.nativeAgent === "claude" || binding.nativeAgent === "kimi") {
        const nativeSource = resolve(options.nativeSource!);
        let familyRoot = join(
          dirname(nativeSource),
          binding.nativeSessionId,
          "subagents",
        );
        if (binding.nativeAgent === "kimi") {
          const agents = dirname(dirname(nativeSource));
          familyRoot = dirname(agents);
          if (
            basename(nativeSource) !== "wire.jsonl" ||
            basename(dirname(nativeSource)) !== "main" ||
            basename(agents) !== "agents" ||
            basename(familyRoot) !== `session_${binding.nativeSessionId}`
          )
            throw new Error(
              "Relocated Kimi sources must preserve the native family layout",
            );
        }
        for (const [identity, candidate] of relocated) {
          const expected =
            binding.nativeAgent === "kimi"
              ? join(familyRoot, "agents", identity, "wire.jsonl")
              : join(familyRoot, `agent-${identity}.jsonl`);
          if (resolve(candidate) !== expected)
            throw new Error(
              "Relocated child source does not match the live family layout",
            );
        }
      }
      const mappings = [...relocated]
        .map(([id, candidate]) => [id, resolve(candidate)])
        .sort((a, b) => a[0]!.localeCompare(b[0]!));
      const intentSchema = z.strictObject({
        version: z.literal(1),
        operationId: idSchema,
        beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
        afterHash: z.string().regex(/^[a-f0-9]{64}$/),
        mappings: z.array(z.tuple([idSchema, z.string().min(1)])).max(199),
        completed: z.boolean(),
      });
      const rawIntent = await read("relocate-import.json", true);
      let intent =
        rawIntent === undefined ? undefined : intentSchema.parse(rawIntent);
      const currentHash = hash(imported);
      const parsed = z
        .object({
          familySources: z
            .array(
              z
                .object({ nativeAgent: idSchema, sourcePath: z.string() })
                .passthrough(),
            )
            .max(199),
        })
        .passthrough()
        .parse(imported);
      const next = {
        ...parsed,
        familySources: parsed.familySources.map((child) => ({
          ...child,
          sourcePath: relocated.has(child.nativeAgent)
            ? resolve(relocated.get(child.nativeAgent)!)
            : child.sourcePath,
        })),
      };
      if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024)
        throw new Error("Relocated import manifest exceeds limit");
      if (binding.nativeAgent === "codex") {
        if (!options.sourceRoot)
          throw new Error(
            "Codex relocation requires --source-root for native family discovery",
          );
        await verifyCodexFamilySources({
          root: options.sourceRoot,
          nativeSessionId: binding.nativeSessionId,
          sourcePath: options.nativeSource!,
          children: next.familySources,
          signal: options.signal ?? new AbortController().signal,
        });
      }
      const nextHash = hash(next);
      if (intent?.operationId === operationId) {
        if (
          intent.beforeHash !== expected ||
          canonicalJson(intent.mappings) !== canonicalJson(mappings) ||
          ![intent.beforeHash, intent.afterHash].includes(currentHash) ||
          nextHash !== intent.afterHash
        )
          throw new Error("Source relocation retry differs from saved intent");
      } else {
        if (intent && !intent.completed)
          throw new Error(
            "Finish the pending source relocation before starting another",
          );
        if (currentHash !== expected)
          throw new Error("Import manifest changed since inspection");
        intent = {
          version: 1,
          operationId,
          beforeHash: currentHash,
          afterHash: nextHash,
          mappings: mappings as [string, string][],
          completed: false,
        };
        options.signal?.throwIfAborted();
        await atomicJson(join(root, "relocate-import.json"), intent);
      }

      options.signal?.throwIfAborted();
      if (currentHash !== intent.afterHash)
        await atomicJson(join(root, "import.json"), next);
      if (!intent.completed)
        await atomicJson(join(root, "relocate-import.json"), {
          ...intent,
          completed: true,
        });
      relocationReceipt = {
        operationId,
        beforeHash: intent.beforeHash,
        afterHash: intent.afterHash,
        completed: true,
      };
    }
    if (options.execute) {
      if (
        !imported ||
        published !== undefined ||
        resumed !== undefined ||
        binding.pendingCredentialRotation !== undefined ||
        !binding.streamId ||
        !binding.revision ||
        !sourceVerification ||
        sourceVerification.remainingBytes ||
        familyVerification?.remainingBytes
      )
        throw new Error(
          "Replacement migration requires an exact frozen import without live transitions",
        );
      await options.execute({
        directory: root,
        binding: {
          ...binding,
          streamId: binding.streamId,
          revision: binding.revision,
        },
        imported,
        read,
      });
    }
    return {
      version: 1,
      serverOrigin: origin,
      nativeAgent: binding.nativeAgent,
      nativeSessionId: binding.nativeSessionId,
      streamId: binding.streamId,
      revision: binding.revision,
      acknowledgedSeq: binding.acknowledgedSeq,
      mode: transition
        ? transition.complete
          ? "resumed-import"
          : "pending-resume"
        : imported !== undefined
          ? "import"
          : published !== undefined
            ? "live"
            : "unconfigured",
      imported: policy(imported),
      published: policy(published),
      sourceBoundary,
      pendingCredentialRotation:
        binding.pendingCredentialRotation !== undefined,
      pendingResume: transition !== null && !transition.complete,
      verification: familyVerification
        ? "frozen-import-family-prefixes"
        : sourceVerification
          ? "frozen-import-prefix"
          : "metadata-only",
      ...(familyVerification ? { familyVerification } : {}),
      ...(sourceVerification ? { sourceVerification } : {}),
      migrationImplemented: false,
      ...(relocationReceipt ? { relocation: relocationReceipt } : {}),
    };
  } catch (error) {
    // Schema diagnostics may quote input values, including malformed credentials.
    if (error instanceof z.ZodError)
      throw new Error("Invalid publisher migration metadata schema");
    throw error;
  } finally {
    await lock.release();
  }
}

export async function inspectMigration(
  directory: string,
  options: {
    nativeSource?: string;
    sourceRoot?: string;
    verifyFamily?: boolean;
    familySources?: readonly string[];
    signal?: AbortSignal;
  } = {},
) {
  return inspectMigrationState(directory, options);
}

export async function relocateImportSources(
  directory: string,
  options: {
    nativeSource: string;
    sourceRoot?: string;
    familySources: readonly string[];
    operationId: string;
    expectedManifestHash: string;
    signal?: AbortSignal;
  },
) {
  const result = await inspectMigrationState(directory, {
    nativeSource: options.nativeSource,
    ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
    familySources: options.familySources,
    verifyFamily: true,
    ...(options.signal ? { signal: options.signal } : {}),
    relocation: {
      operationId: options.operationId,
      expectedManifestHash: options.expectedManifestHash,
    },
  });
  return result.relocation!;
}

/** Hold the source publisher lock through the replacement transaction. */
export async function withFrozenImportMigration(
  directory: string,
  nativeSource: string,
  signal: AbortSignal,
  execute: (state: FrozenImportMigrationState) => Promise<void>,
) {
  await inspectMigrationState(directory, {
    nativeSource,
    verifyFamily: true,
    signal,
    execute,
  });
}
