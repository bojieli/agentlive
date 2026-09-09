import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import { readJsonlSource, type SourceCursor } from "./jsonl.js";
import { chunkContent } from "./chunks.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const object = z.record(z.string(), z.unknown());
export interface KimiHistoryManifest {
  nativeSessionId: string;
  agentId: string;
  createdAt: string;
  boundary: SourceCursor;
  records: number;
}
export async function inspectKimiHistory(
  path: string,
  signal?: AbortSignal,
  identity?: { nativeSessionId: string; agentId: string },
): Promise<KimiHistoryManifest> {
  const components = resolve(path).split(/[\\/]/);
  const session = components.findLast((part) =>
    /^session_[a-zA-Z0-9_-]+$/.test(part),
  );
  const nativeSessionId = identity?.nativeSessionId ?? session?.slice(8);
  const agentId = identity?.agentId ?? basename(dirname(path));
  if (!nativeSessionId || !agentId)
    throw new Error("Kimi history needs a native session and agent identity");
  let createdAt: string | undefined,
    boundary: SourceCursor | undefined,
    records = 0;
  for await (const record of readJsonlSource(path, {
    tail: "parse",
    ...(signal ? { signal } : {}),
  })) {
    const row = object.parse(record.value);
    z.string().parse(row.type);
    records++;
    boundary = record.cursor;
    if (row.type === "metadata") {
      z.enum(["1.4", "1.5"]).parse(row.protocol_version);
      const timestamp = new Date(
        z.number().int().nonnegative().parse(row.created_at),
      ).toISOString();
      if (createdAt && createdAt !== timestamp)
        throw new Error("Kimi history has conflicting metadata");
      createdAt = timestamp;
    }
  }
  if (!createdAt || !boundary)
    throw new Error("Kimi history lacks wire metadata");
  return { nativeSessionId, agentId, createdAt, boundary, records };
}
export type KimiCaptureSink = Pick<PublisherJournal, "identity" | "capture">;
export async function captureKimiHistory(
  path: string,
  manifest: KimiHistoryManifest,
  sink: KimiCaptureSink,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
) {
  if (
    sink.identity.nativeAgent !== "kimi" ||
    sink.identity.nativeSessionId !== manifest.nativeSessionId
  )
    throw new Error("Kimi source does not match publisher binding");
  const report = {
    records: 0,
    messages: 0,
    tools: 0,
    omittedReasoning: 0,
    unsupported: {} as Record<string, number>,
  };
  const agentId = hash(`${manifest.nativeSessionId}/${manifest.agentId}`),
    tools = new Set<string>();
  const goals = new Map<
    string,
    Extract<EventContent, { kind: "goal.updated" }>["payload"]
  >();
  let elapsedMs = 0;
  const filter = (text: string) => {
    const redactor = new StreamingRedactor(secrets);
    return redactor.push(text) + redactor.finish();
  };
  const emit = async (
    key: string,
    content: EventContent[],
    timestamp: string,
  ) => {
    elapsedMs = Math.max(
      elapsedMs,
      Date.parse(timestamp) - Date.parse(manifest.createdAt),
    );
    const parts = content.flatMap(chunkContent);
    for (let index = 0; index < parts.length; index++)
      await sink.capture({
        sourceKey: `kimi/${agentId}/${key}/${index}`,
        content: [parts[index]!],
        observedAt: timestamp,
        clockSegmentId: `history_${agentId}`,
        elapsedMs,
        fidelity: "reconstructed",
        adapterState: { version: 1, agent: "kimi" },
      });
  };
  const knownAgents = new Set([manifest.agentId]);
  const ensureAgent = async (nativeId: string, timestamp: string) => {
    const nodeId = hash(`${manifest.nativeSessionId}/${nativeId}`);
    if (!knownAgents.has(nativeId)) {
      await emit(
        `agent/${nodeId}`,
        [
          {
            kind: "agent.updated",
            payload: {
              agentId: nodeId,
              nativeSessionId: manifest.nativeSessionId,
              name: filter(nativeId),
              status: "unknown",
            },
          },
        ],
        timestamp,
      );
      knownAgents.add(nativeId);
    }
    return nodeId;
  };
  const gap = async (key: string, type: string, timestamp: string) => {
    report.unsupported[type] = (report.unsupported[type] ?? 0) + 1;
    await emit(
      key,
      [
        {
          kind: "capture.gap",
          payload: {
            reason: filter(`Unsupported Kimi source object: ${type}`),
            recoveredState: false,
          },
        },
      ],
      timestamp,
    );
  };
  const message = async (
    key: string,
    role: "user" | "assistant" | "system",
    text: string,
    timestamp: string,
  ) => {
    const messageId = hash(`${agentId}/${key}`);
    await emit(
      key,
      [
        { kind: "message.started", payload: { messageId, role, agentId } },
        {
          kind: "message.reconciled",
          payload: { messageId, text: filter(text) },
        },
        { kind: "message.completed", payload: { messageId } },
      ],
      timestamp,
    );
    report.messages++;
  };
  for await (const _ of readJsonlSource(path, {
    after: manifest.boundary,
    through: manifest.boundary.offset,
    ...(signal ? { signal } : {}),
  }))
    void _;
  await emit(
    "session",
    [
      {
        kind: "session.started",
        payload: {
          agent: "kimi",
          nativeSessionId: manifest.nativeSessionId,
          title: "Kimi Code session",
        },
      },
      {
        kind: "agent.updated",
        payload: {
          agentId,
          nativeSessionId: manifest.nativeSessionId,
          name: filter(manifest.agentId),
          status: "unknown",
        },
      },
    ],
    manifest.createdAt,
  );
  for await (const record of readJsonlSource(path, {
    through: manifest.boundary.offset,
    tail: "parse",
    ...(signal ? { signal } : {}),
  })) {
    const row = object.parse(record.value);
    report.records++;
    const timestamp =
      row.time === undefined
        ? manifest.createdAt
        : new Date(
            z.number().int().nonnegative().parse(row.time),
          ).toISOString();
    const key = record.cursor.prefixHash;
    if (row.type === "context.append_message") {
      const native = object.parse(row.message);
      const role = z.enum(["user", "assistant", "system"]).parse(native.role);
      const parts = z.array(object).parse(native.content);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        if (part.type === "text")
          await message(
            `${key}/${index}`,
            role,
            z.string().parse(part.text),
            timestamp,
          );
        else if (part.type === "think") report.omittedReasoning++;
        else
          await gap(
            `${key}/${index}`,
            `message/${String(part.type)}`,
            timestamp,
          );
      }
    } else if (row.type === "context.append_loop_event") {
      const event = object.parse(row.event),
        eventKey = typeof event.uuid === "string" ? hash(event.uuid) : key;
      if (event.type === "content.part") {
        const part = object.parse(event.part);
        if (part.type === "text")
          await message(
            eventKey,
            "assistant",
            z.string().parse(part.text),
            timestamp,
          );
        else if (part.type === "think") report.omittedReasoning++;
        else await gap(eventKey, `content/${String(part.type)}`, timestamp);
      } else if (event.type === "tool.call") {
        const toolId = hash(`${agentId}/${z.string().parse(event.toolCallId)}`);
        if (tools.has(toolId))
          await emit(
            eventKey,
            [
              {
                kind: "tool.arguments.ready",
                payload: {
                  toolId,
                  input: filter(canonicalJson(event.args ?? null)),
                },
              },
            ],
            timestamp,
          );
        else {
          await emit(
            `tool/${toolId}/start`,
            [
              {
                kind: "tool.started",
                payload: {
                  toolId,
                  agentId,
                  name: filter(z.string().max(200).parse(event.name)),
                  input: filter(canonicalJson(event.args ?? null)),
                },
              },
            ],
            timestamp,
          );
          tools.add(toolId);
          report.tools++;
        }
      } else if (event.type === "tool.result") {
        const toolId = hash(`${agentId}/${z.string().parse(event.toolCallId)}`),
          result = object.parse(event.result);
        if (!tools.has(toolId)) {
          await emit(
            `tool/${toolId}/missing`,
            [
              {
                kind: "tool.started",
                payload: {
                  toolId,
                  agentId,
                  name: "unavailable source tool",
                  input: "",
                },
              },
            ],
            timestamp,
          );
          tools.add(toolId);
          await gap(
            eventKey + "/missing",
            "tool_result/missing_call",
            timestamp,
          );
        }
        let output: string;
        if (typeof result.output === "string") output = result.output;
        else {
          const text: string[] = [];
          for (const [index, part] of z
            .array(object)
            .parse(result.output)
            .entries()) {
            if (part.type === "text") text.push(z.string().parse(part.text));
            else
              await gap(
                `${eventKey}/output/${index}`,
                `tool_result/${String(part.type)}`,
                timestamp,
              );
          }
          output = text.join("\n");
        }
        await emit(
          eventKey,
          [
            {
              kind: "tool.completed",
              payload: {
                toolId,
                status: result.isError === true ? "failed" : "completed",
                output: filter(
                  output +
                    (typeof result.note === "string" ? `\n${result.note}` : ""),
                ),
              },
            },
          ],
          timestamp,
        );
        if (result.truncated === true)
          await gap(
            eventKey + "/truncated",
            "tool_result/source_truncated",
            timestamp,
          );
      } else if (!["step.begin", "step.end"].includes(String(event.type)))
        await gap(eventKey, String(event.type), timestamp);
    } else if (row.type === "task.started" || row.type === "task.terminated") {
      const agentId = await ensureAgent(
        typeof row.agentId === "string" ? row.agentId : manifest.agentId,
        timestamp,
      );
      const info = object.parse(row.info);
      const taskId = hash(`${agentId}/task/${z.string().parse(info.taskId)}`);
      const taskType = ["process", "agent", "question"].includes(
        String(info.kind),
      )
        ? (info.kind as "process" | "agent" | "question")
        : "unknown";
      const taskStatus =
        info.status === "killed"
          ? "interrupted"
          : ["running", "completed", "failed", "timed_out"].includes(
                String(info.status),
              )
            ? (info.status as "running" | "completed" | "failed" | "timed_out")
            : "unknown";
      const description = filter(z.string().parse(info.description));
      if (!tools.has(taskId)) {
        await emit(
          `task/${taskId}/start`,
          [
            {
              kind: "tool.started",
              payload: {
                toolId: taskId,
                agentId,
                name: `background/${taskType}`,
                input: filter(
                  typeof info.command === "string" ? info.command : description,
                ),
              },
            },
          ],
          timestamp,
        );
        tools.add(taskId);
        report.tools++;
      }
      await emit(
        key + "/task",
        [
          {
            kind: "task.updated",
            payload: {
              taskId,
              agentId,
              toolId: taskId,
              taskType,
              status: taskStatus,
              description,
              ...(typeof info.detached === "boolean"
                ? { detached: info.detached }
                : {}),
            },
          },
        ],
        timestamp,
      );
      if (row.type === "task.terminated")
        await emit(
          key + "/output",
          [
            {
              kind: "tool.completed",
              payload: {
                toolId: taskId,
                status:
                  taskStatus === "completed"
                    ? "completed"
                    : taskStatus === "interrupted"
                      ? "interrupted"
                      : "failed",
                output: filter(
                  typeof row.outputTail === "string"
                    ? `[Retained background-task output tail]\n${row.outputTail}`
                    : "",
                ),
              },
            },
          ],
          timestamp,
        );
    } else if (
      row.type === "goal.create" ||
      row.type === "goal.update" ||
      row.type === "goal.clear"
    ) {
      const owner =
        typeof row.agentId === "string" ? row.agentId : manifest.agentId;
      const agentId = await ensureAgent(owner, timestamp);
      if (row.type === "goal.create")
        goals.set(owner, {
          goalId: hash(`${agentId}/goal/${z.string().parse(row.goalId)}`),
          agentId,
          objective: filter(z.string().parse(row.objective)),
          status: "active",
          ...(typeof row.completionCriterion === "string"
            ? { completionCriterion: filter(row.completionCriterion) }
            : {}),
        });
      const goal = goals.get(owner);
      if (!goal) await gap(key, "goal/missing_create", timestamp);
      else {
        const next = { ...goal };
        if (row.type === "goal.clear") next.status = "cleared";
        else if (row.type === "goal.update") {
          if (row.status !== undefined)
            next.status = ["active", "paused", "complete"].includes(
              String(row.status),
            )
              ? (row.status as "active" | "paused" | "complete")
              : "unknown";
          if (typeof row.reason === "string") next.reason = filter(row.reason);
          for (const metric of [
            "tokensUsed",
            "turnsUsed",
            "wallClockMs",
          ] as const)
            if (row[metric] !== undefined)
              next[metric] = z
                .number()
                .finite()
                .nonnegative()
                .parse(row[metric]);
        }
        await emit(
          key + "/goal",
          [{ kind: "goal.updated", payload: next }],
          timestamp,
        );
        if (next.status === "cleared") goals.delete(owner);
        else goals.set(owner, next);
      }
    } else if (
      ![
        "metadata",
        "config.update",
        "tools.set_active_tools",
        "permission.set_mode",
        "llm.tools_snapshot",
        "llm.request",
        "usage.record",
        "turn.prompt",
        "turn.steer",
      ].includes(String(row.type))
    )
      await gap(key, String(row.type), timestamp);
  }
  for await (const _ of readJsonlSource(path, {
    after: manifest.boundary,
    through: manifest.boundary.offset,
    ...(signal ? { signal } : {}),
  }))
    void _;
  return report;
}
