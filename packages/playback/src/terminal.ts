import type { EventContent, StoredEvent } from "@agentlive/protocol";
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
  return renderContent(
    event.content,
    state,
    serverOrigin,
    streamId,
    event.timelineMs,
    previous,
  );
}
function renderContent(
  content: EventContent,
  state: RecordingState,
  serverOrigin: string,
  streamId: string,
  timelineMs: number,
  previous?: RecordingState,
): string {
  const section = (label: string, body = "") =>
    `[${(timelineMs / 1000).toFixed(3)}s] ${terminalText(label)}\n${
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
    case "object.visibility":
      return section(
        `${content.payload.objectType}: ${content.payload.visible ? "restored" : "removed"}`,
      );
    case "message.reopened":
      return section(
        `${state.messages.get(content.payload.messageId)!.role}: resumed`,
      );
    case "tool.reopened":
      return section(
        `${state.tools.get(content.payload.toolId)!.name}: resumed`,
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
    case "monitor.updated": {
      const monitor = content.payload;
      return section(
        `Monitor ${monitor.monitorType}: ${monitor.status}`,
        [
          monitor.title,
          monitor.sourceReference,
          monitor.nativeState === undefined
            ? undefined
            : "Native state: " + monitor.nativeState,
          monitor.baselineEstablished === undefined
            ? undefined
            : "Baseline established: " + monitor.baselineEstablished,
          monitor.hasObservedThreads === undefined
            ? undefined
            : "Observed threads: " + monitor.hasObservedThreads,
        ]
          .filter((value) => value !== undefined)
          .join("\n"),
      );
    }
    case "task.updated":
      return section(
        `Task ${content.payload.taskType}: ${content.payload.status}`,
        content.payload.description,
      );
    case "goal.updated": {
      const goal = content.payload;
      return section(
        `Goal: ${goal.status}`,
        [
          goal.objective,
          goal.completionCriterion,
          goal.reason,
          goal.tokensUsed === undefined
            ? undefined
            : `Tokens used: ${goal.tokensUsed}`,
          goal.turnsUsed === undefined
            ? undefined
            : `Turns used: ${goal.turnsUsed}`,
          goal.wallClockMs === undefined
            ? undefined
            : `Elapsed: ${goal.wallClockMs} ms`,
        ]
          .filter((value) => value !== undefined)
          .join("\n"),
      );
    }
    case "interaction.updated": {
      const interaction = content.payload;
      return section(
        `${interaction.interactionType}: ${interaction.status}`,
        [
          interaction.title,
          interaction.prompt,
          ...(interaction.questions ?? []).flatMap((question) => [
            question.question,
            ...(question.options ?? []).map(
              (option) =>
                `${option.label}${option.description ? `: ${option.description}` : ""}`,
            ),
          ]),
          interaction.response === undefined
            ? undefined
            : `Recorded response: ${interaction.response}`,
          interaction.scope === undefined
            ? undefined
            : `Scope: ${interaction.scope}`,
        ]
          .filter((value) => value !== undefined && value !== "")
          .join("\n"),
      );
    }
    case "plan.updated": {
      const plan = content.payload;
      return section(
        `Plan: ${plan.status}`,
        [
          plan.version === undefined ? undefined : `Version: ${plan.version}`,
          plan.sourceReference,
          plan.sourceHash,
          plan.byteSize === undefined ? undefined : `${plan.byteSize} bytes`,
          plan.attachment
            ? `Plan content: attachment ${plan.attachment.artifactId} version ${plan.attachment.version}`
            : "Plan content requires attachment resolution",
        ]
          .filter((value) => value !== undefined)
          .join("\n"),
      );
    }
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
    if (!message.completed && message.visible !== false)
      yield block(
        `${message.role}: incomplete`,
        message.text || "[No text captured]",
      );
  for (const tool of state.tools.values())
    if (tool.status === "running" && tool.visible !== false)
      yield block(
        "Tool incomplete",
        `${tool.name}\nInput:\n${tool.input}\nOutput captured so far:\n${tool.output}`,
      );
  for (const artifact of state.artifacts.values())
    if (artifact.pending && artifact.visible !== false)
      yield block("Attachment pending", artifact.filename);
  if (state.replacements.size)
    yield block(
      "Text replacement incomplete",
      "Previous complete text is retained until replacement chunks finish.",
    );
}

/** Current state at a seek boundary; does not invent or append stored events. */
export function* renderTerminalSnapshot(
  state: RecordingState,
  serverOrigin: string,
  streamId: string,
  positionMs = state.timelineMs,
): Generator<string> {
  if (!Number.isFinite(positionMs) || positionMs < state.timelineMs)
    throw new RangeError("Snapshot position precedes reconstructed state");
  yield `[${(positionMs / 1000).toFixed(3)}s] Playback state

`;
  const render = (content: EventContent) =>
    renderContent(content, state, serverOrigin, streamId, positionMs);
  yield render({ kind: "recording.created", payload: { title: state.title } });
  for (const payload of state.agents.values())
    yield render({ kind: "agent.updated", payload });
  for (const [messageId, message] of state.messages)
    if (message.completed && message.visible !== false)
      yield render({ kind: "message.completed", payload: { messageId } });
  for (const [toolId, tool] of state.tools)
    if (tool.status !== "running" && tool.visible !== false)
      yield render({
        kind: "tool.completed",
        payload: { toolId, status: tool.status, output: tool.output },
      });
  for (const [changeId, change] of state.changes)
    yield render(
      change.applied
        ? {
            kind: "file.change.applied",
            payload: { changeId, path: change.path, patch: change.patch },
          }
        : {
            kind: "file.change.proposed",
            payload: { changeId, path: change.path, patch: change.patch },
          },
    );
  for (const [artifactId, artifact] of state.artifacts) {
    if (artifact.visible === false) continue;
    for (const attachment of artifact.versions.values())
      yield render({ kind: "attachment.available", payload: { attachment } });
    if (artifact.reason !== undefined)
      yield render({
        kind: "attachment.unavailable",
        payload: { artifactId, reason: artifact.reason },
      });
  }
  for (const payload of state.monitors.values())
    yield render({ kind: "monitor.updated", payload });
  for (const payload of state.tasks.values())
    yield render({ kind: "task.updated", payload });
  for (const payload of state.goals.values())
    yield render({ kind: "goal.updated", payload });
  for (const payload of state.interactions.values())
    yield render({ kind: "interaction.updated", payload });
  for (const payload of state.plans.values())
    yield render({ kind: "plan.updated", payload });
  for (const gap of state.gaps)
    yield render({
      kind: "capture.gap",
      payload: { reason: gap.reason, recoveredState: gap.recoveredState },
    });
  yield* renderTerminalPending(state);
  if (state.lifecycle === "ended")
    yield `[${(positionMs / 1000).toFixed(3)}s] Recording ended\n\n`;
}
