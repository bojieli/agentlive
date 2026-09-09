#!/usr/bin/env node
/** Read-only native backfill through the real publishing transport, followed by restart. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  inspectCodexHistory,
  publishCodexRecording,
} from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
const sourcePath = process.argv[2];
if (!sourcePath)
  throw new Error("Usage: probe-codex-publish.mjs <native-session.jsonl>");
const manifest = await inspectCodexHistory(sourcePath, undefined, "defer");
const root = await mkdtemp(join(tmpdir(), "agentlive-publish-probe-"));
const ownerCredential = randomBytes(32).toString("hex");
const server = await startServer({
  directory: join(root, "server"),
  ownerSecret: ownerCredential,
  port: 0,
});
let streamId;
let baseline;
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120000),
    ]);
    let caughtUp = false;
    let producerEvents = 0;
    let failure;
    const running = publishCodexRecording({
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Private publishing probe",
      visibility: "private",
      signal,
      recordFormat: manifest.structuredItems ? "structured" : "legacy",
      onReady: (recording) => {
        if (streamId && streamId !== recording.streamId)
          throw new Error("Recording changed on restart");
        streamId = recording.streamId;
      },
      onCaughtUp: async (boundary) => {
        producerEvents = boundary.producerEvents;
        caughtUp = true;
      },
    }).catch((error) => {
      failure = error;
    });
    try {
      while (true) {
        if (caughtUp) {
          const session = await server.store.get(streamId);
          let through = 0;
          for await (const event of session.history(
            0,
            session.boundary.sequence,
          )) {
            if (event.origin.type === "publisher")
              through = Math.max(through, event.origin.event.producerSeq);
          }
          if (through >= producerEvents) break;
        }
        signal.throwIfAborted();
        if (failure) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      controller.abort();
      await running;
    }
    if (failure) throw failure;
    const session = await server.store.get(streamId);
    if (attempt === 0) baseline = session.boundary.sequence;
    else if (session.boundary.sequence !== baseline)
      throw new Error("Restart duplicated events");
  }
  if ((await fetch(`${server.url}/api/v1/streams/${streamId}`)).status !== 403)
    throw new Error("Recording was exposed anonymously");
  console.log(
    JSON.stringify({
      success: true,
      sourceRecords: manifest.records,
      storedEvents: baseline,
      restartDeduplicated: true,
      sourceModified: false,
      privateRecording: true,
    }),
  );
} finally {
  await server.close();
}
