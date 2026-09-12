import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  freezeOpenCodeSource,
  frozenOpenCodePath,
  importClaudeRecording,
  importCodexRecording,
  importKimiRecording,
  importOpenCodeRecording,
  locateFileFamilySources,
  openCodeEntityIds,
  readFrozenOpenCodeSession,
  readJsonlSource,
  refreezeOpenCodeSession,
  visibleOpenCodeSnapshot,
  type FrozenOpenCodeSource,
  type FrozenSourceSnapshot,
  type OpenCodeNativeAccess,
  type OpenCodeSnapshot,
} from "@agentlive/adapters";
import {
  canonicalJson,
  idSchema,
  migrationOriginSchema,
  ProtocolError,
} from "@agentlive/protocol";
import {
  PublisherJournal,
  StreamingRedactor,
  finishJournal,
  liveMigrationDirectory,
  publisherBindingKey,
  readPublisherOperation,
} from "@agentlive/publisher";
import { FileLock, atomicJson } from "@agentlive/storage";
import { listRecordings, removeRecording } from "@agentlive/client";
import { originOf, request } from "@agentlive/client/transport";
import { findBinding } from "./publication.js";

const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative().safe();
const cursorSchema = z.strictObject({ offset, prefixHash: digest });
const liveManifestSchema = z.object({
  version: z.literal(1),
  converterVersion: z.string().min(1).max(200),
  recordFormat: z.string().min(1).max(100),
  familyRoot: z.string().min(1).optional(),
  baseDirectory: z.string().min(1),
  roots: z.array(z.string().min(1)).max(1000),
  title: z.string().max(500),
  visibility: z.enum(["private", "public", "unlisted"]),
  filterFingerprint: digest,
});
/** OpenCode live capture pins its own manifest shape: no record format or base directory. */
const openCodeManifestSchema = z.object({
  version: z.literal(1),
  converterVersion: z.string().min(1).max(200),
  artifactRoots: z.array(z.string().min(1)).max(1000),
  includeChildren: z.boolean().optional(),
  title: z.string().max(500),
  visibility: z.enum(["private", "public", "unlisted"]),
  filterFingerprint: digest,
});
/** Bounded view of one OpenCode converter state: which objects are currently shown. */
const captureStateSchema = z.object({
  nativeSessionId: z.string(),
  createdAt: z.number().int().nonnegative().optional(),
  entities: z.record(z.string(), z.object({ present: z.boolean() })),
});
const targetSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  producerEvents: offset,
});
const continuationSchema = z.strictObject({
  agent: z.enum(["claude", "codex", "kimi", "opencode"]),
  title: z.string().max(500),
  visibility: z.literal("private"),
  includeChildren: z.boolean(),
  sourceRoot: z.string().nullable(),
  recordFormat: z.string().nullable(),
  artifactBaseDirectory: z.string(),
  artifactRoots: z.array(z.string()),
  /** OpenCode continuation reads the frozen export again on every restart. */
  sourcePath: z.string().nullable().optional(),
  nativeServerOrigin: z.string().nullable().optional(),
});
const intentSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  requestHash: digest,
  serverOrigin: z.string(),
  nativeAgent: z.enum(["claude", "codex", "kimi", "opencode"]),
  nativeSessionId: idSchema,
  sourceStreamId: idSchema,
  sourceRevision: idSchema,
  sourceProducerEpoch: idSchema,
  sourceProducerEvents: offset,
  sourceManifestHash: digest,
  sourceConverterVersion: z.string().min(1).max(200),
  disposition: z.enum(["retain", "remove"]),
  targetDirectory: z.string(),
  targetPolicyHash: digest,
  targetConverterVersion: z.string().min(1).max(200),
  boundary: z.strictObject({
    root: cursorSchema,
    children: z
      .array(
        z.strictObject({ nativeAgent: idSchema, offset, prefixHash: digest }),
      )
      .max(199),
  }),
  continuation: continuationSchema,
  retiredDirectory: z.string(),
  /** Destination server, when the replacement is created on another one. */
  targetServerOrigin: z.string().optional(),
  /** Root native transcript, or the frozen OpenCode export this operation pinned. */
  nativeSourcePath: z.string().optional(),
  nativeServerOrigin: z.string().optional(),
  /** Directory holding the frozen OpenCode export family for this operation. */
  frozenDirectory: z.string().optional(),
  /** Set once the operator abandoned this migration; `completed` follows on disposal. */
  abandoning: z.boolean().optional(),
  abandoned: z.boolean().optional(),
  target: targetSchema.optional(),
  completed: z.boolean(),
});
type Intent = z.infer<typeof intentSchema>;
type ImportOptions = Parameters<typeof importCodexRecording>[0];
export type LiveMigrationPhase =
  "intent" | "imported" | "source-ended" | "lineage" | "retired" | "placed";

