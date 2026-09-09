#!/usr/bin/env node
/** Read-only local corpus inventory. Emits structural counts, never transcript contents. */
import { readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readJsonlSource } from "../packages/adapters/dist/index.js";
const roots = {
  claude: join(homedir(), ".claude", "projects"),
  codex: join(homedir(), ".codex", "sessions"),
  codex_archived: join(homedir(), ".codex", "archived_sessions"),
  kimi: join(homedir(), ".kimi-code", "sessions"),
};
const output = resolve("probe-results", "native-history-inventory");
await mkdir(output, { recursive: true, mode: 0o700 });
const label = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_./-]{1,80}$/.test(value)
    ? value
    : "(other)";
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
const reports = {};
for (const [agent, root] of Object.entries(roots)) {
  const report = {
    files: 0,
    bytes: 0,
    records: 0,
    failedFiles: 0,
    deferredTailFiles: 0,
    maxRecordBytes: 0,
    types: {},
    objectTypes: {},
    sessions: [],
  };
  const count = (map, key) => {
    map[key] = (map[key] ?? 0) + 1;
  };
  for await (const path of files(root)) {
    const info = await stat(path),
      session = {
        id: createHash("sha256").update(path).digest("hex"),
        bytes: info.size,
        records: 0,
        completeOffset: 0,
        status: "parsed",
      };
    report.files++;
    report.bytes += info.size;
    try {
      for await (const record of readJsonlSource(path, {
        maxRecordBytes: 32 * 1024 * 1024,
      })) {
        const value = record.value;
        report.records++;
        session.records++;
        report.maxRecordBytes = Math.max(
          report.maxRecordBytes,
          record.cursor.offset - session.completeOffset,
        );
        session.completeOffset = record.cursor.offset;
        if (!value || typeof value !== "object") continue;
        count(report.types, label(value.type));
        if (value.payload?.type)
          count(report.objectTypes, `payload/${label(value.payload.type)}`);
        if (value.payload?.item?.type)
          count(report.objectTypes, `item/${label(value.payload.item.type)}`);
        for (const part of value.message?.content ?? [])
          if (part && typeof part === "object")
            count(report.objectTypes, `content/${label(part.type)}`);
      }
    } catch {
      session.status = "parse_or_limit_error";
      report.failedFiles++;
    }
    if (session.completeOffset < info.size && session.status === "parsed") {
      session.status = "deferred_tail";
      report.deferredTailFiles++;
    }
    report.sessions.push(session);
  }
  await writeFile(
    join(output, `${agent}.json`),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  const { sessions, ...aggregate } = report;
  reports[agent] = aggregate;
  console.log(JSON.stringify({ agent, ...aggregate }));
}
await writeFile(
  join(output, "summary.json"),
  JSON.stringify(reports, null, 2) + "\n",
  { mode: 0o600 },
);
