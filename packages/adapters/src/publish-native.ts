import { assertPublisherNotFinished } from "@agentlive/publisher";
import {
  validateRemoteArtifactPolicy,
  remoteArtifactSecrets,
} from "./remote-artifacts.js";
import { prepareImportedFileExpansion } from "./expand-import-family.js";
import { isFileFamilyExpansion } from "./expand-family.js";
import { resumeImportedRecording } from "./resume-import.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PublisherJournal,
  PublisherNetwork,
  type PublisherStatus,
} from "@agentlive/publisher";
import { atomicJson } from "@agentlive/storage";
import { canonicalJson } from "@agentlive/protocol";
import { delay } from "@agentlive/client/transport";
import type { NativeImportOptions } from "./import-native.js";
import { type SourceCursor, readJsonlSource } from "./jsonl.js";
import { localArtifactResolver } from "./local-artifacts.js";

export interface NativePublishOptions extends NativeImportOptions {
  resumeImport?: boolean;
  expandFamily?: boolean;
  finishRequested?: () => boolean;
  onProgress?: (progress: {
    sourceCursor: SourceCursor;
    producerEvents: number;
  }) => void;
  onReady?: (recording: { streamId: string; revision: string }) => void;
  onStatus?: (status: PublisherStatus) => void;
  onCaughtUp?: (boundary: { producerEvents: number }) => Promise<void>;
}
/** Stop detaches this publisher; durable pending events remain for the next attach. */
export interface NativeFollowContext {
  sourcePath: string;
  journal: PublisherJournal;
  signal: AbortSignal;
  secrets: readonly string[];
  artifacts: Awaited<ReturnType<typeof localArtifactResolver>>;
  onCaughtUp: () => Promise<void>;
  onRecordCommitted: (cursor: SourceCursor) => Promise<void>;
}
export async function publishNativeRecording(
  options: NativePublishOptions,
  adapter: {
    agent: "codex" | "claude" | "kimi";
    nativeSessionId: string;
    converterVersion: string;
    recordFormat: string;
    familyRoot?: string;
    follow: (context: NativeFollowContext) => Promise<void>;
  },
): Promise<void> {
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
  const journal = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: options.serverOrigin,
    agent: adapter.agent,
    nativeSessionId: adapter.nativeSessionId,
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  let running: Promise<void> | undefined;
  let networkFailure: unknown;
  try {
    await assertPublisherNotFinished(journal.directory);
    const baseDirectory = resolve(
      options.artifactBaseDirectory ?? dirname(options.sourcePath),
    );
    const roots = (options.artifactRoots ?? [baseDirectory])
      .map((root) => resolve(root))
      .sort();
    const identity = {
      version: 1,
      converterVersion: adapter.converterVersion,
      recordFormat: adapter.recordFormat,
      ...(adapter.familyRoot
        ? { familyRoot: resolve(adapter.familyRoot) }
        : {}),
      baseDirectory,
      roots,
      title: options.title,
      visibility: options.visibility,
      filterFingerprint: createHash("sha256")
        .update(canonicalJson([...new Set(options.secrets ?? [])].sort()))
        .digest("hex"),
    };
    const expansion = await prepareImportedFileExpansion(
      journal.directory,
      identity,
      options.expandFamily ?? false,
    );
    await resumeImportedRecording({
      journal,
      sourcePath: options.sourcePath,
      identity: expansion?.original ?? identity,
      requested: options.resumeImport ?? false,
      signal,
    });
    await expansion?.commit();
    const manifestPath = join(journal.directory, "publish.json");
    try {
      const previous = JSON.parse(await readFile(manifestPath, "utf8"));
      if (canonicalJson(previous) !== canonicalJson(identity)) {
        if (
          (!options.expandFamily && !expansion) ||
          !isFileFamilyExpansion(previous, identity)
        )
          throw new Error(
            "Publishing conversion or sharing options changed; explicit reconciliation is required",
          );
        await atomicJson(manifestPath, identity);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.expandFamily)
        throw new Error(
          "Family expansion requires an existing live file publication",
        );
      await atomicJson(manifestPath, identity);
    }
    const cursorPath = join(journal.directory, "native-cursor.json");
    let committedOffset = 0;
    try {
      const cursor = z
        .strictObject({
          offset: z.number().int().nonnegative().safe(),
          prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(JSON.parse(await readFile(cursorPath, "utf8")));
      for await (const _ of readJsonlSource(options.sourcePath, {
        after: cursor,
        through: cursor.offset,
        signal,
      })) {
        /* Prefix validation only. */
      }
      committedOffset = cursor.offset;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!journal.identity.sharingEnabled)
      throw new Error("Publishing is paused");
    const network = new PublisherNetwork({
      journal,
      ownerCredential: options.ownerCredential,
      title: options.title,
      visibility: options.visibility,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    });
    running = network.run(signal).catch((error) => {
      networkFailure = error;
      controller.abort(error);
    });
    while (!journal.identity.streamId) await delay(25, signal);
    options.onReady?.({
      streamId: journal.identity.streamId!,
      revision: journal.identity.revision!,
    });
    const secrets = [
      ...(options.secrets ?? []),
      options.ownerCredential,
      journal.identity.writeSecret,
    ];
    artifacts = await localArtifactResolver({
      ...(options.artifactBundles ? { artifactBundles: true } : {}),
      ...(options.remoteArtifacts
        ? { remoteArtifacts: options.remoteArtifacts }
        : {}),
      directory: join(journal.directory, "artifacts"),
      roots,
      baseDirectory,
      secrets,
      serverOrigin: journal.identity.serverOrigin,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal,
    });
    await adapter.follow({
      sourcePath: options.sourcePath,
      journal,
      signal,
      secrets,
      artifacts,
      onCaughtUp: async () => {
        await options.onCaughtUp?.({ producerEvents: journal.capturedThrough });
      },
      onRecordCommitted: async (cursor) => {
        if (cursor.offset > committedOffset) {
          await atomicJson(cursorPath, cursor);
          committedOffset = cursor.offset;
        }
        options.onProgress?.({
          sourceCursor: { ...cursor },
          producerEvents: journal.capturedThrough,
        });
      },
    });
  } catch (error) {
    if (networkFailure) throw networkFailure;
    if (!options.signal.aborted) throw error;
  } finally {
    controller.abort();
    await running;
    try {
      await artifacts?.close();
    } finally {
      await journal.close();
    }
  }
}
