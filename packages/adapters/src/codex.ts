import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import { chunkContent } from "./chunks.js";
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
export type CodexCaptureSink = Pick<
  PublisherJournal,
  "identity" | "capture" | "capturedThrough"
>;
export class CodexCapture {
  private readonly segment = randomUUID();
  private readonly started = performance.now();
  private sequence = 0;
  private historicalTime: string | undefined;
  private historyElapsed = 0;
  private sourceAgentId: string | undefined;
  private readonly filters = new Map<string, StreamingRedactor>();
  private readonly secrets: readonly string[];
  constructor(
    private readonly journal: CodexCaptureSink,
    secrets: readonly string[] = [],
    private readonly historyAnchor?: string,
  ) {
    if (journal.identity.nativeAgent !== "codex")
      throw new Error("Codex capture requires a Codex journal");
    if (
      historyAnchor !== undefined &&
      !Number.isFinite(Date.parse(historyAnchor))
    )
      throw new Error("Invalid history time anchor");
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
    const historical = this.historicalTime;
    if (historical)
      this.historyElapsed = Math.max(
        this.historyElapsed,
        Date.parse(historical) - Date.parse(this.historyAnchor!),
      );
    const capturePart = (sourceKey: string, part: EventContent[]) =>
      this.journal.capture({
        sourceKey,
        content: part,
        observedAt: historical ?? new Date().toISOString(),
        clockSegmentId: historical
          ? `history_${id(this.journal.identity.nativeSessionId)}`
          : this.segment,
        elapsedMs: historical
          ? this.historyElapsed
          : performance.now() - this.started,
        fidelity: historical ? "reconstructed" : fidelity,
        adapterState: { version: 1, agent: "codex" },
      });
    const expanded = content.flatMap(chunkContent);
    if (
      expanded.length === content.length &&
      expanded.every((item, index) => item === content[index])
    )
      await capturePart(key, content);
    else {
      await capturePart(key, []);
      for (let index = 0; index < expanded.length; index++)
        await capturePart(`${key}/chunk/${index}`, [expanded[index]!]);
    }
  }
  async acceptHistorical(
    notification: RpcNotification,
    observedAt: string,
  ): Promise<void> {
    if (!this.historyAnchor || !Number.isFinite(Date.parse(observedAt)))
      throw new Error("Historical capture requires a valid time anchor");
    if (this.historicalTime)
      throw new Error("Historical capture must be serialized");
    this.historicalTime = new Date(observedAt).toISOString();
    try {
      if (notification.method === "session/begin") await this.begin();
      else await this.accept(notification);
    } finally {
      this.historicalTime = undefined;
    }
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
    this.sourceAgentId =
      typeof p.agentThreadId === "string" &&
      p.agentThreadId !== this.journal.identity.nativeSessionId
        ? id(p.agentThreadId)
        : undefined;
    if (method === "source/unsupported") {
      await this.emit(
        `unsupported/${id(string(p.sourceKey))}`,
        [
          {
            kind: "capture.gap",
            payload: {
              reason: this.filter(
                `Unsupported native source record: ${string(p.sourceType)}`,
              ),
              recoveredState: false,
            },
          },
        ],
        "reconstructed",
      );
      return;
    }
    if (method === "agent/metadata") {
      const threadId = string(p.nativeThreadId);
      await this.emit(`agent/${id(threadId)}/metadata`, [
        {
          kind: "agent.updated",
          payload: {
            agentId: id(threadId),
            nativeSessionId: threadId,
            status: "unknown",
            ...(typeof p.parentThreadId === "string"
              ? { parentAgentId: id(p.parentThreadId) }
              : {}),
            ...(typeof p.name === "string"
              ? { name: this.filter(p.name).slice(0, 500) }
              : {}),
          },
        },
      ]);
      return;
    }
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
    this.sourceAgentId = undefined;
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
        [
          {
            kind: "message.started",
            payload: {
              messageId: itemId,
              role,
              ...(this.sourceAgentId ? { agentId: this.sourceAgentId } : {}),
            },
          },
        ],
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
        if (item.type === "userMessage") {
          const parts = z
            .array(z.object({ type: z.string() }))
            .parse(item.content);
          for (let index = 0; index < parts.length; index++)
            if (parts[index]!.type !== "text") {
              const artifactId = id(`${item.id}/content/${index}`);
              await this.emit(
                `${key}/content/${index}/unavailable`,
                [
                  {
                    kind: "attachment.pending",
                    payload: {
                      artifactId,
                      filename: parts[index]!.type.includes("image")
                        ? "image"
                        : "attachment",
                    },
                  },
                  {
                    kind: "attachment.unavailable",
                    payload: {
                      artifactId,
                      reason: this.filter(
                        `Native ${parts[index]!.type} content requires artifact resolution`,
                      ),
                    },
                  },
                ],
                fidelity,
              );
            }
        }
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
              ...(this.sourceAgentId ? { agentId: this.sourceAgentId } : {}),
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
    } else if (item.type === "subAgentActivity") {
      const child = string(item.agentThreadId);
      await this.emit(
        key + "/agent",
        [
          {
            kind: "agent.updated",
            payload: {
              agentId: id(child),
              nativeSessionId: child,
              parentAgentId: id(this.journal.identity.nativeSessionId),
              name: this.filter(string(item.agentPath ?? "Subagent")).slice(
                0,
                500,
              ),
              status: "unknown",
            },
          },
        ],
        fidelity,
      );
    } else if (item.type === "collabAgentToolCall") {
      await this.emit(
        key + "/start",
        [
          {
            kind: "tool.started",
            payload: {
              toolId: itemId,
              name: `collaboration/${this.filter(string(item.tool))}`.slice(
                0,
                200,
              ),
              input: this.filter(
                canonicalJson({
                  senderThreadId: item.senderThreadId ?? null,
                  receiverThreadIds: item.receiverThreadIds ?? [],
                  prompt: item.prompt ?? null,
                }),
              ),
            },
          },
        ],
        fidelity,
      );
      if (completed)
        await this.emit(
          key + "/end",
          [
            {
              kind: "tool.completed",
              payload: {
                toolId: itemId,
                status: status(item.status),
                output: this.filter(canonicalJson(item.agentsStates ?? {})),
              },
            },
          ],
          fidelity,
        );
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
