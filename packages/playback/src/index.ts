import {
  ProtocolError,
  type StoredEvent,
  type EventContent,
  type PublishedEvent,
} from "@agentlive/protocol";

export interface Message {
  visible?: boolean;
  agentId?: string;
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  completed: boolean;
}
export interface Tool {
  visible?: boolean;
  agentId?: string;
  id: string;
  name: string;
  input: string;
  output: string;
  status: "running" | "completed" | "failed" | "interrupted";
}
export interface RecordingState {
  appliedSeq: number;
  timelineMs: number;
  title: string;
  lifecycle: "open" | "ended";
  agents: Map<
    string,
    Extract<EventContent, { kind: "agent.updated" }>["payload"]
  >;
  tasks: Map<
    string,
    Extract<EventContent, { kind: "task.updated" }>["payload"]
  >;
  goals: Map<
    string,
    Extract<EventContent, { kind: "goal.updated" }>["payload"]
  >;
  interactions: Map<
    string,
    Extract<EventContent, { kind: "interaction.updated" }>["payload"]
  >;
  plans: Map<
    string,
    Extract<EventContent, { kind: "plan.updated" }>["payload"]
  >;
  messages: Map<string, Message>;
  tools: Map<string, Tool>;
  changes: Map<string, { path: string; patch: string; applied: boolean }>;
  artifacts: Map<
    string,
    {
      filename: string;
      visible?: boolean;
      pending: boolean;
      reason?: string;
      versions: Map<
        number,
        Extract<
          EventContent,
          { kind: "attachment.available" }
        >["payload"]["attachment"]
      >;
    }
  >;
  references: Map<string, { artifactId: string; version: number }>;
  replacements: Map<
    string,
    {
      target: "message" | "tool.input" | "tool.output" | "change.patch";
      targetId: string;
      chunks: string[];
      length: number;
    }
  >;
  gaps: Array<{ at: number; reason: string; recoveredState: boolean }>;
}
export function initialState(): RecordingState {
  return {
    appliedSeq: 0,
    timelineMs: 0,
    title: "",
    lifecycle: "open",
    agents: new Map(),
    tasks: new Map(),
    goals: new Map(),
    interactions: new Map(),
    plans: new Map(),
    messages: new Map(),
    tools: new Map(),
    changes: new Map(),
    artifacts: new Map(),
    references: new Map(),
    replacements: new Map(),
    gaps: [],
  };
}
function requireItem<T>(map: Map<string, T>, id: string): T {
  const found = map.get(id);
  if (!found)
    throw new ProtocolError(
      "sequence_gap",
      `Missing lifecycle start for ${id}`,
    );
  return found;
}

