import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StdioRpc, CodexCapture } from "../../packages/adapters/src/index.js";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
const roots: string[] = [];
const journals: PublisherJournal[] = [];
const transports: StdioRpc[] = [];
afterEach(async () => {
  for (const rpc of transports.splice(0)) await rpc.close();
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function transport(
  onNotification: ConstructorParameters<typeof StdioRpc>[0]["onNotification"],
  mode = "",
  extra: Partial<ConstructorParameters<typeof StdioRpc>[0]> = {},
) {
  const rpc = new StdioRpc({
    command: process.execPath,
    args: [resolve("tests/fixtures/rpc-process.mjs"), mode],
    cwd: process.cwd(),
    onNotification,
    ...extra,
  });
  transports.push(rpc);
  return rpc;
}
async function setup(secrets: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-adapter-test-"));
  roots.push(root);
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "http://localhost:7331",
    agent: "codex",
    nativeSessionId: "native1",
  });
  journals.push(journal);
  await journal.bindRemote("stream1", "revision1");
  return { journal, capture: new CodexCapture(journal, secrets) };
}
async function contents(journal: PublisherJournal) {
  const events = [];
  for await (const event of journal.pending(0)) events.push(event);
  return events;
}
it("correlates RPC responses while delivering ordered UTF-8 notifications", async () => {
  const seen: unknown[] = [];
  const rpc = transport(async (event) => {
    seen.push(event.params);
  });
  expect(await rpc.call("echo", { hello: 1 })).toEqual({ hello: 1 });
  await rpc.call("unicode");
  await rpc.call("notify");
  await rpc.drain();
  expect(seen).toEqual([
    { text: "海🦦" },
    { text: "first" },
    { text: "second" },
  ]);
});
it("keeps the source RPC usable after capture fails and reports recovery required", async () => {
  const rpc = transport(async () => {
    throw new Error("spool full");
  });
  await rpc.call("notify");
  await expect(rpc.captureFailure).resolves.toMatchObject({
    message: "spool full",
  });
  await expect(rpc.drain()).rejects.toThrow("spool full");
  expect(await rpc.call("echo", 42)).toBe(42);
});
it("rejects oversized source frames without accumulating unbounded data", async () => {
  const rpc = transport(async () => {}, "oversized", { maxFrameBytes: 100 });
  await expect(rpc.captureFailure).resolves.toMatchObject({
    message: "Agent frame exceeds limit",
  });
});
it("does not grant an operator approval when no local handler is available", async () => {
  const rpc = transport(async () => {});
  expect(await rpc.call("ask")).toBe(-32601);
});
it("redacts secrets split across deltas and reconciles the final message once", async () => {
  const { journal, capture } = await setup(["secret-value"]);
  const item = {
    id: "message1",
    type: "agentMessage",
    text: "prefix secret-value suffix",
  };
  await capture.accept({
    method: "item/started",
    params: { threadId: "native1", item: { ...item, text: "" } },
  });
  for (const delta of ["prefix sec", "ret-val", "ue suffix"])
    await capture.accept({
      method: "item/agentMessage/delta",
      params: { threadId: "native1", itemId: item.id, delta },
    });
  await capture.accept({
    method: "item/completed",
    params: { threadId: "native1", item },
  });
  const before = journal.capturedThrough;
  await capture.accept({
    method: "item/completed",
    params: { threadId: "native1", item },
  });
  expect(journal.capturedThrough).toBe(before);
  const events = await contents(journal);
  expect(JSON.stringify(events)).not.toContain("secret-value");
  expect(
    events.filter((x) => x.content.kind === "message.started"),
  ).toHaveLength(1);
  expect(
    events.find((x) => x.content.kind === "message.reconciled")?.content
      .payload,
  ).toMatchObject({ text: "prefix [REDACTED] suffix" });
});
it("recovers full completed snapshots idempotently and marks reconstructed timing", async () => {
  const { journal, capture } = await setup();
  const turn = {
    id: "turn1",
    status: "completed",
    itemsView: "full",
    items: [
      { id: "message1", type: "agentMessage", text: "Recovered message" },
    ],
  };
  await capture.recoverCompletedTurn(turn);
  const before = journal.capturedThrough;
  await capture.recoverCompletedTurn(turn);
  expect(journal.capturedThrough).toBe(before);
  const events = await contents(journal);
  expect(events.every((x) => x.fidelity === "reconstructed")).toBe(true);
  expect(events.at(-1)?.content).toMatchObject({
    kind: "capture.gap",
    payload: { recoveredState: true },
  });
  await expect(
    capture.recoverCompletedTurn({ ...turn, itemsView: "summary" }),
  ).rejects.toThrow();
});
it("records command failure and distinguishes proposed from applied file changes", async () => {
  const { journal, capture } = await setup();
  await capture.accept({
    method: "item/completed",
    params: {
      threadId: "native1",
      item: {
        id: "cmd1",
        type: "commandExecution",
        command: "false",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "error",
      },
    },
  });
  await capture.accept({
    method: "item/completed",
    params: {
      threadId: "native1",
      item: {
        id: "file1",
        type: "fileChange",
        status: "failed",
        changes: [{ path: "example.txt", diff: "+hello" }],
      },
    },
  });
  const events = await contents(journal);
  expect(
    events.find((x) => x.content.kind === "tool.completed")?.content.payload,
  ).toMatchObject({ status: "failed", output: "error" });
  expect(events.some((x) => x.content.kind === "file.change.proposed")).toBe(
    true,
  );
  expect(events.some((x) => x.content.kind === "file.change.applied")).toBe(
    false,
  );
});
it("bounds a slow notification queue while preserving RPC responsiveness", async () => {
  const rpc = transport(async () => {}, "", { maxNotificationBytes: 1 });
  expect(await rpc.call("notify")).toBe(true);
  await expect(rpc.captureFailure).resolves.toMatchObject({
    message: "Agent capture queue exceeded limit; source recovery is required",
  });
  expect(await rpc.call("echo", "still alive")).toBe("still alive");
});
