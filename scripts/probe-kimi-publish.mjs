#!/usr/bin/env node
import { promisify } from "node:util";
/** Explicit live integration: two tool-free native Kimi turns in a new synthetic workspace. */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  publishKimiRecording,
  inspectKimiHistory,
} from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import { initialState, apply } from "../packages/playback/dist/index.js";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-kimi-live-")),
);
let nativeId;
const ownerCredential = randomBytes(32).toString("hex");
const signal = AbortSignal.timeout(180000);
async function native(resume) {
  const marker = resume ? "AGENTLIVE_RESUMED_OK" : "AGENTLIVE_INITIAL_OK";
  const child = spawn(
    "kimi",
    [
      "-p",
      `This is a synthetic transport test. Do not use tools or inspect files. Write one short sentence about rain and end with ${marker}.`,
      "--output-format",
      "stream-json",
      ...(resume ? ["--session", nativeId] : []),
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
        `Native Kimi failed with exit code ${code}; inspect local authentication/provider availability`,
      );
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      !events.some(
        (event) =>
          event.role === "assistant" &&
          JSON.stringify(event.content).includes(marker),
      )
    )
      throw new Error("Native Kimi did not complete the expected session turn");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
await native(false);
const { stdout } = await promisify(execFile)(
  "kimi",
  ["session", "list", "--cwd", root, "--json"],
  { maxBuffer: 1024 * 1024 },
);
const sessions = JSON.parse(stdout);
if (
  !Array.isArray(sessions) ||
  sessions.length !== 1 ||
  typeof sessions[0].id !== "string" ||
  typeof sessions[0].sessionDir !== "string"
)
  throw new Error("Synthetic native session identity was ambiguous");
nativeId = sessions[0].id;
const sourcePath = join(sessions[0].sessionDir, "agents", "main", "wire.jsonl");
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
    let caughtUp = false;
    let captured = 0;
    let sourceOffset = 0;
    let failure;
    const running = publishKimiRecording({
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Synthetic Kimi live integration",
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
      const boundary = (
        await inspectKimiHistory(sourcePath, signal, undefined, "defer")
      ).boundary.offset;
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
  console.log(
    JSON.stringify({
      success: true,
      nativeTurns: 2,
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
