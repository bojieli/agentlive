#!/usr/bin/env node
/** Opt-in synthetic real-Codex test of capture, publishing, live receipt, and replay. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { StdioRpc, CodexCapture } from "../packages/adapters/dist/index.js";
import {
  PublisherJournal,
  PublisherNetwork,
} from "../packages/publisher/dist/index.js";
import { SubscriberClient } from "../packages/client/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import { initialState, apply } from "../packages/playback/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-codex-pipeline-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(
  join(workspace, "README.md"),
  "Synthetic fixture: otters count seven pebbles.\n",
);
const output = resolve(
  "probe-results",
  `codex-pipeline-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
const ownerSecret = randomBytes(32).toString("hex");
const server = await startServer({
  directory: join(root, "server"),
  ownerSecret,
  port: 0,
});
const abort = new AbortController();
const deadline = setTimeout(
  () => abort.abort(new Error("Live pipeline deadline exceeded")),
  120_000,
);
let capture,
  journal,
  publisherRun,
  subscriberRun,
  completed = false,
  failure;
const types = {};
let state = initialState();
const createRpc = () =>
  new StdioRpc({
    command: "codex",
    args: ["app-server", "--stdio"],
    cwd: workspace,
    onNotification: async (notification) => {
      types[notification.method] = (types[notification.method] ?? 0) + 1;
      if (capture) await capture.accept(notification);
      if (notification.method === "turn/completed") {
        completed = true;
        if (notification.params.turn.status !== "completed")
          failure = new Error("Codex turn did not complete successfully");
      }
    },
  });
let rpc = createRpc();
try {
  await rpc.call("initialize", {
    clientInfo: { name: "agentlive_pipeline", version: "0.1.0" },
  });
  rpc.notify("initialized");
  const started = await rpc.call("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  journal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: server.url,
    agent: "codex",
    nativeSessionId: started.thread.id,
  });
  const network = new PublisherNetwork({
    journal,
    ownerCredential: ownerSecret,
    title: "Synthetic Codex pipeline",
    visibility: "public",
  });
  await network.ensureRemote(abort.signal);
  const secrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) &&
        value &&
        value.length >= 8 &&
        value.length <= 4096,
    )
    .map(([, value]) => value);
  capture = new CodexCapture(journal, [
    ...secrets,
    ownerSecret,
    journal.identity.writeSecret,
  ]);
  await capture.begin();
  publisherRun = network.run(abort.signal);
  void publisherRun.catch((error) => {
    failure = error;
  });
  const subscriber = new SubscriberClient({
    serverOrigin: server.url,
    cursor: {
      streamId: journal.identity.streamId,
      revision: journal.identity.revision,
      serverSeq: 0,
    },
    commit: async (events) => {
      for (const event of events) state = apply(state, event);
    },
  });
  subscriberRun = subscriber.run(abort.signal);
  void subscriberRun.catch((error) => {
    failure = error;
  });
  await rpc.call("turn/start", {
    threadId: started.thread.id,
    input: [
      {
        type: "text",
        text: "Use a read-only shell command to read README.md in this synthetic directory. Do not modify files. Then write two short paragraphs explaining the fixture, ending your final answer with PIPELINE_OK_7391.",
      },
    ],
  });
  const captureFailure = rpc.captureFailure.then((error) => {
    failure = error;
  });
  void captureFailure;
  while (!completed) {
    abort.signal.throwIfAborted();
    if (failure) throw failure;
    await delay(50);
  }
  await rpc.drain();
  if (failure) throw failure;
  while (
    journal.identity.acknowledgedSeq < journal.capturedThrough ||
    state.appliedSeq <
      (await server.store.get(journal.identity.streamId)).boundary.sequence
  ) {
    abort.signal.throwIfAborted();
    if (failure) throw failure;
    await delay(50);
  }
  const assistant = [...state.messages.values()]
    .filter((x) => x.role === "assistant" && x.completed)
    .map((x) => x.text)
    .join("\n");
  if (!assistant.includes("PIPELINE_OK_7391"))
    throw new Error("Final assistant marker is absent from replay state");
  if (
    ![...state.tools.values()].some(
      (x) => x.status === "completed" && x.output.includes("seven pebbles"),
    )
  )
    throw new Error(
      "Completed read-only tool output is absent from replay state",
    );
  const beforeResume = journal.capturedThrough;
  await rpc.close();
  capture = new CodexCapture(journal, [
    ...secrets,
    ownerSecret,
    journal.identity.writeSecret,
  ]);
  rpc = createRpc();
  void rpc.captureFailure.then((error) => {
    failure = error;
  });
  await rpc.call("initialize", {
    clientInfo: { name: "agentlive_pipeline", version: "0.1.0" },
  });
  rpc.notify("initialized");
  const resumed = await rpc.call("thread/resume", {
    threadId: started.thread.id,
    excludeTurns: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  if (resumed.thread.id !== started.thread.id)
    throw new Error("Native resume changed thread identity");
  let cursor;
  do {
    const page = await rpc.call("thread/turns/list", {
      threadId: started.thread.id,
      limit: 20,
      sortDirection: "asc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    for (const turn of page.data) await capture.recoverCompletedTurn(turn);
    cursor = page.nextCursor;
  } while (cursor);
  await rpc.drain();
  if (journal.capturedThrough !== beforeResume)
    throw new Error(
      "Completed source history duplicated events during native resume",
    );
  completed = false;
  await rpc.call("turn/start", {
    threadId: started.thread.id,
    input: [
      {
        type: "text",
        text: "Without using tools, recall the fixture you read in the previous turn. Reply with its animal and number, followed by RESUMED_OK_7391.",
      },
    ],
  });
  while (!completed) {
    abort.signal.throwIfAborted();
    if (failure) throw failure;
    await delay(50);
  }
  await rpc.drain();
  while (
    journal.identity.acknowledgedSeq < journal.capturedThrough ||
    state.appliedSeq <
      (await server.store.get(journal.identity.streamId)).boundary.sequence
  ) {
    abort.signal.throwIfAborted();
    if (failure) throw failure;
    await delay(50);
  }
  const resumedText = [...state.messages.values()]
    .filter((x) => x.role === "assistant" && x.completed)
    .map((x) => x.text)
    .join("\n");
  if (!resumedText.includes("RESUMED_OK_7391"))
    throw new Error("Resumed assistant output is absent");
  const session = await server.store.get(journal.identity.streamId);
  let replay = initialState();
  for await (const event of session.history(0, session.boundary.sequence))
    replay = apply(replay, event);
  if (
    JSON.stringify([...state.messages]) !==
      JSON.stringify([...replay.messages]) ||
    JSON.stringify([...state.tools]) !== JSON.stringify([...replay.tools])
  )
    throw new Error("Live state differs from replay state");
  const summary = {
    success: true,
    agent: "codex",
    producerEvents: journal.capturedThrough,
    serverEvents: state.appliedSeq,
    assistantMessages: [...state.messages.values()].filter(
      (x) => x.role === "assistant",
    ).length,
    tools: state.tools.size,
    textDeltas: types["item/agentMessage/delta"] ?? 0,
    toolDeltas: types["item/commandExecution/outputDelta"] ?? 0,
    replayMatches: true,
    nativeResumeMatches: true,
    resumeDidNotDuplicateHistory: true,
    gaps: state.gaps.length,
  };
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  clearTimeout(deadline);
  abort.abort();
  await Promise.allSettled([publisherRun, subscriberRun]);
  await rpc.close();
  await journal?.close();
  await server.close();
}
