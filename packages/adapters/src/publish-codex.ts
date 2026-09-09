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
import { inspectCodexHistory } from "./codex-history.js";
import { followCodexHistory } from "./follow-codex.js";
import { readJsonlSource } from "./jsonl.js";
import { localArtifactResolver } from "./local-artifacts.js";

export interface CodexPublishOptions extends NativeImportOptions {
  recordFormat?: "structured" | "legacy";
  onReady?: (recording: { streamId: string; revision: string }) => void;
  onStatus?: (status: PublisherStatus) => void;
  onCaughtUp?: (boundary: { producerEvents: number }) => Promise<void>;
}
/** Stop detaches this publisher; durable pending events remain for the next attach. */
export async function publishCodexRecording(
  options: CodexPublishOptions,
): Promise<void> {
  const source = await inspectCodexHistory(
    options.sourcePath,
    options.signal,
    "defer",
  );
  const journal = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: options.serverOrigin,
    agent: "codex",
    nativeSessionId: source.nativeSessionId,
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  let running: Promise<void> | undefined;
  let networkFailure: unknown;
  try {
    try {
      await readFile(join(journal.directory, "import.json"));
      throw new Error(
        "This binding is a historical import; reopening imports for live publishing requires explicit migration",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const baseDirectory = resolve(
      options.artifactBaseDirectory ?? dirname(options.sourcePath),
    );
    const roots = (options.artifactRoots ?? [baseDirectory])
      .map((root) => resolve(root))
      .sort();
    const identity = {
      version: 1,
      converterVersion: "codex-history-3",
      recordFormat: options.recordFormat ?? "structured",
      baseDirectory,
      roots,
      title: options.title,
      visibility: options.visibility,
      filterFingerprint: createHash("sha256")
        .update(canonicalJson([...new Set(options.secrets ?? [])].sort()))
        .digest("hex"),
    };
    const manifestPath = join(journal.directory, "publish.json");
    try {
      if (
        canonicalJson(JSON.parse(await readFile(manifestPath, "utf8"))) !==
        canonicalJson(identity)
      )
        throw new Error(
          "Publishing conversion or sharing options changed; explicit reconciliation is required",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      directory: join(journal.directory, "artifacts"),
      roots,
      baseDirectory,
      secrets,
      serverOrigin: journal.identity.serverOrigin,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal,
    });
    await followCodexHistory({
      sourcePath: options.sourcePath,
      journal,
      signal,
      secrets,
      recordFormat: options.recordFormat ?? "structured",
      resolveArtifact: artifacts.resolveArtifact,
      onCaughtUp: async () => {
        await options.onCaughtUp?.({ producerEvents: journal.capturedThrough });
      },
      onRecordCommitted: async (cursor) => {
        if (cursor.offset <= committedOffset) return;
        await atomicJson(cursorPath, cursor);
        committedOffset = cursor.offset;
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
