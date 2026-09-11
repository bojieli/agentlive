#!/usr/bin/env node
/** Read-only metadata-selected child conversion; no transcript content is printed or published. */
import { readdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  inspectCodexHistory,
  createCodexHistoryConsumer,
} from "../packages/adapters/dist/codex-history.js";
import { CodexCapture } from "../packages/adapters/dist/codex.js";
import { readJsonlSource } from "../packages/adapters/dist/jsonl.js";
import { contentSchema } from "../packages/protocol/dist/index.js";
async function* files(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* files(join(root, entry.name));
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      yield join(root, entry.name);
  }
}
let checked = 0,
  events = 0,
  inheritedMetadata = 0;
for await (const path of files(
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
)) {
  const file = await open(path, "r");
  let metadata;
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) continue;
    const row = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    if (row.type === "session_meta") metadata = row.payload;
  } finally {
    await file.close();
  }
  if (!metadata?.parent_thread_id) continue;
  const manifest = await inspectCodexHistory(path);
  if (manifest.nativeThreadIds.length < 2) continue;
  const sink = {
    identity: {
      nativeAgent: "codex",
      nativeSessionId: manifest.nativeSessionId,
    },
    capturedThrough: 0,
    capture: async ({ content }) => {
      for (const event of content) {
        contentSchema.parse(event);
        if (event.kind === "session.started")
          throw new Error("Child emitted a recording start");
        events++;
        sink.capturedThrough++;
      }
      return [];
    },
  };
  const capture = new CodexCapture(
    sink,
    [],
    manifest.createdAt,
    undefined,
    metadata.id,
  );
  const consumer = await createCodexHistoryConsumer(manifest, capture, {
    childThreadId: metadata.id,
  });
  for await (const record of readJsonlSource(path, {
    through: manifest.boundary.offset,
    tail: "parse",
  }))
    await consumer.accept(record);
  inheritedMetadata += manifest.nativeThreadIds.length - 1;
  if (++checked === 4) break;
}
if (!checked) throw new Error("No native child rollouts found");
console.log(
  JSON.stringify({ checked, events, inheritedMetadata, published: false }),
);
