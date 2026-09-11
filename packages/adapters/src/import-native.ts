import { assertPublisherNotFinished } from "@agentlive/publisher";
import {
  validateRemoteArtifactPolicy,
  remoteArtifactSecrets,
  type RemoteArtifactPolicy,
} from "./remote-artifacts.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PublisherJournal, PublisherNetwork } from "@agentlive/publisher";
import { atomicJson } from "@agentlive/storage";
import { request, delay } from "@agentlive/client/transport";
import {
  canonicalJson,
  COMPLETENESS_NOTICE_VERSION,
  cursorSchema,
  type CompletenessNotice,
} from "@agentlive/protocol";
import { localArtifactResolver } from "./local-artifacts.js";
export interface NativeImportOptions {
  /** Migration orchestration runs after policy construction, before remote creation. */
  beforeImport?: (
    identity: {
      converterVersion: string;
      filterFingerprint: string;
      nativeSessionId: string;
      sourcePrefix: string;
      sourceBytes: number;
      familySources?: readonly {
        sourcePath: string;
        nativeAgent: string;
        boundary: { prefixHash: string; offset: number };
      }[];
    },
    directory: string,
  ) => Promise<void>;
  artifactBundles?: boolean;
  remoteArtifacts?: RemoteArtifactPolicy;
  artifactRoots?: readonly string[];
  artifactBaseDirectory?: string;
  sourcePath: string;
  publisherRoot: string;
  serverOrigin: string;
  ownerCredential: string;
  title: string;
  visibility: "public" | "unlisted" | "private";
  secrets?: readonly string[];
  signal: AbortSignal;
}
/** Import supported native history privately, then expose an ended recording after durable upload. */
export async function importNativeRecording<Report>(
  options: NativeImportOptions,
  adapter: {
    agent: "codex" | "claude" | "kimi" | "opencode";
    converterVersion: string;
    source: {
      nativeSessionId: string;
      boundary: { prefixHash: string; offset: number };
    };
    familySources?: readonly {
      sourcePath: string;
      nativeAgent: string;
      boundary: { prefixHash: string; offset: number };
    }[];
    capture(
      journal: PublisherJournal,
      secrets: readonly string[],
      artifacts: Awaited<ReturnType<typeof localArtifactResolver>>,
    ): Promise<Report>;
    /** Messages whose redaction tail is withheld at the frozen boundary (counts only). */
    withheldTextMessages?(report: Report): number;
  },
) {
  if (options.remoteArtifacts) {
    const remoteArtifacts = validateRemoteArtifactPolicy(
      options.remoteArtifacts,
    );
    options = {
      ...options,
      remoteArtifacts,
      secrets: [
        ...(options.secrets ?? []),
        ...remoteArtifactSecrets(remoteArtifacts),
      ],
    };
  }
  if (options.artifactBundles)
    options = {
      ...options,
      secrets: [
        ...(options.secrets ?? []),
        "agentlive-artifact-bundle-policy-v2",
      ],
    };
  const source = adapter.source;
  const journal = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: options.serverOrigin,
    agent: adapter.agent,
    nativeSessionId: source.nativeSessionId,
  });
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  try {
    await assertPublisherNotFinished(journal.directory);
    for (const file of ["publish.json", "resume-import.json"]) {
      try {
        await readFile(join(journal.directory, file));
        throw new Error(
          "This binding is a live publisher or has a pending live transition; ending and importing it requires explicit migration",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const artifactBaseDirectory = resolve(
      options.artifactBaseDirectory ?? dirname(options.sourcePath),
    );
    const artifactRoots = (options.artifactRoots ?? [artifactBaseDirectory])
      .map((root) => resolve(root))
      .sort();
    const checkpoint = join(journal.directory, "import.json");
    let previous: Record<string, unknown> | undefined;
    try {
      previous = JSON.parse(await readFile(checkpoint, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Bindings created before completeness notices keep their original output on retry;
    // pinned bindings keep the notice version they were created with.
    const legacy =
      previous !== undefined &&
      !(
        typeof previous === "object" &&
        previous !== null &&
        "completenessNotice" in previous
      );
    const noticeVersion: 1 | 2 | undefined = legacy
      ? undefined
      : previous === undefined
        ? COMPLETENESS_NOTICE_VERSION
        : (previous.completenessNotice as 1 | 2);
    if (noticeVersion !== undefined && ![1, 2].includes(noticeVersion))
      throw new Error(
        "Import binding pins an unsupported completeness notice version",
      );
    const identity = {
      version: 1,
      converterVersion: adapter.converterVersion,
      artifactBaseDirectory,
      artifactRoots,
      filterFingerprint: createHash("sha256")
        .update(canonicalJson([...new Set(options.secrets ?? [])].sort()))
        .digest("hex"),
      ...(adapter.familySources
        ? { familySources: adapter.familySources }
        : {}),
      sourcePrefix: source.boundary.prefixHash,
      sourceBytes: source.boundary.offset,
      nativeSessionId: source.nativeSessionId,
      title: options.title,
      visibility: options.visibility,
      ...(noticeVersion === undefined
        ? {}
        : { completenessNotice: noticeVersion }),
    };
    await options.beforeImport?.(identity, journal.directory);
    if (previous !== undefined) {
      if (canonicalJson(previous) !== canonicalJson(identity))
        throw new Error(
          "Import source or options changed; explicitly select a new import or resume the existing recording",
        );
    } else await atomicJson(checkpoint, identity);
    let resumed = false;
    const network = new PublisherNetwork({
      journal,
      ownerCredential: options.ownerCredential,
      title: options.title,
      visibility: "private",
      onStatus: (status) => {
        if (status === "live") resumed = true;
      },
    });
    await network.ensureRemote(options.signal);
    artifacts = await localArtifactResolver({
      ...(options.artifactBundles ? { artifactBundles: true } : {}),
      ...(options.remoteArtifacts
        ? { remoteArtifacts: options.remoteArtifacts }
        : {}),
      directory: join(journal.directory, "artifacts"),
      roots: artifactRoots,
      baseDirectory: artifactBaseDirectory,
      secrets: [
        ...(options.secrets ?? []),
        options.ownerCredential,
        journal.identity.writeSecret,
      ],
      serverOrigin: journal.identity.serverOrigin,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal: options.signal,
    });
    const report = await adapter.capture(
      journal,
      [
        ...(options.secrets ?? []),
        options.ownerCredential,
        journal.identity.writeSecret,
      ],
      artifacts,
    );
    if (noticeVersion !== undefined)
      await captureCompletenessNotice(
        journal,
        adapter.withheldTextMessages?.(report) ?? 0,
        options.signal,
        noticeVersion,
      );
    const base = `${journal.identity.serverOrigin}/api/v1/streams/${journal.identity.streamId}`;
    const remoteBefore = z
      .object({
        revision: z.string(),
        serverSeq: cursorSchema,
        lifecycle: z.enum(["open", "ended"]),
      })
      .parse(
        JSON.parse(
          (
            await request(
              fetch,
              base,
              {
                headers: { authorization: `Bearer ${options.ownerCredential}` },
              },
              options.signal,
              4096,
            )
          ).text,
        ),
      );
    if (
      remoteBefore.revision !== journal.identity.revision ||
      remoteBefore.serverSeq < journal.identity.acknowledgedSeq + 1
    )
      throw new Error(
        "Remote imported history changed; explicit reconciliation is required",
      );
    if (!journal.identity.sharingEnabled)
      throw new Error("Import publishing is paused");
    if (
      remoteBefore.lifecycle === "ended" &&
      journal.identity.acknowledgedSeq < journal.capturedThrough
    )
      throw new Error("Ended recording is missing part of this import");
    if (remoteBefore.lifecycle === "open") {
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let failure: unknown;
      const running = network.run(signal).catch((error) => {
        failure = error;
      });
      try {
        while (
          journal.identity.acknowledgedSeq < journal.capturedThrough ||
          !resumed
        ) {
          options.signal.throwIfAborted();
          if (failure) throw failure;
          await delay(25, options.signal);
        }
      } finally {
        controller.abort();
        await running;
      }
      if (failure) throw failure;
    }
    const metadata = z
      .object({
        lifecycle: z.enum(["open", "ended"]),
        lifecycleSeq: cursorSchema,
      })
      .parse(
        JSON.parse(
          (
            await request(
              fetch,
              base,
              {
                headers: { authorization: `Bearer ${options.ownerCredential}` },
              },
              options.signal,
              4096,
            )
          ).text,
        ),
      );
    if (metadata.lifecycle !== "ended")
      await request(
        fetch,
        base + "/end",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${journal.identity.writeSecret}`,
            "content-type": "application/json",
          },
          body: canonicalJson({
            operationId: createHash("sha256")
              .update("import/end/" + source.boundary.prefixHash)
              .digest("hex"),
            expectedLifecycleSeq: metadata.lifecycleSeq,
            content: {
              kind: "recording.ended",
              payload: {
                producerEpoch: journal.identity.producerEpoch,
                throughProducerSeq: journal.capturedThrough,
              },
            },
          }),
        },
        options.signal,
        8192,
      );
    await request(
      fetch,
      base + "/share",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.ownerCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ visibility: options.visibility }),
      },
      options.signal,
      4096,
    );
    return {
      streamId: journal.identity.streamId!,
      revision: journal.identity.revision!,
      producerEvents: journal.capturedThrough,
      report,
    };
  } finally {
    try {
      await artifacts?.close();
    } finally {
      await journal.close();
    }
  }
}

/** Stable journal source key; one frozen-boundary notice per import binding. The key is
 * shared by both payload versions because a binding pins exactly one version. */
export const IMPORT_COMPLETENESS_SOURCE_KEY = "agentlive-import-completeness-1";
/** Append a content-free completeness notice after the converter output and before the
 * import ends. Counts are recomputed from the durable normalized prefix, so a retry
 * resolves to the same journal record instead of adding an event. `version` is the
 * binding's pin: version 1 reproduces the original payload and emission rule exactly. */
export async function captureCompletenessNotice(
  journal: PublisherJournal,
  withheldTextMessages: number,
  signal: AbortSignal,
  version: 1 | 2 = COMPLETENESS_NOTICE_VERSION,
): Promise<CompletenessNotice | undefined> {
  cursorSchema.parse(withheldTextMessages);
  type Item = { open: boolean; visible: boolean };
  const messages = new Map<string, Item>(),
    tools = new Map<string, Item>(),
    attachments = new Map<string, Item>(),
    tasks = new Map<string, boolean>(),
    interactions = new Map<string, boolean>();
  let last:
    | { observedAt: string; clockSegmentId: string; elapsedMs: number }
    | undefined;
  for await (const event of journal.pending(0)) {
    signal.throwIfAborted();
    if (event.source.eventId === IMPORT_COMPLETENESS_SOURCE_KEY) continue;
    last = event;
    const content = event.content;
    const set = (map: Map<string, Item>, id: string, change: Partial<Item>) => {
      const current = map.get(id) ?? { open: false, visible: true };
      map.set(id, { ...current, ...change });
    };
    // Same transitions as the reducers: starts reset visibility, updates preserve it.
    switch (content.kind) {
      case "message.started":
        messages.set(content.payload.messageId, { open: true, visible: true });
        break;
      case "message.completed":
      case "message.reopened":
        set(messages, content.payload.messageId, {
          open: content.kind === "message.reopened",
        });
        break;
      case "tool.started":
        tools.set(content.payload.toolId, { open: true, visible: true });
        break;
      case "tool.completed":
      case "tool.reopened":
        set(tools, content.payload.toolId, {
          open: content.kind === "tool.reopened",
        });
        break;
      case "attachment.pending":
        set(attachments, content.payload.artifactId, { open: true });
        break;
      case "attachment.available":
        set(attachments, content.payload.attachment.artifactId, {
          open: false,
        });
        break;
      case "attachment.unavailable":
        set(attachments, content.payload.artifactId, { open: false });
        break;
      case "task.updated":
        // Only `running` is active; `unknown` does not claim unfinished work.
        tasks.set(content.payload.taskId, content.payload.status === "running");
        break;
      case "interaction.updated":
        interactions.set(
          content.payload.interactionId,
          content.payload.status === "pending",
        );
        break;
      case "object.visibility":
        set(
          content.payload.objectType === "message"
            ? messages
            : content.payload.objectType === "tool"
              ? tools
              : attachments,
          content.payload.objectId,
          { visible: content.payload.visible },
        );
        break;
    }
  }
  const unfinished = (map: Map<string, Item>) =>
    [...map.values()].filter((item) => item.open && item.visible).length;
  const active = (map: Map<string, boolean>) =>
    [...map.values()].filter(Boolean).length;
  const base = {
    reason: "frozen-native-source" as const,
    unfinishedMessages: unfinished(messages),
    unfinishedTools: unfinished(tools),
    withheldTextMessages,
  };
  // Version 1 bindings keep their original payload and emission rule on retry.
  const notice: CompletenessNotice =
    version === 1
      ? { version: 1, ...base }
      : {
          version: 2,
          ...base,
          runningTasks: active(tasks),
          pendingInteractions: active(interactions),
          pendingAttachments: unfinished(attachments),
        };
  const { version: _version, reason: _reason, ...counts } = notice;
  if (!last || !Object.values(counts).some(Boolean)) return undefined;
  // Share the last imported event's clock so the notice sits at the frozen boundary.
  await journal.capture({
    sourceKey: IMPORT_COMPLETENESS_SOURCE_KEY,
    content: [{ kind: "capture.completeness", payload: notice }],
    observedAt: last.observedAt,
    clockSegmentId: last.clockSegmentId,
    elapsedMs: last.elapsedMs,
    fidelity: "reconstructed",
    adapterState: journal.checkpoint,
  });
  return notice;
}
