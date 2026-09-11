import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  importClaudeRecording,
  importCodexRecording,
  importKimiRecording,
  readJsonlSource,
  type FrozenSourceSnapshot,
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
  readPublisherOperation,
} from "@agentlive/publisher";
import { FileLock, atomicJson } from "@agentlive/storage";
import { removeRecording } from "@agentlive/client";
import { request } from "@agentlive/client/transport";
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
const targetSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  producerEvents: offset,
});
const continuationSchema = z.strictObject({
  agent: z.enum(["claude", "codex", "kimi"]),
  title: z.string().max(500),
  visibility: z.literal("private"),
  includeChildren: z.boolean(),
  sourceRoot: z.string().nullable(),
  recordFormat: z.string().nullable(),
  artifactBaseDirectory: z.string(),
  artifactRoots: z.array(z.string()),
});
const intentSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  requestHash: digest,
  serverOrigin: z.string(),
  nativeAgent: z.enum(["claude", "codex", "kimi"]),
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
  target: targetSchema.optional(),
  completed: z.boolean(),
});
type Intent = z.infer<typeof intentSchema>;
type ImportOptions = Parameters<typeof importCodexRecording>[0];
export type LiveMigrationPhase =
  "intent" | "imported" | "source-ended" | "lineage" | "retired" | "placed";

async function readJson(path: string, optional = false): Promise<unknown> {
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
    if (!info.isFile() || info.size > 1024 * 1024)
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

function receipt(intent: Intent, liveDirectory: string) {
  return {
    operationId: intent.operationId,
    serverOrigin: intent.serverOrigin,
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

/**
 * Replace an existing live file-agent binding with a new private recording converted
 * from a frozen native prefix under a changed converter/filter/artifact policy.
 *
 * The old recording is ended (lifecycle only) and never receives replacement content.
 * Its binding is retired and the verified replacement import takes over the live key,
 * so `publish --resume-import` with the new options continues it from the boundary.
 */
export async function migrateLiveBinding(options: {
  directory: string;
  nativeSource: string;
  operationId: string;
  expectedManifestHash: string;
  disposition: "retain" | "remove";
  confirmRemoval?: boolean;
  /** Recording the operator selected (`--stream`); guards against migrating a successor. */
  sourceStreamId?: string;
  ownerCredential: string;
  secrets?: readonly string[];
  title?: string;
  artifactRoots?: readonly string[];
  artifactBaseDirectory?: string;
  artifactBundles?: boolean;
  remoteArtifacts?: ImportOptions["remoteArtifacts"];
  signal: AbortSignal;
  /** Called after each durable step; used to exercise interruption and resume. */
  onPhase?: (phase: LiveMigrationPhase) => Promise<void> | void;
}) {
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
    const nativeSource = resolve(options.nativeSource);
    const requestHash = hash({
      operationId: options.operationId,
      nativeSource,
      liveKey,
      expectedManifestHash: options.expectedManifestHash,
      disposition: options.disposition,
    });
    if (intent && intent.operationId !== options.operationId) {
      if (!intent.completed)
        throw new Error(
          `Live migration ${intent.operationId} is pending for this binding; rerun it with its original arguments`,
        );
      intent = undefined; // Only the most recent receipt is retained.
    }
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
    if (intent?.completed) return receipt(intent, liveDirectory);
    const operationKey = hash(options.operationId);
    const stagingRoot = join(migrationRoot, operationKey);
    const expectedTarget = join(stagingRoot, liveKey);
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

    const live = await boundStream(liveDirectory);
    const placed =
      intent?.target !== undefined && live?.streamId === intent.target.streamId;
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
      // Take over the live key with the verified replacement.
      const staged = await boundStream(intent!.targetDirectory);
      if (!staged || staged.streamId !== intent!.target!.streamId)
        throw new Error("Staged replacement binding is missing");
      if (await exists(liveDirectory))
        throw new Error(
          "A binding appeared at the live key during migration; stop that publisher, retire its binding and rerun",
        );
      await rename(intent!.targetDirectory, liveDirectory);
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
    return receipt(intent!, liveDirectory);

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
        if (agent !== "claude" && agent !== "codex" && agent !== "kimi")
          throw new Error(
            agent === "opencode"
              ? "Live migration does not support OpenCode bindings yet; finish the recording and replace it with import plus migrate-import"
              : "Live migration supports Claude, Codex and Kimi bindings",
          );
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
        const published = liveManifestSchema.parse(publishedRaw);
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

        // Everything the old recording captured must lie inside the frozen replacement prefix.
        const rootCaptured: z.infer<typeof cursorSchema>[] = [];
        const nativeCursor = await read("native-cursor.json");
        if (nativeCursor !== undefined)
          rootCaptured.push(cursorSchema.parse(nativeCursor));
        const priorImport = await read("import.json");
        const childCaptured = new Map<string, z.infer<typeof cursorSchema>>();
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
          await verifyPrefix(nativeSource, cursor, options.signal);

        const family = /-family-/.test(published.converterVersion);
        if (agent === "codex" && family && !published.familyRoot)
          throw new Error("Codex family binding lacks its source root");
        if (!family && childCaptured.size)
          throw new Error("Live binding has child sources outside its scope");
        const secrets = options.secrets ?? [];
        const titleFilter = new StreamingRedactor([
          ...secrets,
          options.ownerCredential,
          ...(options.remoteArtifacts?.origins.flatMap((entry) =>
            entry.authorization ? [entry.authorization] : [],
          ) ?? []),
        ]);
        const title = (
          titleFilter.push(options.title ?? published.title) +
          titleFilter.finish()
        ).slice(0, 500);
        const artifactRoots = [
          ...(options.artifactRoots ?? published.roots),
        ].map((root) => resolve(root));
        const artifactBaseDirectory = resolve(
          options.artifactBaseDirectory ?? published.baseDirectory,
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
        const common: ImportOptions = {
          sourcePath: nativeSource,
          publisherRoot: stagingRoot,
          serverOrigin: binding.serverOrigin,
          ownerCredential: options.ownerCredential,
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
                "Replacement binding key differs from the live binding",
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
                    agent === "codex" && family ? published.familyRoot! : null,
                  recordFormat:
                    agent === "codex" ? published.recordFormat : null,
                  artifactBaseDirectory,
                  artifactRoots: [...artifactRoots].sort(),
                },
                retiredDirectory,
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
        const result =
          agent === "claude"
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
                  ...(family ? { familyRoot: published.familyRoot! } : {}),
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
                  `${binding.serverOrigin}/api/v1/streams/${target.streamId}`,
                  { headers },
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
                  `${binding.serverOrigin}/api/v1/streams/${target.streamId}/migration-origin`,
                  {
                    method: "POST",
                    headers: {
                      ...headers,
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
