import { expect, it } from "vitest";
import {
  apply,
  initialState,
  renderTerminalEvent,
  terminalText,
  renderTerminalPending,
  renderTerminalSnapshot,
} from "../packages/playback/src/index.js";
import { contentSchema } from "../packages/protocol/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../packages/protocol/src/index.js";
it("renders captured object types with inert source text and attachment links", () => {
  const contents: EventContent[] = [
    { kind: "message.started", payload: { messageId: "m", role: "assistant" } },
    {
      kind: "message.reconciled",
      payload: { messageId: "m", text: "hello\u001b[2J\rworld\u202e" },
    },
    { kind: "message.completed", payload: { messageId: "m" } },
    {
      kind: "text.replacement.started",
      payload: {
        replacementId: "replacement",
        target: "message",
        targetId: "m",
      },
    },
    {
      kind: "text.replacement.chunk",
      payload: {
        replacementId: "replacement",
        index: 0,
        text: "corrected complete text",
      },
    },
    {
      kind: "text.replacement.completed",
      payload: { replacementId: "replacement", parts: 1 },
    },
    {
      kind: "tool.started",
      payload: { toolId: "t", name: "Shell", input: "echo safe" },
    },
    {
      kind: "tool.completed",
      payload: { toolId: "t", status: "failed", output: "failed output" },
    },
    {
      kind: "file.change.proposed",
      payload: { changeId: "f", path: "result.txt", patch: "+new line" },
    },
    {
      kind: "file.change.applied",
      payload: { changeId: "f", path: "result.txt", patch: "+new line" },
    },
    {
      kind: "attachment.available",
      payload: {
        attachment: {
          artifactId: "a",
          version: 1,
          hash: "a".repeat(64),
          filename: "image.png",
          mediaType: "image/png",
          byteSize: 10,
          provenance: "historical-version",
        },
      },
    },
    {
      kind: "task.updated",
      payload: {
        taskId: "task",
        taskType: "process",
        status: "completed",
        description: "Monitor finished",
      },
    },
    {
      kind: "goal.updated",
      payload: {
        goalId: "goal",
        objective: "Finish work",
        status: "paused",
        turnsUsed: 2,
        tokensUsed: 100,
      },
    },
    {
      kind: "interaction.updated",
      payload: {
        interactionId: "approval",
        interactionType: "approval",
        status: "resolved",
        title: "Shell",
        prompt: "Run command",
        response: "approved",
        scope: "session",
      },
    },
    {
      kind: "plan.updated",
      payload: {
        planId: "plan",
        status: "active",
        version: 1,
        sourceReference: "plan.md",
      },
    },
    {
      kind: "capture.gap",
      payload: { reason: "missing source", recoveredState: false },
    },
  ];
  let state = initialState(),
    output = "";
  for (const [index, content] of contents.entries()) {
    contentSchema.parse(content);
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: index + 1,
      timelineMs: index * 100,
      receivedAt: "2026-09-01T00:00:00.000Z",
      origin: { type: "server", operationId: `test_${index}` },
      content,
    };
    const previous = state;
    state = apply(state, event);
    output += renderTerminalEvent(
      event,
      state,
      "http://localhost:7331",
      "stream",
      previous,
    );
  }
  const snapshot = [
    ...renderTerminalSnapshot(state, "http://localhost:7331", "stream"),
  ].join("");
  for (const expected of [
    "corrected complete text",
    "Shell: failed",
    "+new line",
    "historical-version",
    "/api/v1/streams/stream/attachments/",
    "approval: resolved",
    "Plan: active",
    "Task process: completed",
    "Goal: paused",
    "Capture gap",
  ])
    expect(snapshot).toContain(expected);
  expect(snapshot).not.toContain("\u001b");
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("\r");
  expect(output).not.toContain("\u202e");
  expect(output).toContain("\\u001b[2J\\u000dworld\\u202e");
  expect(output).toContain("assistant updated");
  expect(output).toContain("corrected complete text");
  expect(output).toContain("Shell: failed");
  expect(output).toContain("+new line");
  expect(output).toContain("historical-version");
  expect(output).toContain("/api/v1/streams/stream/attachments/");
  expect(output).toContain("Capture gap");
  expect(output).toContain("approval: resolved");
  expect(output).toContain("Recorded response: approved");
  expect(output).toContain("Plan: active");
  expect(output).toContain("Task process: completed");
  expect(output).toContain("Goal: paused");
  expect(output).toContain("Tokens used: 100");
  expect(terminalText("normal\ntext\tcolumn")).toBe("normal\ntext\tcolumn");
});