/** Reference reducer for bounded state; never performs I/O or changes viewer controls. */
export function apply(
  state: RecordingState,
  event: StoredEvent,
): RecordingState {
  if (event.serverSeq !== state.appliedSeq + 1)
    throw new ProtocolError(
      "sequence_gap",
      "Reducer requires the next contiguous event",
    );
  if (event.timelineMs < state.timelineMs)
    throw new ProtocolError("event_conflict", "Timeline moved backward");
  const next = {
    ...state,
    appliedSeq: event.serverSeq,
    timelineMs: event.timelineMs,
  };
  const content = event.content;
  switch (content.kind) {
    case "recording.created":
    case "session.started":
      next.title = content.payload.title;
      break;
    case "recording.ended":
      next.lifecycle = "ended";
      break;
    case "recording.reopened":
      next.lifecycle = "open";
      break;
    case "agent.updated":
      next.agents = new Map(state.agents).set(content.payload.agentId, {
        ...content.payload,
      });
      break;
    case "object.visibility": {
      const { objectId, objectType, visible } = content.payload;
      if (objectType === "message")
        next.messages = new Map(state.messages).set(objectId, {
          ...requireItem(state.messages, objectId),
          visible,
        });
      else if (objectType === "tool")
        next.tools = new Map(state.tools).set(objectId, {
          ...requireItem(state.tools, objectId),
          visible,
        });
      else
        next.artifacts = new Map(state.artifacts).set(objectId, {
          ...requireItem(state.artifacts, objectId),
          visible,
        });
      break;
    }
    case "message.started": {
      const { messageId, role } = content.payload;
      if (state.messages.has(messageId))
        throw new ProtocolError("event_conflict", "Message already started");
      next.messages = new Map(state.messages).set(messageId, {
        id: messageId,
        visible: true,
        role,
        ...(content.payload.agentId
          ? { agentId: content.payload.agentId }
          : {}),
        text: "",
        completed: false,
      });
      break;
    }
    case "message.reopened": {
      const current = requireItem(state.messages, content.payload.messageId);
      if (!current.completed)
        throw new ProtocolError("event_conflict", "Message is already active");
      next.messages = new Map(state.messages).set(current.id, {
        ...current,
        completed: false,
      });
      break;
    }
    case "message.text.append":
    case "message.reconciled":
    case "message.completed": {
      const { messageId } = content.payload;
      const current = requireItem(state.messages, messageId);
      if (content.kind === "message.text.append" && current.completed)
        throw new ProtocolError(
          "event_conflict",
          "Append after message completion",
        );
      const text =
        content.kind === "message.text.append"
          ? current.text + content.payload.text
          : content.kind === "message.reconciled"
            ? content.payload.text
            : current.text;
      next.messages = new Map(state.messages).set(messageId, {
        ...current,
        text,
        completed: current.completed || content.kind === "message.completed",
      });
      break;
    }
    case "text.replacement.started": {
      const { replacementId, target, targetId } = content.payload;
      if (
        state.replacements.has(replacementId) ||
        state.replacements.size >= 16
      )
        throw new ProtocolError(
          "event_conflict",
          "Invalid or excessive text replacements",
        );
      if (target === "message") requireItem(state.messages, targetId);
      else if (target === "change.patch") requireItem(state.changes, targetId);
      else requireItem(state.tools, targetId);
      next.replacements = new Map(state.replacements).set(replacementId, {
        target,
        targetId,
        chunks: [],
        length: 0,
      });
      break;
    }
    case "text.replacement.chunk": {
      const { replacementId, index, text } = content.payload;
      const current = requireItem(state.replacements, replacementId);
      const total = [...state.replacements.values()].reduce(
        (sum, item) => sum + item.length,
        0,
      );
      if (
        index !== current.chunks.length ||
        total + text.length > 32 * 1024 * 1024
      )
        throw new ProtocolError(
          "sequence_gap",
          "Invalid text replacement chunk or capacity exceeded",
        );
      next.replacements = new Map(state.replacements).set(replacementId, {
        ...current,
        chunks: [...current.chunks, text],
        length: current.length + text.length,
      });
      break;
    }
    case "text.replacement.completed": {
      const { replacementId, parts } = content.payload;
      const current = requireItem(state.replacements, replacementId);
      if (parts !== current.chunks.length)
        throw new ProtocolError(
          "sequence_gap",
          "Text replacement is incomplete",
        );
      const text = current.chunks.join("");
      if (current.target === "message")
        next.messages = new Map(state.messages).set(current.targetId, {
          ...requireItem(state.messages, current.targetId),
          text,
        });
      else if (current.target === "change.patch")
        next.changes = new Map(state.changes).set(current.targetId, {
          ...requireItem(state.changes, current.targetId),
          patch: text,
        });
      else
        next.tools = new Map(state.tools).set(current.targetId, {
          ...requireItem(state.tools, current.targetId),
          [current.target === "tool.input" ? "input" : "output"]: text,
        });
      next.replacements = new Map(state.replacements);
      next.replacements.delete(replacementId);
      break;
    }
    case "tool.started": {
      const { toolId, name, input } = content.payload;
      if (state.tools.has(toolId))
        throw new ProtocolError("event_conflict", "Tool already started");
      next.tools = new Map(state.tools).set(toolId, {
        id: toolId,
        visible: true,
        name,
        ...(content.payload.agentId
          ? { agentId: content.payload.agentId }
          : {}),
        input,
        output: "",
        status: "running",
      });
      break;
    }
    case "tool.reopened": {
      const current = requireItem(state.tools, content.payload.toolId);
      if (current.status === "running")
        throw new ProtocolError("event_conflict", "Tool is already active");
      next.tools = new Map(state.tools).set(current.id, {
        ...current,
        status: "running",
        output: "",
      });
      break;
    }
    case "tool.arguments.append":
    case "tool.arguments.ready":
    case "tool.output.append":
    case "tool.completed": {
      const { toolId } = content.payload;
      const current = requireItem(state.tools, toolId);
      const tool = { ...current };
      if (content.kind === "tool.arguments.append")
        tool.input += content.payload.text;
      if (content.kind === "tool.arguments.ready")
        tool.input = content.payload.input;
      if (content.kind === "tool.output.append")
        tool.output += content.payload.text;
      if (content.kind === "tool.completed") {
        tool.status = content.payload.status;
        if (content.payload.output !== undefined)
          tool.output = content.payload.output;
      }
      next.tools = new Map(state.tools).set(toolId, tool);
      break;
    }
    case "file.change.proposed":
    case "file.change.applied": {
      const { changeId, path, patch } = content.payload;
      next.changes = new Map(state.changes).set(changeId, {
        path,
        patch,
        applied: content.kind === "file.change.applied",
      });
      break;
    }
    case "attachment.pending": {
      const { artifactId, filename } = content.payload;
      next.artifacts = new Map(state.artifacts).set(artifactId, {
        filename,
        visible: state.artifacts.get(artifactId)?.visible ?? true,
        pending: true,
        versions: new Map(state.artifacts.get(artifactId)?.versions),
      });
      break;
    }
    case "attachment.available": {
      const attachment = content.payload.attachment;
      const old = state.artifacts.get(attachment.artifactId);
      if (old?.versions.has(attachment.version))
        throw new ProtocolError(
          "event_conflict",
          "Artifact version already exists",
        );
      next.artifacts = new Map(state.artifacts).set(attachment.artifactId, {
        filename: attachment.filename,
        visible: old?.visible ?? true,
        pending: false,
        versions: new Map(old?.versions).set(attachment.version, attachment),
      });
      break;
    }
    case "attachment.unavailable": {
      const { artifactId, reason } = content.payload;
      const old = state.artifacts.get(artifactId);
      next.artifacts = new Map(state.artifacts).set(artifactId, {
        filename: old?.filename ?? artifactId,
        visible: old?.visible ?? true,
        pending: false,
        reason,
        versions: new Map(old?.versions),
      });
      break;
    }
    case "reference.resolved": {
      const { messageId, sourceReference, artifactId, version } =
        content.payload;
      if (!state.artifacts.get(artifactId)?.versions.has(version))
        throw new ProtocolError(
          "sequence_gap",
          "Artifact version is unavailable",
        );
      next.references = new Map(state.references).set(
        JSON.stringify([messageId, sourceReference]),
        { artifactId, version },
      );
      break;
    }
    case "task.updated":
      next.tasks = new Map(state.tasks).set(content.payload.taskId, {
        ...content.payload,
      });
      break;
    case "goal.updated":
      next.goals = new Map(state.goals).set(content.payload.goalId, {
        ...content.payload,
      });
      break;
    case "interaction.updated":
      next.interactions = new Map(state.interactions).set(
        content.payload.interactionId,
        { ...content.payload },
      );
      break;
    case "plan.updated":
      if (
        content.payload.attachment &&
        !state.artifacts
          .get(content.payload.attachment.artifactId)
          ?.versions.has(content.payload.attachment.version)
      )
        throw new ProtocolError(
          "sequence_gap",
          "Plan attachment version is unavailable",
        );
      next.plans = new Map(state.plans).set(content.payload.planId, {
        ...content.payload,
      });
      break;
    case "capture.gap":
      next.gaps = [...state.gaps, { at: event.serverSeq, ...content.payload }];
      break;
    case "session.ended":
    case "turn.started":
    case "turn.ended":
    case "capture.clock":
    case "publisher.epoch.changed":
      break;
    default: {
      const exhaustive: never = content;
      throw new Error(`Unsupported content ${exhaustive}`);
    }
  }
  return next;
}