async function readJson(
  path: string,
  optional = false,
  limit = 1024 * 1024,
): Promise<unknown> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw new Error(`Cannot read live migration metadata: ${basename(path)}`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error(`Invalid live migration metadata: ${basename(path)}`);
    try {
      return JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error(`Invalid live migration metadata: ${basename(path)}`);
    }
  } finally {
    await file.close();
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/** Remote identity of the binding currently at a directory, if any. */
async function boundStream(directory: string) {
  const raw = await readJson(join(directory, "binding.json"), true).catch(
    () => undefined,
  );
  if (raw === undefined) return (await exists(directory)) ? null : undefined;
  const parsed = z
    .object({ streamId: idSchema.nullable(), serverOrigin: z.string() })
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Validate that a source file still starts with bytes a binding already captured. */
async function verifyPrefix(
  path: string,
  cursor: z.infer<typeof cursorSchema>,
  signal: AbortSignal,
) {
  for await (const _ of readJsonlSource(path, {
    after: cursor,
    through: cursor.offset,
    signal,
  }))
    void _;
}

/**
 * Resolve the live key directory for `--stream`, including after the source binding was
 * retired by an interrupted migration whose intent still names that recording.
 */
export async function resolveLiveMigrationDirectory(options: {
  publisherRoot: string;
  streamId: string;
  signal: AbortSignal;
}) {
  try {
    return await findBinding(options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No local"))
      throw error;
  }
  const root = join(options.publisherRoot, "live-migrations");
  let names: string[] = [];
  try {
    names = (await readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (names.length > 10_000) throw new Error("Too many live migrations");
  const matches: string[] = [];
  for (const name of names) {
    options.signal.throwIfAborted();
    const parsed = intentSchema.safeParse(
      await readJson(join(root, name, "intent.json"), true).catch(
        () => undefined,
      ),
    );
    if (parsed.success && parsed.data.sourceStreamId === options.streamId)
      matches.push(join(options.publisherRoot, name));
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Several live migrations name this recording; select one with --source <binding-directory>"
        : "No local publisher binding or live migration for this recording in the state directory",
    );
  return matches[0]!;
}

/** Server origin of the binding key, from its current binding or saved migration intent. */
export async function liveMigrationServerOrigin(directory: string) {
  const live = resolve(directory);
  const bound = await boundStream(live);
  if (bound) return bound.serverOrigin;
  const intent = intentSchema.safeParse(
    await readJson(
      join(
        liveMigrationDirectory(dirname(live), basename(live)),
        "intent.json",
      ),
      true,
    ),
  );
  if (!intent.success)
    throw new Error("Expected a live publisher binding directory");
  return intent.data.serverOrigin;
}

/** The saved request an interrupted operation must be repeated with, exactly. */
function liveMigrationRequestHash(
  liveKey: string,
  options: LiveMigrationSource & {
    operationId: string;
    expectedManifestHash: string;
    disposition: "retain" | "remove";
  },
  /** Present only for a migration to another server, so same-server hashes are unchanged. */
  targetServerOrigin?: string,
) {
  return hash({
    operationId: options.operationId,
    nativeSource: options.nativeSource ? resolve(options.nativeSource) : null,
    nativeServerOrigin: options.nativeServerOrigin ?? null,
    liveKey,
    expectedManifestHash: options.expectedManifestHash,
    disposition: options.disposition,
    ...(targetServerOrigin === undefined ? {} : { targetServerOrigin }),
  });
}

/** Publisher key the replacement occupies: the destination's, for a server migration. */
function liveMigrationTargetKey(intent: Intent, liveKey: string) {
  return intent.targetServerOrigin === undefined
    ? liveKey
    : publisherBindingKey({
        serverOrigin: intent.targetServerOrigin,
        agent: intent.nativeAgent,
        nativeSessionId: intent.nativeSessionId,
      });
}

/** The reservation a server migration leaves at the destination key while it runs. */
function liveMigrationReservation(publisherRoot: string, key: string) {
  return join(liveMigrationDirectory(publisherRoot, key), "reserved.json");
}

function receipt(intent: Intent, liveDirectory: string) {
  return {
    operationId: intent.operationId,
    serverOrigin: intent.serverOrigin,
    targetServerOrigin: intent.targetServerOrigin ?? intent.serverOrigin,
    sourceStreamId: intent.sourceStreamId,
    sourceRevision: intent.sourceRevision,
    sourceConverterVersion: intent.sourceConverterVersion,
    targetConverterVersion: intent.targetConverterVersion,
    disposition: intent.disposition,
    target: intent.target!,
    frozenBoundary: {
      sourceBytes: intent.boundary.root.offset,
      familySources: intent.boundary.children.length,
    },
    bindingDirectory: liveDirectory,
    retiredDirectory: intent.retiredDirectory,
    visibility: "private" as const,
    continuation: { ...intent.continuation, resumeImport: true as const },
    completed: true as const,
  };
}

/** Native access common to migration and abandonment of one binding. */
export interface LiveMigrationSource {
  /** Root native transcript, for Claude, Codex and Kimi bindings. */
  nativeSource?: string;
  /** OpenCode server the binding follows; its current export becomes the frozen source. */
  nativeServerOrigin?: string;
  nativePassword?: string;
  nativeUsername?: string;
}

/**
 * Replace an existing live binding with a new private recording converted from a
 * frozen native source under a changed converter/filter/artifact policy.
 *
 * File agents freeze their transcript at the last complete line. OpenCode has no
 * retained transcript, so its frozen source is a fresh native export written into the
 * operation's staging directory; retries convert exactly those bytes.
 *
 * The old recording is ended (lifecycle only) and never receives replacement content.
 * Its binding is retired and the verified replacement import takes over the live key,
 * so `publish --resume-import` with the new options continues it from the boundary.
 */
export async function migrateLiveBinding(
  options: LiveMigrationSource & {
    directory: string;
    operationId: string;
    expectedManifestHash: string;
    disposition: "retain" | "remove";
    confirmRemoval?: boolean;
    /** Recording the operator selected (`--stream`); guards against migrating a successor. */
    sourceStreamId?: string;
    ownerCredential: string;
    /** Create the replacement on this server instead of the binding's own. */
    targetServerOrigin?: string;
    /** Destination credential; required, and separate, for another server. */
    targetOwnerCredential?: string;
    secrets?: readonly string[];
    title?: string;
    artifactRoots?: readonly string[];
    artifactBaseDirectory?: string;
    artifactBundles?: boolean;
    remoteArtifacts?: ImportOptions["remoteArtifacts"];
    signal: AbortSignal;
    /** Called after each durable step; used to exercise interruption and resume. */
    onPhase?: (phase: LiveMigrationPhase) => Promise<void> | void;
  },
) {
  idSchema.parse(options.operationId);
  digest.parse(options.expectedManifestHash);
  z.enum(["retain", "remove"]).parse(options.disposition);
  if (options.disposition === "remove" && !options.confirmRemoval)
    throw new Error("Live migration removal requires --confirm-removal");
  if (options.title !== undefined) z.string().max(500).parse(options.title);
  const liveDirectory = resolve(options.directory);
  const liveKey = basename(liveDirectory);
  if (!/^[a-f0-9]{64}$/.test(liveKey))
    throw new Error("Expected a publisher binding directory");
  const publisherRoot = dirname(liveDirectory);
  const migrationRoot = liveMigrationDirectory(publisherRoot, liveKey);
  await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
  let lock: FileLock;
  try {
    lock = await FileLock.acquire(join(migrationRoot, ".migration.lock"));
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy")
      throw new Error("Another live migration is running for this binding");
    throw error;
  }
  try {
    const intentPath = join(migrationRoot, "intent.json");
    const saved = await readJson(intentPath, true);
    let intent: Intent | undefined;
    if (saved !== undefined) {
      const parsed = intentSchema.safeParse(saved);
      if (!parsed.success) throw new Error("Invalid live migration intent");
      intent = parsed.data;
    }
    const nativeSource = options.nativeSource
      ? resolve(options.nativeSource)
      : undefined;
    // The destination is external only when it differs from the binding's own server,
    // so a redundant --target-server keeps the same-server request identity.
    const live = await boundStream(liveDirectory);
    const sourceOrigin = intent?.serverOrigin ?? live?.serverOrigin;
    const requested =
      options.targetServerOrigin === undefined
        ? undefined
        : originOf(options.targetServerOrigin);
    const externalTarget =
      requested !== undefined && requested !== sourceOrigin
        ? requested
        : undefined;
    if (externalTarget !== undefined && !options.targetOwnerCredential)
      throw new Error(
        "Server migration requires a separate destination credential",
      );
    if (
      externalTarget === undefined &&
      options.targetOwnerCredential !== undefined &&
      options.targetOwnerCredential !== options.ownerCredential
    )
      throw new Error(
        "Same-server replacement must use its source owner credential",
      );
    const targetOwnerCredential =
      options.targetOwnerCredential ?? options.ownerCredential;
    const requestHash = liveMigrationRequestHash(
      liveKey,
      options,
      externalTarget,
    );
    if (intent && intent.operationId !== options.operationId) {
      if (!intent.completed)
        throw new Error(
          `Live migration ${intent.operationId} is pending for this binding; rerun it with its original arguments`,
        );
      intent = undefined; // Only the most recent receipt is retained.
    }
    if (intent?.abandoning)
      throw new Error(
        `Live migration ${intent.operationId} was abandoned; start a new operation to migrate this binding`,
      );
    if (intent && intent.requestHash !== requestHash)
      throw new Error(
        "Live migration request differs from the saved migration; use its original arguments",
      );
    if (
      intent &&
      options.sourceStreamId !== undefined &&
      intent.sourceStreamId !== options.sourceStreamId
    )
      throw new Error("Live migration intent belongs to another recording");
    if (intent?.completed)
      return receipt(
        intent,
        join(publisherRoot, liveMigrationTargetKey(intent, liveKey)),
      );
    const operationKey = hash(options.operationId);
    const stagingRoot = join(migrationRoot, operationKey);
    const retiredDirectory =
      intent?.retiredDirectory ??
      join(
        publisherRoot,
        "retired",
        `${liveKey}-live-migration-${operationKey.slice(0, 24)}`,
      );
    const save = async (next: Intent) => {
      await atomicJson(intentPath, next);
      intent = next;
    };

    // A migration to another server places its replacement at the destination key.
    const placedDirectory = () =>
      join(publisherRoot, liveMigrationTargetKey(intent!, liveKey));
    const placedStream =
      intent?.target === undefined
        ? undefined
        : await boundStream(placedDirectory());
    const placed =
      intent?.target !== undefined &&
      placedStream?.streamId === intent.target.streamId;
    if (!placed) {
      if (live === undefined) {
        if (!intent?.target || !(await exists(retiredDirectory)))
          throw new Error("Live publisher binding directory is missing");
      } else {
        if (intent && live?.streamId !== intent.sourceStreamId)
          throw new Error(
            "Another binding occupies the live key; finish or retire it before resuming this migration",
          );
        await replaceSource();
        await options.onPhase?.("retired");
      }
      // Take over the target key with the verified replacement.
      const staged = await boundStream(intent!.targetDirectory);
      if (!staged || staged.streamId !== intent!.target!.streamId)
        throw new Error("Staged replacement binding is missing");
      const destination = placedDirectory();
      if (await exists(destination))
        throw new Error(
          destination === liveDirectory
            ? "A binding appeared at the live key during migration; stop that publisher, retire its binding and rerun"
            : "A binding appeared at the destination key during migration; stop that publisher, retire its binding and rerun",
        );
      await rename(intent!.targetDirectory, destination);
      await options.onPhase?.("placed");
    }
    const current = intent!;
    if (current.disposition === "remove")
      await removeRecording({
        serverOrigin: current.serverOrigin,
        streamId: current.sourceStreamId,
        revision: current.sourceRevision,
        operationId: hash({ migration: current.operationId, action: "remove" }),
        credential: options.ownerCredential,
        signal: options.signal,
      });
    await save({ ...current, completed: true });
    // The destination key now holds the real binding; its reservation has no more work.
    if (current.targetServerOrigin !== undefined)
      await rm(
        liveMigrationReservation(
          publisherRoot,
          liveMigrationTargetKey(current, liveKey),
        ),
        { force: true },
      );
    return receipt(intent!, placedDirectory());

    /** Import the replacement, end/retire the source binding while owning its lock. */
    async function replaceSource() {
      let journal: PublisherJournal;
      try {
        journal = await PublisherJournal.openExisting(liveDirectory);
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "publisher_busy")
          throw new Error(
            "A publisher process is attached to this binding; stop it and retry",
          );
        throw error;
      }
      try {
        const binding = journal.identity;
        const agent = binding.nativeAgent;
        if (
          agent !== "claude" &&
          agent !== "codex" &&
          agent !== "kimi" &&
          agent !== "opencode"
        )
          throw new Error(
            "Live migration supports Claude, Codex, Kimi and OpenCode bindings",
          );
        const openCode = agent === "opencode";
        if (openCode && !options.nativeServerOrigin)
          throw new Error(
            "OpenCode live migration freezes a fresh native export; pass --native-server <origin>",
          );
        if (openCode && options.nativeSource)
          throw new Error(
            "OpenCode bindings have no native transcript; use --native-server instead of --native-source",
          );
        if (!openCode && !nativeSource)
          throw new Error("Live migration requires --native-source <file>");
        if (!openCode && options.nativeServerOrigin)
          throw new Error("--native-server applies only to OpenCode bindings");
        if (
          !binding.streamId ||
          !binding.revision ||
          binding.pendingCredentialRotation
        )
          throw new Error(
            "Live migration requires a bound publisher without credential rotation",
          );
        if (
          options.sourceStreamId !== undefined &&
          binding.streamId !== options.sourceStreamId
        )
          throw new Error(
            "The live binding now publishes another recording; select it with its current recording ID",
          );
        const read = (name: string) =>
          readJson(join(journal.directory, name), true);
        const publishedRaw = await read("publish.json");
        if (publishedRaw === undefined)
          throw new Error(
            "Live migration requires a live publisher binding; use migrate-import for frozen imports",
          );
        const fileManifest = openCode
          ? undefined
          : liveManifestSchema.parse(publishedRaw);
        const openCodeManifest = openCode
          ? openCodeManifestSchema.parse(publishedRaw)
          : undefined;
        const published = (fileManifest ?? openCodeManifest)!;
        if (
          hash(publishedRaw) !==
          (intent?.sourceManifestHash ?? options.expectedManifestHash)
        )
          throw new Error("Live publisher manifest changed since inspection");
        if (
          intent &&
          (intent.sourceStreamId !== binding.streamId ||
            intent.sourceRevision !== binding.revision ||
            intent.sourceProducerEpoch !== binding.producerEpoch ||
            intent.sourceProducerEvents !== journal.capturedThrough)
        )
          throw new Error("Live binding changed since the migration started");
        const resumed = await read("resume-import.json");
        if (
          resumed !== undefined &&
          (resumed as { complete?: unknown }).complete !== true
        )
          throw new Error("Finish the pending import resume before migrating");
        if ((await read("import-family-expansion.json")) !== undefined)
          throw new Error(
            "Finish the pending family expansion before migrating",
          );
        if (
          (await readPublisherOperation(
            journal.directory,
            "archive-transfer.json",
          )) !== undefined
        )
          throw new Error("A transferred binding cannot be migrated live");
        if (binding.acknowledgedSeq !== journal.capturedThrough)
          throw new Error(
            "The binding still has undelivered events; run the publisher until it is caught up, then stop it and retry",
          );
        const finishOperationId = hash({
          migration: options.operationId,
          action: "finish-source",
        });
        const finishRaw = await readPublisherOperation(
          journal.directory,
          "finish-publish.json",
        );
        const finish =
          finishRaw === undefined
            ? undefined
            : z
                .object({
                  operationId: idSchema,
                  streamId: idSchema,
                  revision: idSchema,
                  producerEvents: offset,
                  completed: z.boolean(),
                })
                .parse(finishRaw);
        if (
          finish &&
          ((!finish.completed && finish.operationId !== finishOperationId) ||
            finish.streamId !== binding.streamId ||
            finish.revision !== binding.revision ||
            finish.producerEvents !== journal.capturedThrough)
        )
          throw new Error(
            "The binding has a pending or different finish operation; complete it before migrating",
          );
        if (!binding.sharingEnabled && !finish?.completed)
          throw new Error(
            "Sharing is paused for this binding; resume it before migrating so its recording can be ended",
          );

        // Everything the old recording captured must lie inside the frozen source.
        const priorImport = await read("import.json");
        const rootCaptured: z.infer<typeof cursorSchema>[] = [];
        const childCaptured = new Map<string, z.infer<typeof cursorSchema>>();
        const family = openCode
          ? openCodeManifest!.includeChildren === true
          : /-family-/.test(published.converterVersion);
        let frozen: FrozenOpenCodeSource | undefined;
        if (openCode) {
          frozen = await freezeSource(family);
          await assertFrozenCoverage(frozen, family);
        } else {
          const nativeCursor = await read("native-cursor.json");
          if (nativeCursor !== undefined)
            rootCaptured.push(cursorSchema.parse(nativeCursor));
          if (priorImport !== undefined) {
            const parsed = z
              .object({
                sourceBytes: offset,
                sourcePrefix: digest,
                familySources: z
                  .array(
                    z.object({
                      nativeAgent: idSchema,
                      boundary: cursorSchema,
                    }),
                  )
                  .max(199)
                  .optional(),
              })
              .parse(priorImport);
            rootCaptured.push({
              offset: parsed.sourceBytes,
              prefixHash: parsed.sourcePrefix,
            });
            for (const child of parsed.familySources ?? [])
              childCaptured.set(
                createHash("sha256").update(child.nativeAgent).digest("hex"),
                child.boundary,
              );
          }
          const checkpointName = new RegExp(
            `^${agent}-child-([a-f0-9]{64})\\.json$`,
          );
          for (const name of await readdir(journal.directory)) {
            const match = checkpointName.exec(name);
            if (!match) continue;
            const cursor = cursorSchema.parse(await read(name));
            const prior = childCaptured.get(match[1]!);
            if (!prior || cursor.offset > prior.offset)
              childCaptured.set(match[1]!, cursor);
          }
          for (const cursor of rootCaptured)
            await verifyPrefix(nativeSource!, cursor, options.signal);
          if (agent === "codex" && family && !fileManifest!.familyRoot)
            throw new Error("Codex family binding lacks its source root");
          if (!family && childCaptured.size)
            throw new Error("Live binding has child sources outside its scope");
        }
        // The destination server never sees the source credential, but it can appear in
        // a title or artifact captured under the old policy; both values are filtered.
        const targetOrigin = externalTarget ?? binding.serverOrigin;
        const external = targetOrigin !== binding.serverOrigin;
        const secrets = external
          ? [...(options.secrets ?? []), options.ownerCredential]
          : (options.secrets ?? []);
        const titleFilter = new StreamingRedactor([
          ...secrets,
          options.ownerCredential,
          targetOwnerCredential,
          ...(options.remoteArtifacts?.origins.flatMap((entry) =>
            entry.authorization ? [entry.authorization] : [],
          ) ?? []),
        ]);
        const title = (
          titleFilter.push(options.title ?? published.title) +
          titleFilter.finish()
        ).slice(0, 500);
        const artifactRoots = [
          ...(options.artifactRoots ??
            (openCode ? openCodeManifest!.artifactRoots : fileManifest!.roots)),
        ].map((root) => resolve(root));
        // Live OpenCode capture resolves artifacts against its import base, or "/".
        const artifactBaseDirectory = resolve(
          options.artifactBaseDirectory ??
            (openCode
              ? priorImport === undefined
                ? "/"
                : z
                    .object({ artifactBaseDirectory: z.string().min(1) })
                    .parse(priorImport).artifactBaseDirectory
              : fileManifest!.baseDirectory),
        );
        const snapshot: FrozenSourceSnapshot = intent
          ? {
              rootThrough: intent.boundary.root.offset,
              children: Object.fromEntries(
                intent.boundary.children.map((child) => [
                  child.nativeAgent,
                  child.offset,
                ]),
              ),
            }
          : {};
        const sourcePath = openCode ? frozen!.root.sourcePath : nativeSource!;
        // A replacement on another server occupies that origin's binding key, not the
        // one being retired here.
        const expectedTarget = join(
          stagingRoot,
          publisherBindingKey({
            serverOrigin: targetOrigin,
            agent,
            nativeSessionId: binding.nativeSessionId,
          }),
        );
        if (external && !intent) {
          // Prove destination authorization before any durable intent or remote work.
          await listRecordings({
            serverOrigin: targetOrigin,
            credential: targetOwnerCredential,
            signal: options.signal,
            limit: 1,
          });
          if (await exists(join(publisherRoot, basename(expectedTarget))))
            throw new Error(
              "This native session already has a binding on the destination server; retire it before migrating",
            );
        }
        const common: ImportOptions = {
          sourcePath,
          publisherRoot: stagingRoot,
          serverOrigin: targetOrigin,
          ownerCredential: targetOwnerCredential,
          title,
          visibility: "private",
          signal: options.signal,
          secrets,
          artifactRoots,
          artifactBaseDirectory,
          ...(options.artifactBundles ? { artifactBundles: true } : {}),
          ...(options.remoteArtifacts
            ? { remoteArtifacts: options.remoteArtifacts }
            : {}),
          beforeImport: async (identity, targetDirectory) => {
            if (resolve(targetDirectory) !== expectedTarget)
              throw new Error(
                "Replacement binding key differs from the migration target",
              );
            if (identity.nativeSessionId !== binding.nativeSessionId)
              throw new Error("Native source belongs to another session");
            const boundary = {
              root: {
                offset: identity.sourceBytes,
                prefixHash: identity.sourcePrefix,
              },
              children: (identity.familySources ?? [])
                .map((child) => ({
                  nativeAgent: child.nativeAgent,
                  offset: child.boundary.offset,
                  prefixHash: child.boundary.prefixHash,
                }))
                .sort((a, b) => a.nativeAgent.localeCompare(b.nativeAgent)),
            };
            for (const cursor of rootCaptured)
              if (boundary.root.offset < cursor.offset)
                throw new Error(
                  "Frozen native boundary precedes the live binding's captured source",
                );
            const children = new Map(
              (identity.familySources ?? []).map((child) => [
                createHash("sha256").update(child.nativeAgent).digest("hex"),
                child,
              ]),
            );
            for (const [key, cursor] of childCaptured) {
              const child = children.get(key);
              if (!child || child.boundary.offset < cursor.offset)
                throw new Error(
                  "Frozen family boundary omits captured child source",
                );
              await verifyPrefix(child.sourcePath, cursor, options.signal);
            }
            const targetPolicyHash = hash(identity);
            if (intent) {
              if (
                canonicalJson(intent.boundary) !== canonicalJson(boundary) ||
                intent.targetPolicyHash !== targetPolicyHash ||
                intent.targetDirectory !== targetDirectory
              )
                throw new Error(
                  "Frozen boundary or replacement policy changed during retry",
                );
            } else {
              if (external) {
                // Fence the destination key before the replacement exists there.
                const reservation = liveMigrationReservation(
                  publisherRoot,
                  basename(expectedTarget),
                );
                await mkdir(dirname(reservation), {
                  recursive: true,
                  mode: 0o700,
                });
                await atomicJson(reservation, {
                  version: 1,
                  operationId: options.operationId,
                  sourceKey: liveKey,
                });
              }
              await save({
                version: 1,
                operationId: options.operationId,
                requestHash,
                serverOrigin: binding.serverOrigin,
                nativeAgent: agent,
                nativeSessionId: binding.nativeSessionId,
                sourceStreamId: binding.streamId!,
                sourceRevision: binding.revision!,
                sourceProducerEpoch: binding.producerEpoch,
                sourceProducerEvents: journal.capturedThrough,
                sourceManifestHash: hash(publishedRaw),
                sourceConverterVersion: published.converterVersion,
                disposition: options.disposition,
                targetDirectory,
                targetPolicyHash,
                targetConverterVersion: identity.converterVersion,
                boundary,
                continuation: {
                  agent,
                  title,
                  visibility: "private",
                  includeChildren: family,
                  sourceRoot:
                    agent === "codex" && family
                      ? fileManifest!.familyRoot!
                      : null,
                  recordFormat:
                    agent === "codex" ? fileManifest!.recordFormat : null,
                  artifactBaseDirectory,
                  artifactRoots: [...artifactRoots].sort(),
                  sourcePath: openCode ? sourcePath : null,
                  nativeServerOrigin: openCode
                    ? options.nativeServerOrigin!
                    : null,
                },
                retiredDirectory,
                ...(external ? { targetServerOrigin: targetOrigin } : {}),
                nativeSourcePath: sourcePath,
                ...(openCode
                  ? {
                      nativeServerOrigin: options.nativeServerOrigin!,
                      frozenDirectory: frozen!.directory,
                    }
                  : {}),
                completed: false,
              });
              await options.onPhase?.("intent");
            }
            await atomicJson(join(targetDirectory, "migration-origin.json"), {
              version: 1,
              operationId: options.operationId,
              mode: "live-binding",
              serverOrigin: binding.serverOrigin,
              streamId: binding.streamId,
              revision: binding.revision,
              sourceManifestHash: intent!.sourceManifestHash,
              targetPolicyHash,
              disposition: options.disposition,
            });
          },
        };
        const result = openCode
          ? await importOpenCodeRecording({
              ...common,
              ...(family ? { familyRoot: frozen!.directory } : {}),
            })
          : agent === "claude"
            ? await importClaudeRecording({
                ...common,
                includeChildren: family,
                snapshot,
              })
            : agent === "kimi"
              ? await importKimiRecording({
                  ...common,
                  includeChildren: family,
                  snapshot,
                })
              : await importCodexRecording({
                  ...common,
                  ...(family ? { familyRoot: fileManifest!.familyRoot! } : {}),
                  snapshot,
                });
        if (!intent) throw new Error("Replacement import did not save intent");
        const target = targetSchema.parse({
          streamId: result.streamId,
          revision: result.revision,
          producerEvents: result.producerEvents,
        });
        if (
          intent.target &&
          canonicalJson(intent.target) !== canonicalJson(target)
        )
          throw new Error("Replacement receipt changed during retry");
        // Verify the replacement before ending, linking or removing the source.
        const headers = { authorization: `Bearer ${options.ownerCredential}` };
        const targetHeaders = {
          authorization: `Bearer ${targetOwnerCredential}`,
        };
        const metadata = z
          .object({
            revision: z.string(),
            lifecycle: z.string(),
            visibility: z.string(),
          })
          .parse(
            JSON.parse(
              (
                await request(
                  fetch,
                  `${targetOrigin}/api/v1/streams/${target.streamId}`,
                  { headers: targetHeaders },
                  options.signal,
                  4096,
                )
              ).text,
            ),
          );
        if (
          metadata.revision !== target.revision ||
          metadata.lifecycle !== "ended" ||
          metadata.visibility !== "private"
        )
          throw new Error(
            "Replacement recording is not a private ended import",
          );
        if (!intent.target) await save({ ...intent, target });
        await options.onPhase?.("imported");

        // End the source recording; this is a lifecycle event, not replacement content.
        if (!finish?.completed) {
          let open = finish !== undefined;
          if (!open) {
            const source = z
              .object({
                revision: z.literal(binding.revision),
                lifecycle: z.string(),
              })
              .parse(
                JSON.parse(
                  (
                    await request(
                      fetch,
                      `${binding.serverOrigin}/api/v1/streams/${binding.streamId}`,
                      { headers },
                      options.signal,
                      4096,
                    )
                  ).text,
                ),
              );
            open = source.lifecycle !== "ended";
          }
          if (open)
            await finishJournal(journal, {
              operationId: finishOperationId,
              ownerCredential: options.ownerCredential,
              signal: options.signal,
            });
        }
        await options.onPhase?.("source-ended");

        const origin = migrationOriginSchema.parse({
          version: 1,
          operationId: options.operationId,
          sourceStreamId: binding.streamId,
          sourceRevision: binding.revision,
          sourceConverterVersion: published.converterVersion,
          targetConverterVersion: intent.targetConverterVersion,
          requestedSourceDisposition: options.disposition,
          // The destination cannot check the source server; the owner declares it.
          ...(external
            ? {
                externalSource: {
                  serverOrigin: binding.serverOrigin,
                  verification: "owner-declared",
                },
              }
            : {}),
        });
        const lineage = z
          .strictObject({
            revision: z.literal(target.revision),
            origin: migrationOriginSchema,
          })
          .parse(
            JSON.parse(
              (
                await request(
                  fetch,
                  `${targetOrigin}/api/v1/streams/${target.streamId}/migration-origin`,
                  {
                    method: "POST",
                    headers: {
                      ...targetHeaders,
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({ revision: target.revision, origin }),
                  },
                  options.signal,
                  4096,
                )
              ).text,
            ),
          );
        if (canonicalJson(lineage.origin) !== canonicalJson(origin))
          throw new Error("Migration lineage receipt differs");
        await options.onPhase?.("lineage");

        // Retire the source binding while its lock is held; nothing can append to it now.
        await atomicJson(join(journal.directory, "live-migration.json"), {
          version: 1,
          operationId: options.operationId,
          targetStreamId: target.streamId,
          targetRevision: target.revision,
        });
        if (await exists(retiredDirectory))
          throw new Error("Retired binding destination already exists");
        await mkdir(dirname(retiredDirectory), {
          recursive: true,
          mode: 0o700,
        });
        await rename(journal.directory, retiredDirectory);

        /**
         * Freeze the OpenCode source: on the first attempt export the native server's
         * current state for the bound session (plus every discoverable descendant for a
         * family binding); afterwards convert exactly the bytes the intent pinned. A
         * missing frozen file is restored from the server only when it reproduces those
         * bytes, so a session that moved on can never change the target.
         */
        async function freezeSource(includeChildren: boolean) {
          const directory =
            intent?.frozenDirectory ?? join(stagingRoot, "frozen");
          const access: OpenCodeNativeAccess = {
            origin: options.nativeServerOrigin!,
            nativeSessionId: binding.nativeSessionId,
            includeChildren,
            signal: options.signal,
            ...(options.nativePassword
              ? { password: options.nativePassword }
              : {}),
            ...(options.nativeUsername
              ? { username: options.nativeUsername }
              : {}),
          };
          if (!intent) return freezeOpenCodeSource(access, directory);
          const pinned = [
            {
              nativeSessionId: binding.nativeSessionId,
              boundary: intent.boundary.root,
            },
            ...intent.boundary.children.map((child) => ({
              nativeSessionId: child.nativeAgent,
              boundary: { offset: child.offset, prefixHash: child.prefixHash },
            })),
          ];
          const sessions = [];
          for (const entry of pinned) {
            options.signal.throwIfAborted();
            const path = frozenOpenCodePath(directory, entry.nativeSessionId);
            let snapshot;
            try {
              snapshot = await readFrozenOpenCodeSession(path, entry.boundary);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
              snapshot = (
                await refreezeOpenCodeSession(
                  access,
                  directory,
                  entry.nativeSessionId,
                  entry.boundary,
                )
              ).snapshot;
            }
            sessions.push({
              nativeSessionId: entry.nativeSessionId,
              ...(snapshot.info.parentID
                ? { parentNativeSessionId: snapshot.info.parentID }
                : {}),
              sourcePath: path,
              boundary: entry.boundary,
              snapshot,
            });
          }
          const [root, ...children] = sessions;
          return { directory, root: root!, children };
        }

        /**
         * OpenCode has no byte prefix to compare, so the equivalent guarantee is that the
         * frozen snapshots still produce every converter entity this binding currently
         * shows. A reverted, deleted or recreated native session is rejected instead of
         * silently dropping content the old recording published.
         */
        async function assertFrozenCoverage(
          source: FrozenOpenCodeSource,
          includeChildren: boolean,
        ) {
          const captured = async (path: string) => {
            const raw = await readJson(path, true, 16 * 1024 * 1024);
            return raw === undefined
              ? undefined
              : captureStateSchema.parse(raw);
          };
          const covers = (
            state: z.infer<typeof captureStateSchema>,
            session: { nativeSessionId: string; snapshot: OpenCodeSnapshot },
            child: boolean,
          ) => {
            const ids = openCodeEntityIds(
              visibleOpenCodeSnapshot(session.snapshot),
              child ? { nativeSessionId: session.nativeSessionId } : undefined,
            );
            for (const [id, entity] of Object.entries(state.entities))
              if (entity.present && !ids.has(id))
                throw new Error(
                  "The OpenCode server no longer shows source objects this binding captured; it cannot supply a consistent frozen source",
                );
          };
          const root = await captured(
            join(journal.directory, "opencode-live", "state.json"),
          );
          if (root) {
            if (
              root.nativeSessionId !== binding.nativeSessionId ||
              (root.createdAt !== undefined &&
                root.createdAt !== source.root.snapshot.info.time.created)
            )
              throw new Error(
                "The OpenCode native session was recreated since this binding captured it",
              );
            covers(root, source.root, false);
          }
          let names: string[] = [];
          try {
            names = await readdir(join(journal.directory, "opencode-children"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (names.length && !includeChildren)
            throw new Error("Live binding has child sources outside its scope");
          const children = new Map(
            source.children.map((child) => [child.nativeSessionId, child]),
          );
          for (const name of names) {
            const state = await captured(
              join(journal.directory, "opencode-children", name, "state.json"),
            );
            if (!state) continue;
            const child = children.get(state.nativeSessionId);
            if (!child)
              throw new Error(
                "The OpenCode server no longer reports a child session this binding captured",
              );
            if (
              state.createdAt !== undefined &&
              state.createdAt !== child.snapshot.info.time.created
            )
              throw new Error(
                "An OpenCode child session was recreated since this binding captured it",
              );
            covers(state, child, true);
          }
        }
      } finally {
        await journal.close();
      }
    }
  } catch (error) {
    // Schema diagnostics may quote metadata or native values.
    if (error instanceof z.ZodError)
      throw new Error(
        "Live migration metadata or native source failed validation",
      );
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Release a live-binding migration that can never complete, so the fenced native
 * session becomes publishable again.
 *
 * It refuses whenever the operation could still finish: while the source binding has
 * already been retired (only a local rename and the disposition remain), and while the
 * frozen source it pinned can still be read. Otherwise it removes the staged private
 * replacement recording, deletes the staging directory with its frozen exports, and
 * marks the intent abandoned. The original binding is never written to: it keeps its
 * recording, its visibility and its captured events exactly as they were.
 */
export async function abandonLiveMigration(
  options: LiveMigrationSource & {
    directory: string;
    operationId: string;
    expectedManifestHash: string;
    disposition: "retain" | "remove";
    confirmRemoval?: boolean;
    sourceStreamId?: string;
    ownerCredential: string;
    /** Destination of a server migration; checked against the saved intent. */
    targetServerOrigin?: string;
    /** Destination credential, which is what removes the staged replacement there. */
    targetOwnerCredential?: string;
    signal: AbortSignal;
    /** Called after each durable step; used to exercise interruption and resume. */
    onPhase?: (
      phase: "abandoning" | "removed" | "discarded",
    ) => Promise<void> | void;
  },
) {
  idSchema.parse(options.operationId);
  const liveDirectory = resolve(options.directory);
  const liveKey = basename(liveDirectory);
  if (!/^[a-f0-9]{64}$/.test(liveKey))
    throw new Error("Expected a publisher binding directory");
  const publisherRoot = dirname(liveDirectory);
  const migrationRoot = liveMigrationDirectory(publisherRoot, liveKey);
  let lock: FileLock;
  try {
    lock = await FileLock.acquire(join(migrationRoot, ".migration.lock"));
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy")
      throw new Error("Another live migration is running for this binding");
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("No live migration exists for this binding");
    throw error;
  }
  try {
    const intentPath = join(migrationRoot, "intent.json");
    const saved = await readJson(intentPath, true);
    if (saved === undefined)
      throw new Error("No live migration intent exists for this binding");
    const parsed = intentSchema.safeParse(saved);
    if (!parsed.success) throw new Error("Invalid live migration intent");
    let intent = parsed.data;
    if (intent.operationId !== options.operationId)
      throw new Error(
        `Live migration ${intent.operationId} is pending for this binding; abandon it with its own operation ID`,
      );
    if (
      options.sourceStreamId !== undefined &&
      intent.sourceStreamId !== options.sourceStreamId
    )
      throw new Error("Live migration intent belongs to another recording");
    if (
      intent.requestHash !==
      liveMigrationRequestHash(liveKey, options, intent.targetServerOrigin)
    )
      throw new Error(
        "Abandon request differs from the saved migration; use its original arguments",
      );
    if (
      options.targetServerOrigin !== undefined &&
      originOf(options.targetServerOrigin) !==
        (intent.targetServerOrigin ?? intent.serverOrigin)
    )
      throw new Error("Live migration intent names another destination server");
    const targetOrigin = intent.targetServerOrigin ?? intent.serverOrigin;
    if (
      intent.targetServerOrigin !== undefined &&
      options.targetOwnerCredential === undefined
    )
      throw new Error(
        "Abandoning a server migration requires its destination credential",
      );
    const stagingRoot = join(migrationRoot, hash(options.operationId));
    // A crash between remote creation and the saved receipt still leaves the staged
    // binding on disk; its identity is what has to be removed.
    const stagedBinding = z
      .object({ streamId: idSchema, revision: idSchema })
      .safeParse(
        await readJson(
          join(intent.targetDirectory, "binding.json"),
          true,
        ).catch(() => undefined),
      );
    const replacement =
      intent.target ?? (stagedBinding.success ? stagedBinding.data : undefined);
    const receipt = () => ({
      operationId: intent.operationId,
      serverOrigin: intent.serverOrigin,
      targetServerOrigin: targetOrigin,
      sourceStreamId: intent.sourceStreamId,
      sourceRevision: intent.sourceRevision,
      bindingDirectory: liveDirectory,
      stagingDirectory: stagingRoot,
      stagedRecording: replacement
        ? { streamId: replacement.streamId, disposition: "removed" as const }
        : null,
      abandoned: true as const,
      completed: true as const,
    });
    if (intent.abandoned) return receipt();
    if (!intent.abandoning) {
      if (!(await exists(liveDirectory)))
        throw new Error(
          "This migration already retired the source binding and ended its recording; rerun migrate-live to finish it",
        );
      // Exclude a publisher without opening or recovering the binding's journal.
      const bindingLock = await FileLock.acquire(
        join(liveDirectory, ".publisher.lock"),
      ).catch((error: unknown) => {
        if (error instanceof ProtocolError && error.code === "publisher_busy")
          throw new Error(
            "A publisher process is attached to this binding; stop it and retry",
          );
        throw error;
      });
      try {
        const finish = await readJson(
          join(liveDirectory, "finish-publish.json"),
          true,
        ).catch(() => undefined);
        if ((finish as { completed?: unknown } | undefined)?.completed === true)
          throw new Error(
            "This migration already ended the source recording; rerun migrate-live to finish it",
          );
        await assertFrozenSourceLost(intent, options);
      } finally {
        await bindingLock.release();
      }
      if (replacement && !options.confirmRemoval)
        throw new Error(
          `Abandoning removes the staged private replacement recording ${replacement.streamId}; pass --confirm-removal`,
        );
      intent = { ...intent, abandoning: true };
      await atomicJson(intentPath, intent);
      await options.onPhase?.("abandoning");
    }
    if (replacement)
      await removeRecording({
        serverOrigin: targetOrigin,
        streamId: replacement.streamId,
        revision: replacement.revision,
        operationId: hash({
          migration: intent.operationId,
          action: "abandon-remove-target",
        }),
        credential: options.targetOwnerCredential ?? options.ownerCredential,
        signal: options.signal,
      }).catch((error: unknown) => {
        // A removed replacement stays removed; the retry only finishes disposal.
        if (!(error instanceof ProtocolError) || error.code !== "stream_gone")
          throw error;
      });
    await options.onPhase?.("removed");
    await rm(stagingRoot, { recursive: true, force: true });
    await options.onPhase?.("discarded");
    intent = { ...intent, abandoned: true, completed: true };
    await atomicJson(intentPath, intent);
    if (intent.targetServerOrigin !== undefined)
      await rm(
        liveMigrationReservation(
          publisherRoot,
          liveMigrationTargetKey(intent, liveKey),
        ),
        { force: true },
      );
    return receipt();
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error("Live migration metadata failed validation");
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Abandonment is only for operations that cannot finish. A retry converts the source
 * the intent pinned, so the operation is still completable exactly while that source
 * still reads back: the native prefix for a file agent, the frozen export (or a native
 * server that still reproduces it) for OpenCode.
 */
async function assertFrozenSourceLost(
  intent: Intent,
  options: LiveMigrationSource & { signal: AbortSignal },
) {
  const stillThere = new Error(
    "This migration can still complete; rerun migrate-live with its original arguments, or make the source unavailable before abandoning",
  );
  if (intent.nativeAgent === "opencode") {
    const directory = intent.frozenDirectory;
    if (directory === undefined) return; // Interrupted before any export was pinned.
    const access: OpenCodeNativeAccess = {
      origin: intent.nativeServerOrigin ?? options.nativeServerOrigin ?? "",
      nativeSessionId: intent.nativeSessionId,
      includeChildren: intent.boundary.children.length > 0,
      signal: options.signal,
      ...(options.nativePassword ? { password: options.nativePassword } : {}),
      ...(options.nativeUsername ? { username: options.nativeUsername } : {}),
    };
    const pinned = [
      {
        nativeSessionId: intent.nativeSessionId,
        boundary: intent.boundary.root,
      },
      ...intent.boundary.children.map((child) => ({
        nativeSessionId: child.nativeAgent,
        boundary: { offset: child.offset, prefixHash: child.prefixHash },
      })),
    ];
    for (const entry of pinned) {
      const path = frozenOpenCodePath(directory, entry.nativeSessionId);
      try {
        await readFrozenOpenCodeSession(path, entry.boundary);
        continue;
      } catch {
        options.signal.throwIfAborted();
      }
      try {
        await refreezeOpenCodeSession(
          access,
          directory,
          entry.nativeSessionId,
          entry.boundary,
        );
      } catch {
        options.signal.throwIfAborted();
        return; // This session cannot be frozen again: the migration is dead.
      }
    }
    throw stillThere;
  }
  const path = intent.nativeSourcePath ?? options.nativeSource;
  if (path === undefined) return;
  try {
    // The root prefix is what every retry re-reads first; child sources are
    // rediscovered from it by the importer.
    await verifyPrefix(resolve(path), intent.boundary.root, options.signal);
  } catch {
    options.signal.throwIfAborted();
    return;
  }
  // A retry re-freezes the whole pinned family, so one lost child kills the
  // operation just as surely as a lost root: the importer refuses to import
  // without it, and the boundary cannot be narrowed after the fact.
  if (intent.boundary.children.length > 0) {
    let located;
    try {
      located = await locateFileFamilySources({
        agent: intent.nativeAgent as "claude" | "codex" | "kimi",
        sourcePath: resolve(path),
        nativeSessionId: intent.nativeSessionId,
        ...(intent.continuation.sourceRoot !== null
          ? { familyRoot: intent.continuation.sourceRoot }
          : {}),
        signal: options.signal,
      });
    } catch {
      options.signal.throwIfAborted();
      return; // The family cannot be enumerated again: the migration is dead.
    }
    for (const child of intent.boundary.children) {
      const childPath = located.get(child.nativeAgent);
      if (childPath === undefined) return;
      try {
        await verifyPrefix(
          childPath,
          { offset: child.offset, prefixHash: child.prefixHash },
          options.signal,
        );
      } catch {
        options.signal.throwIfAborted();
        return;
      }
    }
  }
  throw stillThere;
}
