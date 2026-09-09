import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PublisherJournal, PublisherNetwork } from "@agentlive/publisher";
import { atomicJson } from "@agentlive/storage";
import { request, delay } from "@agentlive/client/transport";
import { canonicalJson, cursorSchema } from "@agentlive/protocol";
import { CodexCapture } from "./codex.js";
import { inspectCodexHistory, captureCodexHistory } from "./codex-history.js";
export interface CodexImportOptions {
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
export async function importCodexRecording(options: CodexImportOptions) {
  const source = await inspectCodexHistory(options.sourcePath, options.signal);
  const journal = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: options.serverOrigin,
    agent: "codex",
    nativeSessionId: source.nativeSessionId,
  });
  try {
    const identity = {
      version: 1,
      converterVersion: "codex-history-1",
      sourcePrefix: source.boundary.prefixHash,
      sourceBytes: source.boundary.offset,
      nativeSessionId: source.nativeSessionId,
      title: options.title,
      visibility: options.visibility,
    };
    const checkpoint = join(journal.directory, "import.json");
    try {
      const previous = JSON.parse(await readFile(checkpoint, "utf8"));
      if (canonicalJson(previous) !== canonicalJson(identity))
        throw new Error(
          "Import source or options changed; explicitly select a new import or resume the existing recording",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicJson(checkpoint, identity);
    }
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
    const capture = new CodexCapture(
      journal,
      [
        ...(options.secrets ?? []),
        options.ownerCredential,
        journal.identity.writeSecret,
      ],
      source.createdAt,
    );
    const report = await captureCodexHistory(
      options.sourcePath,
      source,
      capture,
      options.signal,
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
    await journal.close();
  }
}
