#!/usr/bin/env node
/** Explicit live integration: two tool-free native Claude turns in a new synthetic workspace. */
import { verifyBrowserSession } from "./verify-browser-session.mjs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import {
  publishClaudeRecording,
  importClaudeRecording,
  inspectClaudeHistory,
} from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import { initialState, apply } from "../packages/playback/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-claude-live-"));
const resumeImport = process.argv.includes("--resume-import");
const nativeId = randomUUID();
const ownerCredential = randomBytes(32).toString("hex");
const signal = AbortSignal.timeout(180000);
async function native(resume) {
  const marker = resume ? "AGENTLIVE_RESUMED_OK" : "AGENTLIVE_INITIAL_OK";
  const child = spawn(
    "claude",
    [
      "-p",
      `This is a synthetic transport test. Do not use tools or inspect files. Write one short sentence about rain and end with ${marker}.`,
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      resume ? "--resume" : "--session-id",
      nativeId,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let failure;
  child.stdout.on("data", (chunk) => {
    if (output.length + chunk.length > 2 * 1024 * 1024) {
      failure = new Error("Native output limit exceeded");
      child.kill();
    } else output += chunk.toString();
  });
  child.stderr.resume();
  const abort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    signal.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        `Native Claude failed with exit code ${code}; inspect local authentication/provider availability`,
      );
    const result = JSON.parse(output);
    if (
      result.is_error ||
      result.session_id !== nativeId ||
      typeof result.result !== "string" ||
      !result.result.includes(marker)
    )
      throw new Error(
        "Native Claude did not complete the expected session turn",
      );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
await native(false);
let sourcePath;
const projects = join(homedir(), ".claude/projects");
for (const entry of await readdir(projects, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const candidate = join(projects, entry.name, nativeId + ".jsonl");
  if (
    await stat(candidate).then(
      (info) => info.isFile(),
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    )
  ) {
    sourcePath = candidate;
    break;
  }
}
if (!sourcePath) throw new Error("Native Claude history was not found");
const server = await startServer({
  directory: join(root, "server"),
  ownerSecret: ownerCredential,
  port: 0,
});
let streamId;
let baseline;
try {
  if (resumeImport) {
    const imported = await importClaudeRecording({
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Synthetic Claude live integration",
      visibility: "private",
      signal,
    });
    streamId = imported.streamId;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let caughtUp = false;
    let captured = 0;
    let sourceOffset = 0;
    let failure;
    const running = publishClaudeRecording({
      sourcePath,
      resumeImport,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Synthetic Claude live integration",
      visibility: "private",
      signal: AbortSignal.any([signal, controller.signal]),
      onProgress: (progress) => {
        sourceOffset = progress.sourceCursor.offset;
        captured = progress.producerEvents;
      },
      onReady: (recording) => {
        if (streamId && streamId !== recording.streamId)
          throw new Error("Publisher restart changed recording");
        streamId = recording.streamId;
      },
      onCaughtUp: async (boundary) => {
        captured = boundary.producerEvents;
        caughtUp = true;
      },
    }).catch((error) => {
      failure = error;
    });
    try {
      while (!caughtUp) {
        signal.throwIfAborted();
        if (failure) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!attempt) await native(true);
      const boundary = (await inspectClaudeHistory(sourcePath, signal, "defer"))
        .boundary.offset;
      while (true) {
        signal.throwIfAborted();
        if (failure) throw failure;
        const session = await server.store.get(streamId);
        let state = initialState();
        let through = 0;
        for await (const event of session.history(
          0,
          session.boundary.sequence,
        )) {
          state = apply(state, event);
          if (event.origin.type === "publisher")
            through = event.origin.event.producerSeq;
        }
        const texts = [...state.messages.values()]
          .filter((message) => message.role === "assistant")
          .map((message) => message.text);
        if (
          sourceOffset >= boundary &&
          through >= captured &&
          texts.some((text) => text.includes("AGENTLIVE_INITIAL_OK")) &&
          texts.some((text) => text.includes("AGENTLIVE_RESUMED_OK"))
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      controller.abort();
      await running;
    }
    if (failure) throw failure;
    const count = (await server.store.get(streamId)).boundary.sequence;
    if (!attempt) baseline = count;
    else if (count !== baseline)
      throw new Error("Restart changed event prefix");
  }
  const browserModel = await verifyBrowserSession(
    server.url,
    streamId,
    ownerCredential,
    signal,
  );
  console.log(
    JSON.stringify({
      success: true,
      browserModel,
      nativeTurns: 2,
      importedThenResumed: resumeImport,
      nativeResume: true,
      historyBackfilled: true,
      liveSuffixCaptured: true,
      publisherRestartDeduplicated: true,
      storedEvents: baseline,
    }),
  );
} finally {
  await server.close();
}

if (process.argv.includes("--package")) {
  const result = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./probe-package.mjs", import.meta.url)),
      sourcePath,
      "claude",
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
}