it("shows unfinished messages, tools, and attachments at the selected replay boundary", () => {
  const state = initialState();
  state.messages.set("m", {
    id: "m",
    role: "assistant",
    text: "partial reply",
    completed: false,
  });
  state.tools.set("t", {
    id: "t",
    name: "Shell",
    input: "command",
    output: "partial output\u001b[2J",
    status: "running",
  });
  state.artifacts.set("a", {
    filename: "pending.png",
    pending: true,
    versions: new Map(),
  });
  const output = [...renderTerminalPending(state)].join("");
  expect(output).toContain("assistant: incomplete");
  expect(output).toContain("partial reply");
  expect(output).toContain("Tool incomplete");
  expect(output).toContain("partial output\\u001b[2J");
  expect(output).toContain("Attachment pending");
  expect(output).not.toContain("\u001b");
});
it("renders resumed objects and restores active state while keeping prior replay states immutable", () => {
  const events: EventContent[] = [
    { kind: "message.started", payload: { messageId: "m", role: "assistant" } },
    { kind: "message.completed", payload: { messageId: "m" } },
    {
      kind: "tool.started",
      payload: { toolId: "t", name: "Shell", input: "run" },
    },
    {
      kind: "tool.completed",
      payload: { toolId: "t", status: "failed", output: "old error" },
    },
    { kind: "message.reopened", payload: { messageId: "m" } },
    {
      kind: "message.text.append",
      payload: { messageId: "m", text: "continuing" },
    },
    { kind: "tool.reopened", payload: { toolId: "t" } },
  ];
  let state = initialState();
  let rendered = "";
  for (const [index, content] of events.entries()) {
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: index + 1,
      receivedAt: "2026-09-09T00:00:00Z",
      timelineMs: index,
      content,
      origin: { type: "server", operationId: `event${index}` },
    };
    const previous = state;
    state = apply(state, event);
    rendered += renderTerminalEvent(
      event,
      state,
      "http://localhost",
      "stream",
      previous,
    );
    if (content.kind === "tool.reopened")
      expect(previous.tools.get("t")?.output).toBe("old error");
  }
  expect(rendered).toContain("assistant: resumed");
  expect(rendered).toContain("Shell: resumed");
  expect(state.messages.get("m")).toMatchObject({
    completed: false,
    text: "continuing",
  });
  expect(state.tools.get("t")).toMatchObject({ status: "running", output: "" });
  expect(() =>
    apply(state, {
      protocolVersion: 1,
      serverSeq: 8,
      receivedAt: "2026-09-09T00:00:00Z",
      timelineMs: 8,
      content: { kind: "tool.reopened", payload: { toolId: "t" } },
      origin: { type: "server", operationId: "duplicate" },
    }),
  ).toThrow("already active");
});

it("keeps hidden attachments hidden across pending updates and restores pending presentation", () => {
  let state = initialState();
  let seq = 0;
  const step = (content: EventContent) => {
    state = apply(state, {
      protocolVersion: 1,
      serverSeq: ++seq,
      receivedAt: "2026-09-09T00:00:00Z",
      timelineMs: seq,
      content,
      origin: { type: "server", operationId: "event" + seq },
    });
  };
  step({
    kind: "attachment.pending",
    payload: { artifactId: "a", filename: "image.png" },
  });
  step({
    kind: "object.visibility",
    payload: { objectType: "attachment", objectId: "a", visible: false },
  });
  const hidden = state;
  step({
    kind: "attachment.pending",
    payload: { artifactId: "a", filename: "image-v2.png" },
  });
  expect(state.artifacts.get("a")?.visible).toBe(false);
  expect([...renderTerminalPending(state)].join("")).not.toContain(
    "image-v2.png",
  );
  step({
    kind: "object.visibility",
    payload: { objectType: "attachment", objectId: "a", visible: true },
  });
  expect([...renderTerminalPending(state)].join("")).toContain("image-v2.png");
  expect(hidden.artifacts.get("a")?.visible).toBe(false);
});

it("renders a seek boundary with partial replacements and hidden objects without mutating state", () => {
  let state = initialState();
  const events: EventContent[] = [
    { kind: "message.started", payload: { messageId: "m", role: "assistant" } },
    {
      kind: "message.reconciled",
      payload: { messageId: "m", text: "retained partial" },
    },
    { kind: "message.started", payload: { messageId: "hidden", role: "user" } },
    {
      kind: "message.reconciled",
      payload: { messageId: "hidden", text: "hidden content" },
    },
    { kind: "message.completed", payload: { messageId: "hidden" } },
    {
      kind: "object.visibility",
      payload: { objectType: "message", objectId: "hidden", visible: false },
    },
    {
      kind: "tool.started",
      payload: { toolId: "t", name: "Shell", input: "input" },
    },
    {
      kind: "tool.output.append",
      payload: { toolId: "t", text: "partial output" },
    },
    {
      kind: "attachment.pending",
      payload: { artifactId: "a", filename: "image.png" },
    },
  ];
  for (const [index, content] of events.entries())
    state = apply(state, {
      protocolVersion: 1,
      serverSeq: index + 1,
      receivedAt: "2026-09-09T00:00:00Z",
      timelineMs: index,
      content,
      origin: { type: "server", operationId: "e" + index },
    });
  state.replacements.set("replacement", {
    target: "message",
    targetId: "m",
    chunks: ["uncommitted"],
    length: 11,
  });
  const before = structuredClone(state);
  const output = [
    ...renderTerminalSnapshot(state, "http://localhost", "stream", 100),
  ].join("");
  expect(output).toContain("[0.100s] Playback state");
  expect(output).toContain("retained partial");
  expect(output).toContain("partial output");
  expect(output).toContain("image.png");
  expect(output).toContain("Text replacement incomplete");
  expect(output).not.toContain("hidden content");
  expect(output).not.toContain("uncommitted");
  expect(state).toEqual(before);
});
