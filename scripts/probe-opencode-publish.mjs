#!/usr/bin/env node
import { PublisherJournal } from "../packages/publisher/dist/index.js";
/** Real native server restart and offline-history catch-up using supported OpenCode APIs. */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  publishOpenCodeRecording,
  importOpenCodeRecording,
} from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import {
  initialState,
  apply,
  PlaybackPacer,
  renderTerminalSnapshot,
} from "../packages/playback/dist/index.js";
import { watchRecording } from "../packages/cli/dist/watch.js";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-opencode-live-")),
);
const resumeImport = process.argv.includes("--resume-import");
const importSource = join(root, "native-export.json");
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
  maxCachedSessions: 1,
});
let streamId;
let captured = 0;
let failure;
let publisherAbort;
let publishing;
const model = process.env.AGENTLIVE_PROBE_MODEL ?? "anthropic/claude-sonnet-5";
const slash = model.indexOf("/");
let nativeId;
async function prompt(marker, attachFile = false) {
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
      ...(attachFile
        ? [
            {
              type: "file",
              mime: "text/plain",
              filename: "probe.txt",
              url: `data:text/plain;charset=utf-8,${encodeURIComponent("Synthetic attachment probe-private-key")}`,
            },
          ]
        : []),
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
    ...(resumeImport ? { sourcePath: importSource, resumeImport: true } : {}),
    publisherRoot: join(root, "publisher"),
    serverOrigin: target.url,
    ownerCredential: password,
    nativeServerOrigin: nativeOrigin,
    nativeSessionId: nativeId,
    nativePassword: password,
    secrets: ["probe-private-key"],
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
  await prompt("AGENTLIVE_INITIAL_OK", true);
  if (resumeImport) {
    await writeFile(
      importSource,
      JSON.stringify({
        info: await native(`/session/${nativeId}`),
        messages: await native(`/session/${nativeId}/message`),
      }),
    );
    const imported = await importOpenCodeRecording({
      sourcePath: importSource,
      publisherRoot: join(root, "publisher"),
      serverOrigin: target.url,
      ownerCredential: password,
      title: "Synthetic OpenCode publishing",
      visibility: "private",
      secrets: ["probe-private-key"],
      artifactRoots: [],
      signal,
    });
    streamId = imported.streamId;
  }
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
  const legacyJournal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: target.url,
    agent: "opencode",
    nativeSessionId: nativeId,
  });
  const manifestPath = join(legacyJournal.directory, "publish.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.converterVersion = "opencode-live-1";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await legacyJournal.close();
  attach();
  const final = await until("AGENTLIVE_DETACHED_OK");
  if (
    JSON.parse(await readFile(manifestPath, "utf8")).converterVersion !==
    "opencode-live-2"
  )
    throw new Error("Live converter migration did not commit");
  if (final !== baseline)
    throw new Error("Publisher restart duplicated retained history");
  const recording = await target.store.get(streamId);
  let replay = initialState();
  for await (const event of recording.history(0, recording.boundary.sequence))
    replay = apply(replay, event);
  let verifiedAttachments = 0;
  for (const artifact of replay.artifacts.values())
    for (const attachment of artifact.versions.values()) {
      const response = await fetch(
        `${target.url}/api/v1/streams/${streamId}/attachments/${attachment.hash}`,
        { headers: { authorization: `Bearer ${password}` }, signal },
      );
      if (!response.ok)
        throw new Error("Published native attachment cannot be downloaded");
      const text = await response.text();
      if (!text.includes("[REDACTED]") || text.includes("probe-private-key"))
        throw new Error("Native attachment filtering failed");
      verifiedAttachments++;
    }
  if (!verifiedAttachments)
    throw new Error("Native file input was not captured as an attachment");
  const gate = new PlaybackPacer();
  gate.setPaused(true);
  const watched = new AbortController();
  let received = 0;
  let presented = 0;
  await watchRecording({
    serverOrigin: target.url,
    streamId,
    credential: password,
    cacheRoot: join(root, "subscriber"),
    signal: AbortSignal.any([signal, watched.signal]),
    presentation: gate,
    speed: 1024,
    resumeView: true,
    write: async () => {},
    onReceipt: (sequence) => {
      received = sequence;
      if (presented !== 0)
        throw new Error(
          "Paused native viewer advanced before receipt finished",
        );
      if (sequence === final) gate.setPaused(false);
    },
    onPresented: (sequence) => {
      if (sequence !== presented + 1)
        throw new Error("Native viewer presentation sequence changed");
      presented = sequence;
      if (sequence === final) watched.abort();
    },
  });
  if (received !== final || presented !== final)
    throw new Error(
      "Native viewer did not receive and present the complete recording",
    );
  const expectedSnapshot = [
    ...renderTerminalSnapshot(replay, target.url, streamId),
  ].join("");
  const resumedViewer = new AbortController();
  let restoredOutput = "";
  let repeatedEvents = 0;
  await watchRecording({
    serverOrigin: target.url,
    streamId,
    credential: password,
    cacheRoot: join(root, "subscriber"),
    resumeView: true,
    signal: AbortSignal.any([signal, resumedViewer.signal]),
    write: async (text) => {
      restoredOutput += text;
      if (restoredOutput.length >= expectedSnapshot.length)
        resumedViewer.abort();
    },
    onPresented: () => {
      repeatedEvents++;
    },
  });
  if (restoredOutput !== expectedSnapshot || repeatedEvents)
    throw new Error(
      "Native viewer restart did not reconstruct exactly its saved presentation state",
    );
  console.log(
    JSON.stringify({
      success: true,
      restoredViewerPosition: true,
      sessionCacheCapacity: 1,
      pausedViewerReceipt: true,
      orderedViewerCatchup: true,
      nativeTurns: 3,
      nativeServerRestart: true,
      sameNativeSession: true,
      detachedHistoryRecovered: true,
      publisherRestartDeduplicated: true,
      liveConverterMigration: true,
      resumedSnapshotImport: resumeImport,
      storedEvents: final,
      verifiedAttachments,
    }),
  );
} finally {
  publisherAbort?.abort();
  await publishing;
  await stopNative();
  await target.close();
}
