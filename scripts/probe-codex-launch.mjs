#!/usr/bin/env node
/** Creates a named empty native thread; never starts a model turn or publishes. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSession } from "../packages/cli/dist/create-codex.js";
import { StdioRpc } from "../packages/adapters/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-codex-launch-"));
let rpc;
try {
  const created = await createCodexSession({
    cwd: root,
    stateDir: root,
    serverOrigin: "http://127.0.0.1:7331",
    signal: AbortSignal.timeout(30000),
    title: "AgentLive empty launch verification",
  });
  const saved = JSON.parse(
    await readFile(
      join(root, "launches", `${created.nativeSessionId}.json`),
      "utf8",
    ),
  );
  assert.equal(saved.nativeSessionId, created.nativeSessionId);
  rpc = new StdioRpc({
    command: "codex",
    args: ["app-server"],
    cwd: root,
    onNotification: async () => {},
  });
  await rpc.call("initialize", {
    clientInfo: { name: "agentlive_launch_verification", version: "0.1.0" },
  });
  rpc.notify("initialized");
  const { thread } = await rpc.call("thread/resume", {
    threadId: created.nativeSessionId,
  });
  assert.equal(thread.id, created.nativeSessionId);
  assert.equal(thread.turns.length, 0);
  console.log(
    JSON.stringify({
      durableIdentity: true,
      separateProcessResume: true,
      modelTurns: 0,
      published: false,
    }),
  );
} finally {
  await rpc?.close();
  await rm(root, { recursive: true, force: true });
}
