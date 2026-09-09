import type { StoredEvent } from "@agentlive/protocol";
import type { RecordingState } from "./index.js";
/** Keep source content inert: no ANSI/OSC, cursor movement, hidden bidi controls or carriage returns. */
export function terminalText(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function renderTerminalEvent(
  event: StoredEvent,
  state: RecordingState,
  serverOrigin: string,
  streamId: string,
  previous?: RecordingState,
): string {
  const content = event.content;
  const section = (label: string, body = "") =>
    `[${(event.timelineMs / 1000).toFixed(3)}s] ${terminalText(label)}\n${
      body
        ? terminalText(body)
            .split("\n")
            .map((line) => "  " + line)
            .join("\n") + "\n"
        : ""
    }\n`;
  switch (content.kind) {
    case "recording.created":
      return section("Recording", state.title);
    case "session.started":
      return section(`${content.payload.agent} session`, content.payload.title);
    case "recording.ended":
      return section("Recording ended");
    case "recording.reopened":
      return section("Recording reopened");
    case "session.ended":
      return section("Agent session ended", content.payload.reason);
    case "turn.started":
      return section("Turn started");
    case "turn.ended":
      return section(`Turn ${content.payload.status}`);
    case "agent.updated":
      return section(
        `Agent ${content.payload.status}`,
        content.payload.name ?? content.payload.agentId,
      );
    case "message.completed": {
      const message = state.messages.get(content.payload.messageId)!;
      return section(
        message.role,
        message.text || "[No text; see attachments]",
      );
    }
    case "message.reconciled": {
      const message = state.messages.get(content.payload.messageId)!;
      return message.completed
        ? section(`${message.role} updated`, message.text)
        : "";
    }
    case "tool.started":
      return section(`${content.payload.name}: started`, content.payload.input);
    case "text.replacement.completed": {
      const replacement = previous?.replacements.get(
        content.payload.replacementId,
      );
      if (replacement?.target === "message") {
        const message = state.messages.get(replacement.targetId)!;
        if (message.completed)
          return section(`${message.role} updated`, message.text);
      } else if (replacement?.target === "change.patch") {
        const change = state.changes.get(replacement.targetId)!;
        return section(`File change updated: ${change.path}`, change.patch);
      } else if (replacement) {
        const tool = state.tools.get(replacement.targetId)!;
        if (tool.status !== "running")
          return section(
            `${tool.name}: updated`,
            `Input:\n${tool.input}\nOutput:\n${tool.output}`,
          );
      }
      return "";
    }
    case "tool.completed": {
      const tool = state.tools.get(content.payload.toolId)!;
      return section(
        `${tool.name}: ${tool.status}`,
        `Input:\n${tool.input}\nOutput:\n${tool.output}`,
      );
    }
    case "file.change.proposed":
      return section(
        `File change proposed: ${content.payload.path}`,
        content.payload.patch,
      );
    case "capture.clock":
      return section(
        `Capture clock: ${content.payload.confidence}`,
        content.payload.wallAnchor,
      );
    case "publisher.epoch.changed":
      return section("Publisher epoch changed", content.payload.reason);
    case "file.change.applied": {
      const change = state.changes.get(content.payload.changeId)!;
      return section(`File change: ${change.path}`, change.patch);
    }
    case "attachment.available": {
      const attachment = content.payload.attachment;
      return section(
        `Attachment: ${attachment.filename}`,
        `${attachment.mediaType}; ${attachment.byteSize} bytes; version ${attachment.version}\n${attachment.provenance ?? "provenance unavailable"}\n${serverOrigin}/api/v1/streams/${streamId}/attachments/${attachment.hash}`,
      );
    }
    case "attachment.unavailable":
      return section("Attachment unavailable", content.payload.reason);
    case "capture.gap":
      return section(
        content.payload.recoveredState ? "Capture recovered" : "Capture gap",
        content.payload.reason,
      );
    default:
      return "";
  }
}
/** Surface captured work that has no completion event at the selected history boundary. */
export function* renderTerminalPending(
  state: RecordingState,
): Generator<string> {
  const block = (label: string, text: string) =>
    `[${(state.timelineMs / 1000).toFixed(3)}s] ${label}\n${terminalText(text)
      .split("\n")
      .map((line) => "  " + line)
      .join("\n")}\n\n`;
  for (const message of state.messages.values())
    if (!message.completed)
      yield block(
        `${message.role}: incomplete`,
        message.text || "[No text captured]",
      );
  for (const tool of state.tools.values())
    if (tool.status === "running")
      yield block(
        "Tool incomplete",
        `${tool.name}\nInput:\n${tool.input}\nOutput captured so far:\n${tool.output}`,
      );
  for (const artifact of state.artifacts.values())
    if (artifact.pending) yield block("Attachment pending", artifact.filename);
  if (state.replacements.size)
    yield block(
      "Text replacement incomplete",
      "Previous complete text is retained until replacement chunks finish.",
    );
}
