import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import type { ActivityKind, ActivityRow } from "../../apps/web/src/activity.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
const row = (kind: ActivityKind, id: string): ActivityRow => ({
  kind,
  id,
  key: `${kind}/${id}`,
  anchor: `${kind}-${id}`,
});
async function add(state: BrowserPagedState, contents: EventContent[]) {
  const seq = state.state.appliedSeq;
  await state.apply(
    contents.map((content, index): StoredEvent => ({
      protocolVersion: 1,
      serverSeq: seq + index + 1,
      timelineMs: seq + index + 1,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `event-${seq + index}` },
      content,
    })),
    signal(),
  );
}
it("loads card metadata without reading retained text and keeps an older view immutable", async () => {
  const state = await BrowserPagedState.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  try {
    await add(state, [
      {
        kind: "agent.updated",
        payload: {
          agentId: "agent",
          nativeSessionId: "native",
          name: "Worker",
          status: "active",
        },
      },
      {
        kind: "message.started",
        payload: { messageId: "m", agentId: "agent", role: "assistant" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: "x".repeat(60000) },
      },
      {
        kind: "message.started",
        payload: { messageId: "unrelated", role: "user" },
      },
    ]);
    const ref = (await state.get("messages", "m"))!.text,
      view = state.view(),
      original = BrowserContentStore.prototype.read;
    const spy = vi
      .spyOn(BrowserContentStore.prototype, "read")
      .mockImplementation(function (
        this: BrowserContentStore,
        reference,
        offset,
        length,
        signal,
      ) {
        if (reference.hash === ref.hash)
          throw new Error("Retained text was loaded");
        return original.call(this, reference, offset, length, signal);
      });
    let card;
    try {
      card = await view.load(row("messages", "m"), signal());
    } finally {
      spy.mockRestore();
    }
    expect(card!.state.messages.size).toBe(1);
    expect(card!.state.messages.get("m")!.text).toBe("");
    expect(card!.state.agents.get("agent")!.name).toBe("Worker");
    expect(card!.texts.text!.units).toBe(60000);
    expect(await card!.texts.text!.read(0, 3, signal())).toBe("xxx");
    await add(state, [
      {
        kind: "object.visibility",
        payload: { objectType: "message", objectId: "m", visible: false },
      },
    ]);
    expect(await state.view().load(row("messages", "m"), signal())).toBeNull();
    expect(
      (await view.load(row("messages", "m"), signal()))!.texts.text!.units,
    ).toBe(60000);
  } finally {
    await state.close();
  }
});
it("loads workflow links and bounded artifact versions at the selected boundary", async () => {
  const state = await BrowserPagedState.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  try {
    await add(state, [
      {
        kind: "agent.updated",
        payload: { agentId: "a", nativeSessionId: "native", status: "active" },
      },
      {
        kind: "tool.started",
        payload: { toolId: "t", name: "shell", input: "command" },
      },
      {
        kind: "task.updated",
        payload: {
          taskId: "task",
          agentId: "a",
          toolId: "t",
          taskType: "process",
          status: "running",
          description: "work",
        },
      },
      {
        kind: "goal.updated",
        payload: { goalId: "goal", objective: "finish", status: "active" },
      },
      {
        kind: "interaction.updated",
        payload: {
          interactionId: "q",
          agentId: "a",
          toolId: "t",
          interactionType: "approval",
          status: "pending",
          title: "Approval",
          prompt: "Continue?",
        },
      },
      {
        kind: "monitor.updated",
        payload: {
          monitorId: "monitor",
          monitorType: "artifact-comments",
          sourceReference: "source",
          title: "Watching",
          status: "armed",
        },
      },
      {
        kind: "file.change.proposed",
        payload: { changeId: "change", path: "file", patch: "diff" },
      },
      {
        kind: "capture.gap",
        payload: { reason: "interrupted", recoveredState: true },
      },
    ]);
    for (let version = 1; version <= 35; version++)
      await add(state, [
        {
          kind: "attachment.available",
          payload: {
            attachment: {
              artifactId: "artifact",
              version,
              filename: "result",
              hash: "a".repeat(64),
              mediaType: "text/plain",
              byteSize: 3,
            },
          },
        },
      ]);
    await add(state, [
      {
        kind: "plan.updated",
        payload: {
          planId: "plan",
          status: "active",
          attachment: { artifactId: "artifact", version: 1 },
        },
      },
    ]);
    const view = state.view();
    const task = (await view.load(row("tasks", "task"), signal()))!;
    expect(task.state.tasks.size).toBe(1);
    expect(task.state.agents.has("a")).toBe(true);
    expect(task.state.tools.get("t")!.input).toBe("");
    for (const [kind, id] of [
      ["agents", "a"],
      ["tools", "t"],
      ["goals", "goal"],
      ["interactions", "q"],
      ["monitors", "monitor"],
      ["changes", "change"],
      ["gaps", "0"],
    ] as const)
      expect(await view.load(row(kind, id), signal())).not.toBeNull();
    const first = (await view.load(row("artifacts", "artifact"), signal()))!;
    expect(first.versions).toEqual({ offset: 0, total: 35 });
    expect(first.state.artifacts.get("artifact")!.versions.size).toBe(32);
    const last = (await view.load(row("artifacts", "artifact"), signal(), 32))!;
    expect([...last.state.artifacts.get("artifact")!.versions.keys()]).toEqual([
      33, 34, 35,
    ]);
    const plan = (await view.load(row("plans", "plan"), signal()))!;
    expect([...plan.state.artifacts.get("artifact")!.versions.keys()]).toEqual([
      1,
    ]);
  } finally {
    await state.close();
  }
});
