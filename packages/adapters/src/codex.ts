import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import type { RpcNotification } from "./stdio.js";
const id = (value: string) => createHash("sha256").update(value).digest("hex");
const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
const string = (value: unknown) => z.string().parse(value);
const status = (value: unknown): "completed" | "failed" | "interrupted" =>
  value === "completed"
    ? "completed"
    : value === "interrupted" || value === "declined"
      ? "interrupted"
      : "failed";
/** Normalizes supported public app-server notifications into durable, source-keyed effects. */
export class CodexCapture {
  private readonly segment = randomUUID();
  private readonly started = performance.now();
  private sequence = 0;
  private readonly filters = new Map<string, StreamingRedactor>();
  private readonly secrets: readonly string[];
  constructor(
    private readonly journal: PublisherJournal,
    secrets: readonly string[] = [],
  ) {
    if (journal.identity.nativeAgent !== "codex")
      throw new Error("Codex capture requires a Codex journal");
    this.secrets = [...secrets];
    new StreamingRedactor(secrets);
  }
  private filter(text: string): string {
    const filter = new StreamingRedactor(this.secrets);
    return filter.push(text) + filter.finish();
  }
  private async emit(
    key: string,
    content: EventContent[],
    fidelity: "delta" | "block" | "reconstructed" = "block",
  ) {
    if (!content.length) return;
    await this.journal.capture({
      sourceKey: key,
      content,
      observedAt: new Date().toISOString(),
      clockSegmentId: this.segment,
      elapsedMs: performance.now() - this.started,
      fidelity,
      adapterState: { version: 1, agent: "codex" },
    });
  }
  async begin(): Promise<void> {
    await this.emit("codex/session", [
      {
        kind: "session.started",
        payload: {
          agent: "codex",
          nativeSessionId: this.journal.identity.nativeSessionId,
          title: "Codex session",
        },
      },
    ]);
  }
  async accept(notification: RpcNotification): Promise<void> {
    const p = z.record(z.string(), z.unknown()).parse(notification.params);
    if (p.threadId !== this.journal.identity.nativeSessionId) return;
    const method = notification.method;
    if (method === "turn/started" || method === "turn/completed") {
      const turn = z
        .object({ id: z.string(), status: z.string() })
        .parse(p.turn);
      await this.emit(`turn/${id(turn.id)}/start`, [
        { kind: "turn.started", payload: { turnId: id(turn.id) } },
      ]);
      if (method === "turn/completed")
        await this.emit(`turn/${id(turn.id)}/end`, [
          {
            kind: "turn.ended",
            payload: { turnId: id(turn.id), status: status(turn.status) },
          },
        ]);
    } else if (method === "item/started" || method === "item/completed")
      await this.item(p.item, method === "item/completed");
    else if (
      method === "item/agentMessage/delta" ||
      method === "item/commandExecution/outputDelta"
    ) {
      const itemId = string(p.itemId),
        text = string(p.delta),
        tool = method.includes("commandExecution");
      let filter = this.filters.get(itemId);
      if (!filter) {
        if (this.filters.size >= 1024)
          throw new Error("Too many active Codex text streams");
        filter = new StreamingRedactor(this.secrets);
        this.filters.set(itemId, filter);
      }
      const filtered = filter.push(text);
      await this.emit(
        `delta/${this.segment}/${++this.sequence}`,
        [
          {
            kind: tool ? "tool.output.append" : "message.text.append",
            payload: tool
              ? { toolId: id(itemId), text: filtered }
              : { messageId: id(itemId), text: filtered },
          },
        ] as EventContent[],
        "delta",
      );
    }
  }
  /** Recover only full, terminal turns. Active-turn recovery needs an explicit live handoff. */
  async recoverCompletedTurn(raw: unknown): Promise<void> {
    const turn = z
      .object({
        id: z.string(),
        status: z.enum(["completed", "failed", "interrupted"]),
        itemsView: z.literal("full"),
        items: z.array(z.unknown()),
      })
      .parse(raw);
    const before = this.journal.capturedThrough;
    await this.emit(
      `turn/${id(turn.id)}/start`,
      [{ kind: "turn.started", payload: { turnId: id(turn.id) } }],
      "reconstructed",
    );
    for (const item of turn.items) await this.item(item, true, "reconstructed");
    await this.emit(
      `turn/${id(turn.id)}/end`,
      [
        {
          kind: "turn.ended",
          payload: { turnId: id(turn.id), status: turn.status },
        },
      ],
      "reconstructed",
    );
    if (this.journal.capturedThrough > before)
      await this.emit(
        `recovery/${id(turn.id)}`,
        [
          {
            kind: "capture.gap",
            payload: {
              reason:
                "Recovered completed Codex turn from a source snapshot; original incremental timing is unavailable",
              recoveredState: true,
            },
          },
        ],
        "reconstructed",
      );
  }
  private async item(
    raw: unknown,
    completed: boolean,
    fidelity: "block" | "reconstructed" = "block",
  ): Promise<void> {
    const item = itemSchema.parse(raw),
      key = `item/${id(item.id)}`,
      itemId = id(item.id);
    if (
      item.type === "agentMessage" ||
      item.type === "plan" ||
      item.type === "userMessage"
    ) {
      const role = item.type === "userMessage" ? "user" : "assistant";
      await this.emit(
        key + "/start",
        [{ kind: "message.started", payload: { messageId: itemId, role } }],
        fidelity,
      );
      if (completed) {
        const text =
          item.type !== "userMessage"
            ? string(item.text)
            : z
                .array(
                  z.object({ type: z.string(), text: z.string().optional() }),
                )
                .parse(item.content)
                .filter((x) => x.type === "text")
                .map((x) => x.text ?? "")
                .join("\n");
        this.filters.delete(item.id);
        await this.emit(
          key + "/end",
          [
            {
              kind: "message.reconciled",
              payload: { messageId: itemId, text: this.filter(text) },
            },
            { kind: "message.completed", payload: { messageId: itemId } },
          ],
          fidelity,
        );
      }
    } else if (
      item.type === "commandExecution" ||
      item.type === "mcpToolCall"
    ) {
      const input =
        item.type === "commandExecution"
          ? string(item.command)
          : canonicalJson(item.arguments);
      const name =
        item.type === "commandExecution"
          ? "shell"
          : `${string(item.server)}/${string(item.tool)}`;
      await this.emit(
        key + "/start",
        [
          {
            kind: "tool.started",
            payload: {
              toolId: itemId,
              name: this.filter(name),
              input: this.filter(input),
            },
          },
        ],
        fidelity,
      );
      if (completed) {
        this.filters.delete(item.id);
        await this.emit(
          key + "/end",
          [
            {
              kind: "tool.completed",
              payload: {
                toolId: itemId,
                status:
                  item.type === "commandExecution" &&
                  item.exitCode != null &&
                  item.exitCode !== 0
                    ? "failed"
                    : status(item.status),
                output: this.filter(
                  item.type === "commandExecution"
                    ? string(item.aggregatedOutput ?? "")
                    : canonicalJson(item.result ?? item.error ?? null),
                ),
              },
            },
          ],
          fidelity,
        );
      }
    } else if (item.type === "fileChange") {
      const changes = z
        .array(z.object({ path: z.string(), diff: z.string() }))
        .parse(item.changes);
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!,
          changeId = id(`${item.id}/${i}`),
          payload = {
            changeId,
            path: this.filter(change.path),
            patch: this.filter(change.diff),
          };
        await this.emit(
          `${key}/change/${i}/proposed`,
          [{ kind: "file.change.proposed", payload }],
          fidelity,
        );
        if (completed && item.status === "completed")
          await this.emit(
            `${key}/change/${i}/applied`,
            [{ kind: "file.change.applied", payload }],
            fidelity,
          );
      }
    } else if (
      completed &&
      !["reasoning", "contextCompaction"].includes(item.type)
    )
      await this.emit(
        key + "/unsupported",
        [
          {
            kind: "capture.gap",
            payload: {
              reason: this.filter(`Unsupported Codex item type: ${item.type}`),
              recoveredState: false,
            },
          },
        ],
        fidelity,
      );
  }
}
