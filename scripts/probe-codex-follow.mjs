#!/usr/bin/env node
/** Read-only retained-history attachment and publisher restart; no source writes or publication. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectCodexHistory,
  followCodexHistory,
} from "../packages/adapters/dist/index.js";
import { PublisherJournal } from "../packages/publisher/dist/index.js";
const sourcePath = process.argv[2];
if (!sourcePath)
  throw new Error("Usage: probe-codex-follow.mjs <native-session.jsonl>");
const manifest = await inspectCodexHistory(sourcePath, undefined, "defer");
const root = await mkdtemp(join(tmpdir(), "agentlive-native-follow-"));
let first;
for (let attempt = 0; attempt < 2; attempt++) {
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "http://localhost:7331",
    agent: "codex",
    nativeSessionId: manifest.nativeSessionId,
  });
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("Native follow probe timed out")),
    120000,
  );
  try {
    await journal.bindRemote("local_probe", "local_revision");
    await followCodexHistory({
      sourcePath,
      journal,
      signal: controller.signal,
      recordFormat: manifest.structuredItems ? "structured" : "legacy",
      onCaughtUp: async () => controller.abort(),
    });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(deadline);
    await journal.close();
  }
  if (attempt === 0) first = journal.capturedThrough;
  else if (journal.capturedThrough !== first)
    throw new Error("Restart changed captured event prefix");
}
console.log(
  JSON.stringify({
    success: true,
    sourceRecords: manifest.records,
    producerEvents: first,
    restartDeduplicated: true,
    sourceModified: false,
    published: false,
  }),
);
