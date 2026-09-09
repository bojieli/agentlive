import { expect, it } from "vitest";
import {
  apply,
  initialState,
  renderTerminalEvent,
  terminalText,
  renderTerminalPending,
} from "../packages/playback/src/index.js";
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
    { kind: "file.change.applied", payload: { changeId: "f" } },
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
      kind: "capture.gap",
      payload: { reason: "missing source", recoveredState: false },
    },
  ];
  let state = initialState(),
    output = "";
  for (const [index, content] of contents.entries()) {
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
