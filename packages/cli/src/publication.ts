import { constants } from "node:fs";
import { lstat, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PublisherJournal,
  finishPublisher,
  readPublisherOperation,
} from "@agentlive/publisher";
import {
  canonicalJson,
  cursorSchema,
  idSchema,
  ProtocolError,
  storedEventSchema,
} from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import { request, delay, retryable } from "@agentlive/client/transport";

const MAX_BINDINGS = 10_000;
const MAX_ARTIFACT_ENTRIES = 100_000;

const bindingSchema = z.object({
  version: z.literal(1),
  serverOrigin: z.string(),
  nativeAgent: z.string(),
  nativeSessionId: z.string(),
  streamId: z.string().nullable(),
  revision: z.string().nullable(),
  sharingEnabled: z.boolean(),
  acknowledgedSeq: z.number().int().nonnegative(),
  creationTime: z.string(),
  pendingCredentialRotation: z.object({}).passthrough().optional(),
});
const finishSchema = z.object({
  operationId: idSchema,
  streamId: idSchema,
  revision: idSchema,
  producerEvents: cursorSchema,
  completed: z.boolean(),
  endServerSeq: cursorSchema.optional(),
});
const reopenSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  finishOperationId: idSchema,
  streamId: idSchema,
  revision: idSchema,
  expectedLifecycleSeq: cursorSchema,
  complete: z.boolean(),
});

async function readPrivateJson(path: string): Promise<unknown | undefined> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536)
      throw new Error("Invalid publisher metadata file");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

async function directorySize(root: string) {
  let bytes = 0,
    files = 0,
    entries = 0,
    truncated = false;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (++entries > MAX_ARTIFACT_ENTRIES) {
        truncated = true;
        return { bytes, files, truncated };
      }
      const info = await lstat(join(directory, name));
      if (info.isDirectory()) pending.push(join(directory, name));
      else if (info.isFile()) {
        bytes += info.size;
        files++;
      }
    }
  }
  return { bytes, files, truncated };
}

export interface PublisherStatusEntry {
  bindingDirectory: string;
  agent: string;
  nativeSessionId: string;
  serverOrigin: string;
  streamId: string | null;
  revision: string | null;
  viewerUrl: string | null;
  mode: "live" | "import" | "unbound";
  sharing: "enabled" | "paused";
  attached: boolean;
  lifecycle: "open" | "finishing" | "finished" | "reopening" | "transferred";
  capturedEvents: number | null;
  acknowledgedEvents: number;
  pendingEvents: number | null;
  oldestPendingObservedAt: string | null;
  journalBytes: number;
  artifactSpool: { files: number; bytes: number; truncated: boolean };
  pendingCredentialRotation: boolean;
  createdAt: string;
  notes: string[];
}

export function viewerUrl(serverOrigin: string, streamId: string): string {
  const url = new URL("/", serverOrigin);
  url.searchParams.set("stream", streamId);
  return url.toString();
}

/** List bounded, content-free status for every local publisher binding. */
export async function publisherStatus(options: {
  publisherRoot: string;
  streamId?: string;
  signal: AbortSignal;
}): Promise<PublisherStatusEntry[]> {
  let names: string[];
  try {
    names = (await readdir(options.publisherRoot)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_BINDINGS)
    throw new Error("Too many publisher bindings to inspect");
  const result: PublisherStatusEntry[] = [];
  for (const name of names) {
    options.signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = join(options.publisherRoot, name);
    const info = await lstat(directory);
    if (!info.isDirectory()) continue;
    const raw = await readPrivateJson(join(directory, "binding.json"));
    if (raw === undefined) continue;
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success) {
      result.push(invalidEntry(directory));
      continue;
    }
    const binding = parsed.data;
    if (options.streamId && binding.streamId !== options.streamId) continue;
    result.push(await inspectBinding(directory, binding, options.signal));
  }
  return result;
}

function invalidEntry(directory: string): PublisherStatusEntry {
  return {
    bindingDirectory: directory,
    agent: "unknown",
    nativeSessionId: "unknown",
    serverOrigin: "unknown",
    streamId: null,
    revision: null,
    viewerUrl: null,
    mode: "unbound",
    sharing: "paused",
    attached: false,
    lifecycle: "open",
    capturedEvents: null,
    acknowledgedEvents: 0,
    pendingEvents: null,
    oldestPendingObservedAt: null,
    journalBytes: 0,
    artifactSpool: { files: 0, bytes: 0, truncated: false },
    pendingCredentialRotation: false,
    createdAt: "unknown",
    notes: ["Invalid binding metadata; inspect with recover-publisher"],
  };
}

