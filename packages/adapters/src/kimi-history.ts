import {
  nativeMediaEvents,
  type NativeMediaResolvers,
} from "./native-media.js";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import {
  readJsonlSource,
  type SourceCursor,
  type SourceRecord,
} from "./jsonl.js";
import type { FileArtifactResolver } from "./artifact-types.js";
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
  tail: "parse" | "defer" = "parse",
  through?: number,
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
    tail,
    ...(through === undefined ? {} : { through }),
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
  resolveArtifact?: FileArtifactResolver,
  options: { childLog?: boolean; mediaResolvers?: NativeMediaResolvers } = {},
) {
  const validate = async () => {
    for await (const _ of readJsonlSource(path, {
      after: manifest.boundary,
      through: manifest.boundary.offset,
      ...(signal ? { signal } : {}),
    }))
      void _;
  };
  await validate();
  const consumer = await createKimiHistoryConsumer(
    manifest,
    sink,
    secrets,
    resolveArtifact,
    options,
  );
  for await (const record of readJsonlSource(path, {
    through: manifest.boundary.offset,
    tail: "parse",
    ...(signal ? { signal } : {}),
  }))
    await consumer.accept(record);
  await validate();
  return consumer.report;
}
export async function createKimiHistoryConsumer(
  manifest: KimiHistoryManifest,
  sink: KimiCaptureSink,
  secrets: readonly string[] = [],
  resolveArtifact?: FileArtifactResolver,
  options: { childLog?: boolean; mediaResolvers?: NativeMediaResolvers } = {},
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
    availableAttachments: 0,
    unavailableAttachments: 0,
    unsupported: {} as Record<string, number>,
  };
  const agentId = hash(`${manifest.nativeSessionId}/${manifest.agentId}`),
    tools = new Set<string>();
  const goals = new Map<
    string,
    Extract<EventContent, { kind: "goal.updated" }>["payload"]
  >();
  type Interaction = Extract<
    EventContent,
    { kind: "interaction.updated" }
  >["payload"];
  type Plan = Extract<EventContent, { kind: "plan.updated" }>["payload"];
  const interactions = new Map<string, Interaction>();
  const approvalByTool = new Map<string, string>();
  const plans = new Map<string, Plan>();
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
  const media = async (
    key: string,
    role: "user" | "assistant" | "system",
    part: Record<string, unknown>,
    timestamp: string,
  ) => {
    const kind = (
      { image_url: "image", audio_url: "audio", video_url: "video" } as const
    )[String(part.type) as "image_url" | "audio_url" | "video_url"];
    if (!kind) return false;
    const payload = part[String(part.type)];
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { url?: unknown }).url !== "string"
    ) {
      await gap(key, `media/${String(part.type)}/invalid-url`, timestamp);
      return true;
    }
    const messageId = hash(`${agentId}/${key}`);
    const content = await nativeMediaEvents({
      url: (payload as { url: string }).url,
      mediaKind: kind,
      artifactId: messageId,
      messageId,
      sourceKey: `kimi-media/${agentId}/${key}`,
      nativeAgent: "kimi",
      ...(options.mediaResolvers ? { resolvers: options.mediaResolvers } : {}),
    });
    await emit(
      key,
      [
        { kind: "message.started", payload: { messageId, role, agentId } },
        ...content,
        { kind: "message.completed", payload: { messageId } },
      ],
      timestamp,
    );
    report.messages++;
    if (content.some((event) => event.kind === "attachment.available"))
      report.availableAttachments++;
    else report.unavailableAttachments++;
    return true;
  };
  await emit(
    "session",
    [
      ...(!options.childLog
        ? [
            {
              kind: "session.started",
              payload: {
                agent: "kimi",
                nativeSessionId: manifest.nativeSessionId,
                title: "Kimi Code session",
              },
            } as EventContent,
          ]
        : []),
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
  const accept = async (record: SourceRecord) => {
    const row = object.parse(record.value);
    z.string().parse(row.type);
    if (row.type === "metadata") {
      z.enum(["1.4", "1.5"]).parse(row.protocol_version);
      if (
        new Date(
          z.number().int().nonnegative().parse(row.created_at),
        ).toISOString() !== manifest.createdAt
      )
        throw new Error("Kimi history has conflicting metadata");
    }
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
        else if (!(await media(`${key}/${index}`, role, part, timestamp)))
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
        else if (!(await media(eventKey, "assistant", part, timestamp)))
          await gap(eventKey, `content/${String(part.type)}`, timestamp);
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
          // Kimi 1.5 may write a single content part (e.g. an image) instead of an array.
          const parts =
            result.output !== null &&
            typeof result.output === "object" &&
            !Array.isArray(result.output)
              ? [result.output]
              : result.output;
          for (const [index, part] of z.array(object).parse(parts).entries()) {
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
    } else if (row.type === "interaction.request") {
      const nativeId = z.string().parse(row.id),
        request = object.parse(row.request);
      const actor = await ensureAgent(
        typeof row.agentId === "string" ? row.agentId : manifest.agentId,
        timestamp,
      );
      const kind = z.enum(["approval", "question"]).parse(row.kind);
      const display =
        request.display && typeof request.display === "object"
          ? object.parse(request.display)
          : {};
      const toolCall =
        typeof row.toolCallId === "string"
          ? row.toolCallId
          : typeof request.toolCallId === "string"
            ? request.toolCallId
            : undefined;
      const interaction: Interaction = {
        interactionId: hash(`${agentId}/interaction/${nativeId}`),
        agentId: actor,
        interactionType: kind,
        status: "pending",
        title: filter(
          typeof request.toolName === "string"
            ? request.toolName
            : kind === "question"
              ? "Question"
              : "Approval",
        ),
        prompt: filter(
          [request.action, display.command, display.cwd]
            .filter((value) => typeof value === "string")
            .join("\n"),
        ),
        ...(toolCall ? { toolId: hash(`${actor}/${toolCall}`) } : {}),
      };
      if (kind === "question")
        interaction.questions = z
          .array(object)
          .parse(request.questions)
          .map((question) => ({
            question: filter(z.string().parse(question.question)),
            ...(typeof question.header === "string"
              ? { header: filter(question.header) }
              : {}),
            ...(Array.isArray(question.options)
              ? {
                  options: question.options.map((raw) => {
                    const option = object.parse(raw);
                    return {
                      label: filter(z.string().parse(option.label)),
                      ...(typeof option.description === "string"
                        ? { description: filter(option.description) }
                        : {}),
                    };
                  }),
                }
              : {}),
          }));
      interactions.set(nativeId, interaction);
      if (kind === "approval" && toolCall)
        approvalByTool.set(`${actor}/${toolCall}`, nativeId);
      await emit(
        key + "/interaction",
        [{ kind: "interaction.updated", payload: interaction }],
        timestamp,
      );
    } else if (row.type === "interaction.resolved") {
      const nativeId = z.string().parse(row.id),
        interaction = interactions.get(nativeId);
      if (!interaction)
        await gap(key, "interaction/missing_request", timestamp);
      else {
        const response = object.parse(row.response);
        const next: Interaction = {
          ...interaction,
          status: "resolved",
          response: filter(
            typeof response.decision === "string"
              ? response.decision
              : canonicalJson(response.answers ?? null),
          ),
          ...(typeof response.scope === "string"
            ? { scope: filter(response.scope) }
            : {}),
        };
        interactions.set(nativeId, next);
        await emit(
          key + "/interaction",
          [{ kind: "interaction.updated", payload: next }],
          timestamp,
        );
      }
    } else if (row.type === "permission.record_approval_result") {
      const actor = await ensureAgent(
          typeof row.agentId === "string" ? row.agentId : manifest.agentId,
          timestamp,
        ),
        toolCall = z.string().parse(row.toolCallId),
        result = object.parse(row.result);
      const nativeId =
        approvalByTool.get(`${actor}/${toolCall}`) ??
        `audit/${String(row.turnId)}/${toolCall}`;
      const previous = interactions.get(nativeId);
      const next: Interaction = {
        ...(previous ?? {
          interactionId: hash(`${agentId}/interaction/${nativeId}`),
          agentId: actor,
          toolId: hash(`${actor}/${toolCall}`),
          interactionType: "approval",
          title: filter(z.string().parse(row.toolName)),
          prompt: filter(z.string().parse(row.action)),
        }),
        status: "resolved",
        response: filter(z.string().parse(result.decision)),
        ...(typeof result.scope === "string"
          ? { scope: filter(result.scope) }
          : {}),
      };
      interactions.set(nativeId, next);
      await emit(
        key + "/approval",
        [{ kind: "interaction.updated", payload: next }],
        timestamp,
      );
    } else if (
      row.type === "plan_mode.enter" ||
      row.type === "plan.revision" ||
      row.type === "plan_mode.exit"
    ) {
      const owner =
          typeof row.agentId === "string" ? row.agentId : manifest.agentId,
        actor = await ensureAgent(owner, timestamp);
      if (row.type === "plan_mode.enter")
        plans.set(owner, {
          planId: hash(`${actor}/plan/${z.string().parse(row.id)}`),
          agentId: actor,
          status: "active",
        });
      const plan = plans.get(owner);
      if (!plan) await gap(key, "plan/missing_enter", timestamp);
      else {
        const next = { ...plan };
        if (row.type === "plan_mode.exit") next.status = "inactive";
        if (row.type === "plan.revision") {
          if (plan.planId !== hash(`${actor}/plan/${z.string().parse(row.id)}`))
            throw new Error("Plan revision belongs to another native plan");
          next.version = z.number().int().positive().parse(row.version);
          next.sourceHash = z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(row.sha256);
          next.byteSize = z.number().int().nonnegative().parse(row.bytes);
          const reference =
            typeof row.key === "string"
              ? row.key
              : typeof row.path === "string"
                ? row.path
                : undefined;
          if (reference !== undefined) next.sourceReference = filter(reference);
          else delete next.sourceReference;
          delete next.attachment;
          const artifactId = hash(`${next.planId}/revision/${next.version}`);
          const result =
            reference && resolveArtifact
              ? await resolveArtifact({
                  artifactId,
                  sourceKey: `kimi/plan/${next.planId}/${next.version}`,
                  path: reference,
                  historical: true,
                  expectedSourceHash: next.sourceHash,
                })
              : { reason: "Plan revision file requires artifact resolution" };
          await emit(
            key + "/artifact-pending",
            [
              {
                kind: "attachment.pending",
                payload: { artifactId, filename: "plan.md" },
              },
            ],
            timestamp,
          );
          if ("attachment" in result) {
            next.attachment = {
              artifactId,
              version: result.attachment.version,
            };
            await emit(
              key + "/artifact",
              [
                {
                  kind: "attachment.available",
                  payload: { attachment: result.attachment },
                },
              ],
              timestamp,
            );
            report.availableAttachments++;
          } else {
            await emit(
              key + "/artifact",
              [
                {
                  kind: "attachment.unavailable",
                  payload: { artifactId, reason: filter(result.reason) },
                },
              ],
              timestamp,
            );
            report.unavailableAttachments++;
          }
        }
        plans.set(owner, next);
        await emit(
          key + "/plan",
          [{ kind: "plan.updated", payload: next }],
          timestamp,
        );
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
  };
  return { accept, report };
}
