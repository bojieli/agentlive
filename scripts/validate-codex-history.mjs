#!/usr/bin/env node
/** Local structural conversion validation of every discoverable Codex history, without publication. */
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  inspectCodexHistory,
  captureCodexHistory,
  CodexCapture,
} from "../packages/adapters/dist/index.js";
import {
  canonicalJson,
  contentSchema,
} from "../packages/protocol/dist/index.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function* files(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}
const output = resolve("probe-results", "codex-history-validation");
await mkdir(output, { recursive: true, mode: 0o700 });
const summary = {
  files: 0,
  converted: 0,
  failed: 0,
  events: 0,
  unsupportedItemTypes: {},
  unsupportedRecordTypes: {},
  failureCategories: {},
};
const results = [];
for (const root of [
  join(homedir(), ".codex", "sessions"),
  join(homedir(), ".codex", "archived_sessions"),
])
  for await (const path of files(root)) {
    const result = { sourceId: hash(path), status: "converted", events: 0 };
    summary.files++;
    try {
      const manifest = await inspectCodexHistory(path);
      const sources = new Map(),
        messages = new Set(),
        tools = new Set();
      const sink = {
        identity: {
          nativeAgent: "codex",
          nativeSessionId: manifest.nativeSessionId,
        },
        capturedThrough: 0,
        capture: async (input) => {
          const digest = hash(canonicalJson(input.content));
          if (sources.has(input.sourceKey)) {
            if (sources.get(input.sourceKey) !== digest)
              throw new Error("conflicting_source_effect");
            return [];
          }
          sources.set(input.sourceKey, digest);
          for (const content of input.content) {
            contentSchema.parse(content);
            if (Buffer.byteLength(canonicalJson(content)) > 250 * 1024)
              throw new Error("normalized_event_needs_chunking");
            const p = content.payload;
            if (content.kind === "message.started") {
              if (messages.has(p.messageId))
                throw new Error("duplicate_message_start");
              messages.add(p.messageId);
            } else if (
              content.kind.startsWith("message.") &&
              !messages.has(p.messageId)
            )
              throw new Error("missing_message_start");
            if (content.kind === "tool.started") {
              if (tools.has(p.toolId)) throw new Error("duplicate_tool_start");
              tools.add(p.toolId);
            } else if (content.kind.startsWith("tool.") && !tools.has(p.toolId))
              throw new Error("missing_tool_start");
            sink.capturedThrough++;
          }
          return [];
        },
      };
      const report = await captureCodexHistory(
        path,
        manifest,
        new CodexCapture(sink, [], manifest.createdAt),
      );
      result.events = sink.capturedThrough;
      result.unsupportedItemTypes = report.unsupportedItemTypes;
      result.unsupportedRecordTypes = report.unsupportedRecordTypes;
      for (const [type, count] of Object.entries(report.unsupportedRecordTypes))
        summary.unsupportedRecordTypes[type] =
          (summary.unsupportedRecordTypes[type] ?? 0) + count;
      summary.events += result.events;
      summary.converted++;
      for (const [type, count] of Object.entries(report.unsupportedItemTypes))
        summary.unsupportedItemTypes[type] =
          (summary.unsupportedItemTypes[type] ?? 0) + count;
    } catch (error) {
      result.status = "failed";
      result.category =
        error.name === "ZodError"
          ? "source_shape_or_event_limit"
          : error.name === "SyntaxError"
            ? "invalid_json"
            : error.message;
      summary.failed++;
      summary.failureCategories[result.category] =
        (summary.failureCategories[result.category] ?? 0) + 1;
    }
    results.push(result);
    if (summary.files % 50 === 0)
      console.log(
        JSON.stringify({
          processed: summary.files,
          converted: summary.converted,
          failed: summary.failed,
        }),
      );
  }
await writeFile(
  join(output, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
  { mode: 0o600 },
);
await writeFile(
  join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(summary));
