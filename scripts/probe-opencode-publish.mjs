#!/usr/bin/env node
/** Real native server restart and offline-history catch-up using supported OpenCode APIs. */
import { spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { publishOpenCodeRecording } from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import { initialState, apply } from "../packages/playback/dist/index.js";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-opencode-live-")),
);
const password = randomBytes(32).toString("hex");
const allocator = createServer();
await new Promise((resolve) => allocator.listen(0, "127.0.0.1", resolve));
const port = allocator.address().port;
await new Promise((resolve) => allocator.close(resolve));
const nativeOrigin = `http://127.0.0.1:${port}`;
const signal = AbortSignal.timeout(180000);
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const headers = {
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  "content-type": "application/json",
};
let child;
let exited;
let ended;
async function stopNative() {
  if (!child || ended) return;
  const kill = (name) => {
    try {
      process.platform === "win32"
        ? child.kill(name)
        : process.kill(-child.pid, name);
    } catch {}
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function startNative() {
  ended = false;
  child = spawn(
    "opencode",
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      ended = true;
      resolve(code);
    });
    child.once("error", (error) => {
      ended = true;
      reject(error);
    });
  });
  void exited.catch(() => {});
  while (true) {
    signal.throwIfAborted();
    if (ended) {
      await exited;
      throw new Error("OpenCode server exited during startup");
    }
    try {
      const response = await fetch(nativeOrigin + "/global/health", {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      signal.throwIfAborted();
    }
    await pause();
  }
}
async function native(path, body) {
  const response = await fetch(nativeOrigin + path, {
    headers,
    signal,
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenCode native request failed (${response.status})`);
  }
  return response.json();
}
const target = await startServer({
  directory: join(root, "server"),
  ownerSecret: password,
  port: 0,
});
let streamId;
let captured = 0;
let failure;
let publisherAbort;
let publishing;
const model = process.env.AGENTLIVE_PROBE_MODEL ?? "anthropic/claude-sonnet-5";
const slash = model.indexOf("/");
let nativeId;
async function prompt(marker) {
  const result = await native(`/session/${nativeId}/message`, {
    model: {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    },
    parts: [
      {
        type: "text",
        text: `This is a synthetic transport test. Do not use tools or read files. Write one sentence about rain and end with ${marker}.`,
      },
    ],
  });
  if (
    result.info?.error ||
    !result.parts?.some(
      (part) => part.type === "text" && part.text.includes(marker),
    )
  )
    throw new Error("Native OpenCode did not complete the expected turn");
}
function attach() {
  captured = 0;
  publisherAbort = new AbortController();
  publishing = publishOpenCodeRecording({
    publisherRoot: join(root, "publisher"),
    serverOrigin: target.url,
    ownerCredential: password,
    nativeServerOrigin: nativeOrigin,
    nativeSessionId: nativeId,
    nativePassword: password,
    title: "Synthetic OpenCode publishing",
    visibility: "private",
    signal: AbortSignal.any([signal, publisherAbort.signal]),
    onReady: (recording) => {
      if (streamId && streamId !== recording.streamId)
        throw new Error("Publisher recording changed");
      streamId = recording.streamId;
    },
    onCaptured: (boundary) => {
      captured = boundary.producerEvents;
    },
  }).catch((error) => {
    failure = error;
  });
}
async function until(marker) {
  while (true) {
    signal.throwIfAborted();
    if (failure) throw failure;
    if (streamId && captured) {
      const session = await target.store.get(streamId);
      let state = initialState();
      let through = 0;
      for await (const event of session.history(0, session.boundary.sequence)) {
        state = apply(state, event);
        if (event.origin.type === "publisher")
          through = event.origin.event.producerSeq;
      }
      if (
        through >= captured &&
        [...state.messages.values()].some(
          (message) =>
            message.role === "assistant" &&
            message.completed &&
            message.text.includes(marker),
        )
      )
        return session.boundary.sequence;
    }
    await pause();
  }
}
async function detach() {
  publisherAbort?.abort();
  await publishing;
  if (failure) throw failure;
}
try {
  await startNative();
  nativeId = (
    await native("/session", { title: "Synthetic AgentLive resume probe" })
  ).id;
  await prompt("AGENTLIVE_INITIAL_OK");
  attach();
  await until("AGENTLIVE_INITIAL_OK");
  await stopNative();
  await startNative();
  await prompt("AGENTLIVE_RESUMED_OK");
  await until("AGENTLIVE_RESUMED_OK");
  await detach();
  await prompt("AGENTLIVE_DETACHED_OK");
  attach();
  const baseline = await until("AGENTLIVE_DETACHED_OK");
  await detach();
  attach();
  const final = await until("AGENTLIVE_DETACHED_OK");
  if (final !== baseline)
    throw new Error("Publisher restart duplicated retained history");
  console.log(
    JSON.stringify({
      success: true,
      nativeTurns: 3,
      nativeServerRestart: true,
      sameNativeSession: true,
      detachedHistoryRecovered: true,
      publisherRestartDeduplicated: true,
      storedEvents: final,
    }),
  );
} finally {
  publisherAbort?.abort();
  await publishing;
  await stopNative();
  await target.close();
}
