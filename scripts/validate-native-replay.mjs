#!/usr/bin/env node
/** Read-only full-corpus reducer/terminal validation. Persist aggregate counts and hashes only. */
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  inspectCodexHistory,
  captureCodexHistory,
  CodexCapture,
  inspectClaudeHistory,
  captureClaudeHistory,
  inspectKimiHistory,
  captureKimiHistory,
  inspectOpenCodeHistory,
  captureOpenCodeHistory,
} from "../packages/adapters/dist/index.js";
import {
  initialState,
  apply,
  renderTerminalEvent,
  renderTerminalSnapshot,
} from "../packages/playback/dist/index.js";
import {
  canonicalJson,
  contentSchema,
  storedEventSchema,
} from "../packages/protocol/dist/index.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function* files(root, extension) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, extension);
    else if (entry.isFile() && entry.name.endsWith(extension)) yield path;
  }
}
const configurations = [
  {
    agent: "codex",
    roots: [
      join(homedir(), ".codex/sessions"),
      join(homedir(), ".codex/archived_sessions"),
    ],
    extension: ".jsonl",
    inspect: inspectCodexHistory,
    capture: (path, manifest, sink) =>
      captureCodexHistory(
        path,
        manifest,
        new CodexCapture(sink, [], manifest.createdAt),
      ),
  },
  {
    agent: "claude",
    roots: [join(homedir(), ".claude/projects")],
    extension: ".jsonl",
    inspect: inspectClaudeHistory,
    capture: captureClaudeHistory,
  },
  {
    agent: "kimi",
    roots: [join(homedir(), ".kimi-code/sessions")],
    extension: ".jsonl",
    inspect: inspectKimiHistory,
    capture: captureKimiHistory,
  },
  {
    agent: "opencode",
    roots: [resolve("probe-results/native-history-inventory/opencode-exports")],
    extension: ".json",
    inspect: inspectOpenCodeHistory,
    capture: captureOpenCodeHistory,
  },
];
const requested = process.argv.slice(2);
if (
  requested.some(
    (agent) => !configurations.some((config) => config.agent === agent),
  )
)
  throw new Error("Expected agent names: codex claude kimi opencode");
const output = resolve("probe-results/native-replay-validation");
await mkdir(output, { recursive: true, mode: 0o700 });
for (const config of configurations.filter(
  (config) => !requested.length || requested.includes(config.agent),
)) {
  const summary = {
    agent: config.agent,
    files: 0,
    passed: 0,
    failed: 0,
    events: 0,
    renderedBytes: 0,
    snapshotBytes: 0,
    messages: 0,
    tools: 0,
    gaps: 0,
    unavailableArtifacts: 0,
    failureCategories: {},
  };
  const results = [];
  for (const root of config.roots)
    for await (const path of files(root, config.extension)) {
      const result = { sourceId: hash(path), status: "passed" };
      summary.files++;
      try {
        const manifest = await config.inspect(path),
          sources = new Map();
        let state = initialState(),
          renderedBytes = 0;
        const rendering = createHash("sha256");
        const sink = {
          identity: {
            nativeAgent: config.agent,
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
            for (const [index, content] of input.content.entries()) {
              contentSchema.parse(content);
              if (Buffer.byteLength(canonicalJson(content)) > 250 * 1024)
                throw new Error("event_exceeds_publish_budget");
              const event = storedEventSchema.parse({
                protocolVersion: 1,
                serverSeq: ++sink.capturedThrough,
                receivedAt: input.observedAt,
                timelineMs: Math.max(state.timelineMs, input.elapsedMs),
                content,
                origin: {
                  type: "server",
                  operationId: hash(`${input.sourceKey}/${index}`),
                },
              });
              const previous = state;
              state = apply(state, event);
              const text = renderTerminalEvent(
                event,
                state,
                "http://localhost:7331",
                "validation",
                previous,
              );
              if (
                /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
                  text,
                )
              )
                throw new Error("unsafe_terminal_control");
              renderedBytes += Buffer.byteLength(text);
              rendering.update(text);
            }
            return [];
          },
        };
        await config.capture(path, manifest, sink);
        if (state.replacements.size)
          throw new Error("incomplete_text_replacement");
        let snapshotBytes = 0;
        const snapshotHash = createHash("sha256");
        for (const text of renderTerminalSnapshot(
          state,
          "http://localhost:7331",
          "validation",
        )) {
          if (
            /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
              text,
            )
          )
            throw new Error("unsafe_terminal_control");
          snapshotBytes += Buffer.byteLength(text);
          snapshotHash.update(text);
        }
        Object.assign(result, {
          snapshotBytes,
          snapshotHash: snapshotHash.digest("hex"),
          events: sink.capturedThrough,
          renderedBytes,
          renderingHash: rendering.digest("hex"),
          messages: state.messages.size,
          tools: state.tools.size,
          gaps: state.gaps.length,
          unavailableArtifacts: [...state.artifacts.values()].filter(
            (artifact) => artifact.reason !== undefined,
          ).length,
        });
        for (const key of [
          "events",
          "renderedBytes",
          "snapshotBytes",
          "messages",
          "tools",
          "gaps",
          "unavailableArtifacts",
        ])
          summary[key] += result[key];
        summary.passed++;
      } catch (error) {
        result.status = "failed";
        const known = [
          "Claude source lacks session identity or timestamp",
          "conflicting_source_effect",
          "event_exceeds_publish_budget",
          "unsafe_terminal_control",
          "incomplete_text_replacement",
        ];
        result.category =
          typeof error.code === "string"
            ? error.code
            : known.includes(error.message)
              ? error.message
              : (error.name ?? "Error");
        result.issuePaths = error.issues?.map((issue) => ({
          path: issue.path,
          code: issue.code,
        }));
        summary.failed++;
        summary.failureCategories[result.category] =
          (summary.failureCategories[result.category] ?? 0) + 1;
      }
      results.push(result);
      if (summary.files % 100 === 0)
        console.log(
          JSON.stringify({
            agent: config.agent,
            processed: summary.files,
            passed: summary.passed,
            failed: summary.failed,
          }),
        );
    }
  await writeFile(
    join(output, config.agent + ".results.json"),
    JSON.stringify(results, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(output, config.agent + ".summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 1;
}
