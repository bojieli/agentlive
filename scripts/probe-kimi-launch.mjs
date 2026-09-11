#!/usr/bin/env node
/** Creates an empty native Kimi session; never prompts or publishes. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createKimiSession } from "../packages/cli/dist/create-kimi.js";
import { StdioRpc } from "../packages/adapters/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-launch-"));
let rpc;
try {
  const created = await createKimiSession({
    cwd: root,
    stateDir: root,
    sourceRoot: join(homedir(), ".kimi-code", "sessions"),
    serverOrigin: "http://127.0.0.1:7331",
    signal: AbortSignal.timeout(15000),
  });
  const saved = JSON.parse(
    await readFile(
      join(root, "launches", `${created.nativeSessionId}.json`),
      "utf8",
    ),
  );
  assert.equal(saved.nativeProtocolId, created.nativeProtocolId);
  assert.equal(created.nativeProtocolId, `session_${created.nativeSessionId}`);
  const rows = (await readFile(created.sourcePath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(rows.some((row) => row.type === "metadata"));
  assert.ok(!rows.some((row) => row.type === "context.append_message"));
  rpc = new StdioRpc({
    command: "kimi",
    args: ["acp"],
    cwd: root,
    onNotification: async () => {},
  });
  await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const list = await rpc.call("session/list", { cwd: root });
  assert.ok(
    list.sessions.some(
      (session) => session.sessionId === created.nativeProtocolId,
    ),
  );
  console.log(
    JSON.stringify({
      durableIdentity: true,
      mainWireLog: true,
      separateProcessListing: true,
      modelTurns: 0,
      published: false,
    }),
  );
} finally {
  await rpc?.close();
  await rm(root, { recursive: true, force: true });
}