async function inspectBinding(
  directory: string,
  binding: z.infer<typeof bindingSchema>,
  signal: AbortSignal,
): Promise<PublisherStatusEntry> {
  const notes: string[] = [];
  let attached = false,
    captured: number | null = null,
    acknowledged = binding.acknowledgedSeq,
    oldest: string | null = null,
    sharing = binding.sharingEnabled;
  try {
    const journal = await PublisherJournal.openExisting(directory);
    try {
      captured = journal.capturedThrough;
      acknowledged = journal.identity.acknowledgedSeq;
      sharing = journal.identity.sharingEnabled;
      if (acknowledged < captured)
        for await (const event of journal.pending()) {
          oldest = event.observedAt;
          break;
        }
    } finally {
      await journal.close();
    }
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy") {
      attached = true;
      notes.push(
        "A publisher process is attached; captured counts are unavailable until it detaches",
      );
    } else if (
      error instanceof ProtocolError &&
      error.code === "corrupt_storage"
    ) {
      notes.push("Local journal failed validation: " + error.message);
    } else throw error;
  }
  signal.throwIfAborted();
  const finish = finishSchema.safeParse(
    await readPublisherOperation(directory, "finish-publish.json"),
  );
  const reopen = reopenSchema.safeParse(
    await readPrivateJson(join(directory, "reopen-publish.json")),
  );
  const transfer = await readPublisherOperation(
    directory,
    "archive-transfer.json",
  );
  const lifecycle: PublisherStatusEntry["lifecycle"] =
    transfer !== undefined
      ? "transferred"
      : finish.success
        ? finish.data.completed
          ? "finished"
          : "finishing"
        : reopen.success && !reopen.data.complete
          ? "reopening"
          : "open";
  if (lifecycle === "finishing")
    notes.push("A finish operation is pending; rerun finish to complete it");
  if (lifecycle === "reopening")
    notes.push("A reopen operation is pending; rerun reopen to complete it");
  if (!sharing)
    notes.push(
      "Sharing is paused: nothing is captured or delivered until resume",
    );
  if (binding.pendingCredentialRotation)
    notes.push("A publisher credential rotation is pending");
  const hasImport =
    (await readPrivateJson(join(directory, "import.json"))) !== undefined;
  const hasLive =
    (await readPrivateJson(join(directory, "publish.json"))) !== undefined;
  let journalBytes = 0;
  try {
    journalBytes = (await lstat(join(directory, "capture.jsonl"))).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    bindingDirectory: directory,
    agent: binding.nativeAgent,
    nativeSessionId: binding.nativeSessionId,
    serverOrigin: binding.serverOrigin,
    streamId: binding.streamId,
    revision: binding.revision,
    viewerUrl: binding.streamId
      ? viewerUrl(binding.serverOrigin, binding.streamId)
      : null,
    mode: !binding.streamId
      ? "unbound"
      : hasImport && !hasLive
        ? "import"
        : "live",
    sharing: sharing ? "enabled" : "paused",
    attached,
    lifecycle,
    capturedEvents: captured,
    acknowledgedEvents: acknowledged,
    pendingEvents: captured === null ? null : captured - acknowledged,
    oldestPendingObservedAt: oldest,
    journalBytes,
    artifactSpool: await directorySize(join(directory, "artifacts")),
    pendingCredentialRotation: !!binding.pendingCredentialRotation,
    createdAt: binding.creationTime,
    notes,
  };
}

/** Resolve exactly one local binding directory for a recording ID. */
export async function findBinding(options: {
  publisherRoot: string;
  streamId: string;
  signal: AbortSignal;
}): Promise<string> {
  idSchema.parse(options.streamId);
  const matches = (
    await publisherStatus({
      publisherRoot: options.publisherRoot,
      streamId: options.streamId,
      signal: options.signal,
    })
  ).map((entry) => entry.bindingDirectory);
  if (!matches.length)
    throw new Error(
      "No local publisher binding for this recording in the state directory",
    );
  if (matches.length > 1)
    throw new Error(
      "Several local bindings publish this recording; select one with --source <binding-directory>",
    );
  return matches[0]!;
}

/** Persist sharing intent in a detached binding; a running publisher must be stopped first. */
export async function setPublisherSharing(options: {
  directory: string;
  enabled: boolean;
}) {
  let journal: PublisherJournal;
  try {
    journal = await PublisherJournal.openExisting(options.directory);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy")
      throw new Error(
        "A publisher process is attached to this binding; stop it (Ctrl-C) and retry",
      );
    throw error;
  }
  try {
    const before = journal.identity.sharingEnabled;
    if (before !== options.enabled) await journal.setSharing(options.enabled);
    const identity = journal.identity;
    return {
      bindingDirectory: journal.directory,
      streamId: identity.streamId,
      sharing: identity.sharingEnabled ? "enabled" : "paused",
      changed: before !== options.enabled,
      pendingEvents: journal.capturedThrough - identity.acknowledgedSeq,
    };
  } finally {
    await journal.close();
  }
}

