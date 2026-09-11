import type { EventContent, StoredEvent } from "@agentlive/protocol";
import { initialState } from "./index.js";
import { renderTerminalEvent, terminalText } from "./terminal.js";
import { completenessSummary, completenessText } from "./completeness.js";
import {
  PagedReducer,
  type PagedContent,
  type PagedRecordingState,
} from "./paged-reducer.js";
import type { ContentReference } from "./snapshot.js";
type Part = string | ContentReference;
/** Stream inert terminal output with bounded text reads and bounded object/version windows. */
export class PagedTerminalRenderer {
  constructor(
    private readonly reducer: PagedReducer,
    private readonly content: PagedContent,
    private readonly origin: string,
    private readonly streamId: string,
    private readonly attachmentLocation?: (hash: string) => string,
  ) {}
  private async *text(
    parts: readonly Part[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    let carry = "";
    for (const part of parts) {
      const units = typeof part === "string" ? part.length : part.units;
      for (let offset = 0; offset < units; offset += 4096) {
        signal.throwIfAborted();
        let text =
          carry +
          (typeof part === "string"
            ? part.slice(offset, offset + 4096)
            : await this.content.read(
                part,
                offset,
                Math.min(4096, units - offset),
                signal,
              ));
        carry = "";
        // Keep a UTF-16 pair in one output write, including across stored page boundaries.
        const last = text.charCodeAt(text.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          carry = text.slice(-1);
          text = text.slice(0, -1);
        }
        signal.throwIfAborted();
        if (text) yield terminalText(text);
      }
    }
    signal.throwIfAborted();
    if (carry) yield terminalText(carry);
  }
  private async *section(
    time: number,
    label: string,
    parts: readonly Part[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.text([`[${(time / 1000).toFixed(3)}s] ${label}\n`], signal);
    let started = false;
    for await (const chunk of this.text(parts, signal)) {
      if (!started) {
        yield "  ";
        started = true;
      }
      yield chunk.replace(/\n/g, "\n  ");
    }
    signal.throwIfAborted();
    yield started ? "\n\n" : "\n";
  }
  private async *render(
    content: EventContent,
    state: PagedRecordingState,
    time: number,
    signal: AbortSignal,
    previous?: PagedRecordingState,
  ): AsyncGenerator<string> {
    signal.throwIfAborted();
    switch (content.kind) {
      case "message.completed":
      case "message.reconciled":
      case "message.reopened": {
        const message = (await this.reducer.get(
          state,
          "messages",
          content.payload.messageId,
          signal,
        ))!;
        if (content.kind === "message.reopened")
          yield* this.section(time, `${message.role}: resumed`, [], signal);
        else if (content.kind === "message.completed")
          yield* this.section(
            time,
            message.role,
            [message.text.units ? message.text : "[No text; see attachments]"],
            signal,
          );
        else if (message.completed)
          yield* this.section(
            time,
            `${message.role} updated`,
            [message.text],
            signal,
          );
        return;
      }
      case "tool.reopened":
      case "tool.completed": {
        const tool = (await this.reducer.get(
          state,
          "tools",
          content.payload.toolId,
          signal,
        ))!;
        yield* this.section(
          time,
          `${tool.name}: ${content.kind === "tool.reopened" ? "resumed" : tool.status}`,
          content.kind === "tool.reopened"
            ? []
            : ["Input:\n", tool.input, "\nOutput:\n", tool.output],
          signal,
        );
        return;
      }
      case "file.change.applied": {
        const change = (await this.reducer.get(
          state,
          "changes",
          content.payload.changeId,
          signal,
        ))!;
        yield* this.section(
          time,
          `File change: ${change.path}`,
          [change.patch],
          signal,
        );
        return;
      }
      case "text.replacement.completed": {
        const replacement = previous
          ? await this.reducer.get(
              previous,
              "replacements",
              content.payload.replacementId,
              signal,
            )
          : undefined;
        if (replacement?.target === "message") {
          const message = (await this.reducer.get(
            state,
            "messages",
            replacement.targetId,
            signal,
          ))!;
          if (message.completed)
            yield* this.section(
              time,
              `${message.role} updated`,
              [message.text],
              signal,
            );
        } else if (replacement?.target === "change.patch") {
          const change = (await this.reducer.get(
            state,
            "changes",
            replacement.targetId,
            signal,
          ))!;
          yield* this.section(
            time,
            `File change updated: ${change.path}`,
            [change.patch],
            signal,
          );
        } else if (replacement) {
          const tool = (await this.reducer.get(
            state,
            "tools",
            replacement.targetId,
            signal,
          ))!;
          if (tool.status !== "running")
            yield* this.section(
              time,
              `${tool.name}: updated`,
              ["Input:\n", tool.input, "\nOutput:\n", tool.output],
              signal,
            );
        }
        return;
      }
      default: {
        // Remaining event renderers use their bounded protocol payload and scalar title only.
        const summary = initialState();
        summary.title = state.title;
        yield* this.text(
          [
            renderTerminalEvent(
              { content, timelineMs: time } as StoredEvent,
              summary,
              this.origin,
              this.streamId,
              undefined,
              this.attachmentLocation,
            ),
          ],
          signal,
        );
      }
    }
  }
  async *event(
    event: StoredEvent,
    state: PagedRecordingState,
    signal: AbortSignal,
    previous?: PagedRecordingState,
  ) {
    yield* this.render(
      event.content,
      state,
      event.timelineMs,
      signal,
      previous,
    );
  }
  private async *entries<K extends keyof PagedRecordingState["maps"]>(
    state: PagedRecordingState,
    name: K,
    signal: AbortSignal,
  ) {
    for (let offset = 0; offset < (state.maps[name]?.size ?? 0); offset += 32) {
      signal.throwIfAborted();
      yield* await this.reducer.entries(state, name, offset, 32, signal);
    }
  }
  async *pending(
    state: PagedRecordingState,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    let unfinishedMessages = 0,
      unfinishedTools = 0;
    for await (const [, message] of this.entries(state, "messages", signal))
      if (!message.completed && message.visible !== false) {
        unfinishedMessages++;
        yield* this.section(
          state.timelineMs,
          `${message.role}: incomplete`,
          [message.text.units ? message.text : "[No text captured]"],
          signal,
        );
      }
    for await (const [, tool] of this.entries(state, "tools", signal))
      if (tool.status === "running" && tool.visible !== false) {
        unfinishedTools++;
        yield* this.section(
          state.timelineMs,
          "Tool incomplete",
          [
            tool.name,
            "\nInput:\n",
            tool.input,
            "\nOutput captured so far:\n",
            tool.output,
          ],
          signal,
        );
      }
    for await (const [, artifact] of this.entries(state, "artifacts", signal))
      if (artifact.pending && artifact.visible !== false)
        yield* this.section(
          state.timelineMs,
          "Attachment pending",
          [artifact.filename],
          signal,
        );
    if (state.maps.replacements?.size)
      yield* this.section(
        state.timelineMs,
        "Text replacement incomplete",
        ["Previous complete text is retained until replacement chunks finish."],
        signal,
      );
    // Same rule as the reference renderer: derive only without a persisted notice.
    if (!state.completeness) {
      const summary = completenessSummary(state, {
        unfinishedMessages,
        unfinishedTools,
      });
      if (summary) {
        const notice = completenessText(summary);
        yield* this.section(
          state.timelineMs,
          notice.title,
          [notice.details.join("\n")],
          signal,
        );
      }
    }
  }
  async *snapshot(
    state: PagedRecordingState,
    signal: AbortSignal,
    positionMs = state.timelineMs,
  ): AsyncGenerator<string> {
    if (!Number.isFinite(positionMs) || positionMs < state.timelineMs)
      throw new RangeError("Snapshot position precedes reconstructed state");
    signal.throwIfAborted();
    yield `[${(positionMs / 1000).toFixed(3)}s] Playback state\n\n`;
    const render = (content: EventContent) =>
      this.render(content, state, positionMs, signal);
    yield* render({
      kind: "recording.created",
      payload: { title: state.title },
    });
    for await (const [, payload] of this.entries(state, "agents", signal))
      yield* render({ kind: "agent.updated", payload });
    for await (const [key, message] of this.entries(state, "messages", signal))
      if (message.completed && message.visible !== false)
        yield* render({
          kind: "message.completed",
          payload: { messageId: String(key) },
        });
    for await (const [, tool] of this.entries(state, "tools", signal))
      if (tool.status !== "running" && tool.visible !== false)
        yield* this.section(
          positionMs,
          `${tool.name}: ${tool.status}`,
          ["Input:\n", tool.input, "\nOutput:\n", tool.output],
          signal,
        );
    for await (const [, change] of this.entries(state, "changes", signal))
      yield* this.section(
        positionMs,
        `File change${change.applied ? "" : " proposed"}: ${change.path}`,
        [change.patch],
        signal,
      );
    for await (const [key, artifact] of this.entries(
      state,
      "artifacts",
      signal,
    )) {
      if (artifact.visible === false) continue;
      for (
        let offset = 0;
        offset < (artifact.versions?.size ?? 0);
        offset += 32
      )
        for (const attachment of await this.reducer.artifactVersions(
          state,
          String(key),
          offset,
          32,
          signal,
        ))
          yield* render({
            kind: "attachment.available",
            payload: { attachment },
          });
      if (artifact.reason !== undefined)
        yield* render({
          kind: "attachment.unavailable",
          payload: { artifactId: String(key), reason: artifact.reason },
        });
    }
    for await (const [, payload] of this.entries(state, "monitors", signal))
      yield* render({ kind: "monitor.updated", payload });
    for await (const [, payload] of this.entries(state, "tasks", signal))
      yield* render({ kind: "task.updated", payload });
    for await (const [, payload] of this.entries(state, "goals", signal))
      yield* render({ kind: "goal.updated", payload });
    for await (const [, payload] of this.entries(state, "interactions", signal))
      yield* render({ kind: "interaction.updated", payload });
    for await (const [, payload] of this.entries(state, "plans", signal))
      yield* render({ kind: "plan.updated", payload });
    for await (const [, gap] of this.entries(state, "gaps", signal))
      yield* render({
        kind: "capture.gap",
        payload: { reason: gap.reason, recoveredState: gap.recoveredState },
      });
    if (state.completeness) {
      const { at: _at, ...payload } = state.completeness;
      yield* render({ kind: "capture.completeness", payload });
    }
    yield* this.pending(state, signal);
    if (state.lifecycle === "ended")
      yield `[${(positionMs / 1000).toFixed(3)}s] Recording ended\n\n`;
  }
}