export type PlaybackMode = "following-live" | "paused" | "playing-history";
export class PlaybackClock {
  mode: PlaybackMode = "paused";
  private rate = 1;
  private position = 0;
  private anchor = 0;
  get speed(): number {
    return this.rate;
  }
  time(now: number, highWater: number): number {
    if (this.mode === "following-live") return highWater;
    return Math.min(
      highWater,
      this.position +
        (this.mode === "playing-history"
          ? Math.max(0, now - this.anchor) * this.rate
          : 0),
    );
  }
  seek(position: number, now: number): void {
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(now))
      throw new RangeError("Invalid playback position");
    this.position = position;
    this.anchor = now;
  }
  setMode(mode: PlaybackMode, now: number, highWater: number): void {
    this.seek(this.time(now, highWater), now);
    this.mode = mode;
  }
  setSpeed(rate: number, now: number, highWater: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1024)
      throw new RangeError("Invalid playback speed");
    this.seek(this.time(now, highWater), now);
    this.rate = rate;
  }
}

/** Capture clock mapping is deterministic from the already recorded prefix. */
export function mapCaptureTime(
  event: PublishedEvent,
  segmentAnchor: { elapsedMs: number; timelineMs: number } | undefined,
  previousTimeline: number,
): number {
  return segmentAnchor
    ? Math.max(
        previousTimeline,
        segmentAnchor.timelineMs + event.elapsedMs - segmentAnchor.elapsedMs,
      )
    : previousTimeline;
}
export {
  terminalText,
  renderTerminalEvent,
  renderTerminalPending,
  renderTerminalSnapshot,
} from "./terminal.js";
export { PlaybackPacer } from "./pacer.js";