/** Finish with a stable, persisted operation ID so plain retries are idempotent. */
export async function finishBinding(options: {
  directory: string;
  ownerCredential: string;
  signal: AbortSignal;
}) {
  const saved = finishSchema.safeParse(
    await readPublisherOperation(options.directory, "finish-publish.json"),
  );
  return finishPublisher({
    directory: options.directory,
    operationId: saved.success ? saved.data.operationId : randomUUID(),
    ownerCredential: options.ownerCredential,
    signal: options.signal,
  });
}

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * Reopen a recording this binding explicitly finished. The reopen intent is
 * persisted before the idempotent server operation, and the finish record is
 * retired only after the server acknowledges the reopened lifecycle.
 */
export async function reopenBinding(options: {
  directory: string;
  signal: AbortSignal;
}) {
  let journal: PublisherJournal;
  try {
    journal = await PublisherJournal.openExisting(options.directory);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "publisher_busy")
      throw new Error(
        "A publisher process is attached to this binding; stop it and retry",
      );
    throw error;
  }
  try {
    const identity = journal.identity;
    if (!identity.streamId || !identity.revision)
      throw new Error("Publisher has no remote recording to reopen");
    if (
      (await readPublisherOperation(
        journal.directory,
        "archive-transfer.json",
      )) !== undefined
    )
      throw new Error(
        "This binding was transferred to another recording and cannot be reopened",
      );
    const intentPath = join(journal.directory, "reopen-publish.json");
    const finishPath = join(journal.directory, "finish-publish.json");
    const savedIntent = await readPrivateJson(intentPath);
    let intent =
      savedIntent === undefined ? undefined : reopenSchema.parse(savedIntent);
    if (intent?.complete) intent = undefined;
    const finishRaw = await readPublisherOperation(
      journal.directory,
      "finish-publish.json",
    );
    const finish =
      finishRaw === undefined ? undefined : finishSchema.parse(finishRaw);
    if (!intent) {
      if (!finish)
        throw new Error(
          "This binding has no completed finish; only explicitly finished recordings can be reopened here (imports use publish --resume-import)",
        );
      if (!finish.completed || finish.endServerSeq === undefined)
        throw new Error(
          "The finish operation is still pending; complete it before reopening",
        );
      if (
        finish.streamId !== identity.streamId ||
        finish.revision !== identity.revision
      )
        throw new ProtocolError(
          "revision_changed",
          "Finish record belongs to another recording revision",
        );
      intent = {
        version: 1,
        operationId: digest({
          operation: "reopen-finished",
          revision: identity.revision,
          finishOperationId: finish.operationId,
          endServerSeq: finish.endServerSeq,
        }),
        finishOperationId: finish.operationId,
        streamId: identity.streamId,
        revision: identity.revision,
        expectedLifecycleSeq: finish.endServerSeq,
        complete: false,
      };
      await atomicJson(intentPath, intent);
    } else if (
      intent.streamId !== identity.streamId ||
      intent.revision !== identity.revision
    )
      throw new ProtocolError(
        "revision_changed",
        "Saved reopen intent belongs to another recording revision",
      );
    const base = `${identity.serverOrigin}/api/v1/streams/${identity.streamId}`;
    const headers = { authorization: `Bearer ${identity.writeSecret}` };
    let attempt = 0;
    let text: string;
    while (true) {
      try {
        text = (
          await request(
            fetch,
            base + "/reopen",
            {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: canonicalJson({
                operationId: intent.operationId,
                expectedLifecycleSeq: intent.expectedLifecycleSeq,
                content: { kind: "recording.reopened", payload: {} },
              }),
            },
            options.signal,
            16384,
          )
        ).text;
        break;
      } catch (error) {
        if (options.signal.aborted || !retryable(error)) throw error;
        await delay(
          Math.min(30_000, 250 * 2 ** Math.min(attempt++, 7)),
          options.signal,
        );
      }
    }
    const reopened = storedEventSchema.parse(JSON.parse(text));
    if (
      reopened.content.kind !== "recording.reopened" ||
      reopened.origin.type !== "server" ||
      reopened.origin.operationId !== intent.operationId
    )
      throw new Error("Unexpected reopen acknowledgment");
    if (finish && finish.operationId === intent.finishOperationId)
      await rename(
        finishPath,
        join(journal.directory, `finish-${intent.finishOperationId}.json`),
      );
    await atomicJson(intentPath, { ...intent, complete: true });
    return {
      bindingDirectory: journal.directory,
      streamId: identity.streamId,
      revision: identity.revision,
      reopenServerSeq: reopened.serverSeq,
      viewerUrl: viewerUrl(identity.serverOrigin, identity.streamId),
    };
  } finally {
    await journal.close();
  }
}
