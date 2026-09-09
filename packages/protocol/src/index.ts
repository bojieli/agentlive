import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_EVENT_BYTES = 1024 * 1024;
export const sequenceSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export const cursorSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(32 * 1024 * 1024);
const clock = z.number().finite().nonnegative();
const agentSchema = z.enum([
  "claude",
  "codex",
  "kimi",
  "opencode",
  "synthetic",
]);
const event = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.strictObject({ kind: z.literal(kind), payload: z.strictObject(shape) });

export const attachmentSchema = z.strictObject({
  artifactId: idSchema,
  version: sequenceSchema,
  hash: hashSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  byteSize: cursorSchema,
  capturedAt: z.iso.datetime().optional(),
  sourceHash: hashSchema.optional(),
  provenance: z
    .enum(["live-capture", "historical-version", "current-file"])
    .optional(),
});

export const contentSchema = z.discriminatedUnion("kind", [
  event("session.started", {
    agent: agentSchema,
    nativeSessionId: idSchema,
    title: z.string().max(500),
  }),
  event("session.ended", { reason: text }),
  event("agent.updated", {
    agentId: idSchema,
    nativeSessionId: idSchema,
    parentAgentId: idSchema.optional(),
    name: z.string().max(500).optional(),
    status: z.enum(["active", "completed", "failed", "interrupted", "unknown"]),
  }),
  event("task.updated", {
    taskId: idSchema,
    agentId: idSchema.optional(),
    toolId: idSchema.optional(),
    taskType: z.enum(["process", "agent", "question", "unknown"]),
    status: z.enum([
      "running",
      "completed",
      "failed",
      "interrupted",
      "timed_out",
      "unknown",
    ]),
    description: text,
    detached: z.boolean().optional(),
  }),
  event("goal.updated", {
    goalId: idSchema,
    agentId: idSchema.optional(),
    objective: text,
    status: z.enum(["active", "paused", "complete", "cleared", "unknown"]),
    reason: text.optional(),
    completionCriterion: text.optional(),
    tokensUsed: cursorSchema.optional(),
    turnsUsed: cursorSchema.optional(),
    wallClockMs: clock.optional(),
  }),
  event("interaction.updated", {
    interactionId: idSchema,
    agentId: idSchema.optional(),
    toolId: idSchema.optional(),
    interactionType: z.enum(["approval", "question"]),
    status: z.enum(["pending", "resolved", "cancelled", "unknown"]),
    title: text,
    prompt: text,
    response: text.optional(),
    scope: text.optional(),
    questions: z
      .array(
        z.strictObject({
          question: text,
          header: text.optional(),
          options: z
            .array(
              z.strictObject({ label: text, description: text.optional() }),
            )
            .optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
  event("plan.updated", {
    planId: idSchema,
    agentId: idSchema.optional(),
    status: z.enum(["active", "inactive"]),
    version: sequenceSchema.optional(),
    sourceHash: hashSchema.optional(),
    byteSize: cursorSchema.optional(),
    sourceReference: text.optional(),
    attachment: z
      .strictObject({ artifactId: idSchema, version: sequenceSchema })
      .optional(),
  }),
  event("turn.started", { turnId: idSchema }),
  event("turn.ended", {
    turnId: idSchema,
    status: z.enum(["completed", "failed", "interrupted"]),
  }),
  event("message.started", {
    messageId: idSchema,
    role: z.enum(["user", "assistant", "system"]),
    agentId: idSchema.optional(),
  }),
  event("message.text.append", { messageId: idSchema, text }),
  event("message.reconciled", { messageId: idSchema, text }),
  event("message.completed", { messageId: idSchema }),
  event("text.replacement.started", {
    replacementId: idSchema,
    target: z.enum(["message", "tool.input", "tool.output", "change.patch"]),
    targetId: idSchema,
  }),
  event("text.replacement.chunk", {
    replacementId: idSchema,
    index: cursorSchema,
    text,
  }),
  event("text.replacement.completed", {
    replacementId: idSchema,
    parts: sequenceSchema,
  }),
  event("tool.started", {
    toolId: idSchema,
    name: z.string().max(200),
    agentId: idSchema.optional(),
    input: text,
  }),
  event("tool.arguments.append", { toolId: idSchema, text }),
  event("tool.arguments.ready", { toolId: idSchema, input: text }),
  event("tool.output.append", { toolId: idSchema, text }),
  event("tool.completed", {
    toolId: idSchema,
    status: z.enum(["completed", "failed", "interrupted"]),
    output: text.optional(),
  }),
  event("file.change.proposed", {
    changeId: idSchema,
    path: text,
    patch: text,
  }),
  event("file.change.applied", { changeId: idSchema, path: text, patch: text }),
  event("attachment.pending", { artifactId: idSchema, filename: text }),
  event("attachment.available", { attachment: attachmentSchema }),
  event("attachment.unavailable", { artifactId: idSchema, reason: text }),
  event("reference.resolved", {
    messageId: idSchema,
    sourceReference: text,
    artifactId: idSchema,
    version: sequenceSchema,
  }),
  event("capture.gap", { reason: text, recoveredState: z.boolean() }),
  event("capture.clock", {
    segmentId: idSchema,
    wallAnchor: z.iso.datetime(),
    confidence: z.enum(["monotonic", "estimated", "unknown"]),
  }),
  event("recording.created", { title: z.string().max(500) }),
  event("recording.ended", {
    producerEpoch: idSchema,
    throughProducerSeq: cursorSchema,
  }),
  event("recording.reopened", {}),
  event("publisher.epoch.changed", { producerEpoch: idSchema, reason: text }),
]);
export type EventContent = z.infer<typeof contentSchema>;

export const publishedEventSchema = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    streamId: idSchema,
    producerEpoch: idSchema,
    producerSeq: sequenceSchema,
    observedAt: z.iso.datetime(),
    clockSegmentId: idSchema,
    elapsedMs: clock,
    fidelity: z.enum(["delta", "line-batch", "block", "reconstructed"]),
    source: z.strictObject({
      agent: agentSchema,
      sessionId: idSchema,
      eventId: z.string().max(500).optional(),
    }),
    content: contentSchema,
  })
  .superRefine((value, context) => {
    if (
      value.content.kind.startsWith("recording.") ||
      value.content.kind === "publisher.epoch.changed"
    ) {
      context.addIssue({
        code: "custom",
        message: "Recording lifecycle belongs to the server",
        path: ["content", "kind"],
      });
    }
  });
export type PublishedEvent = z.infer<typeof publishedEventSchema>;

export const storedEventSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  serverSeq: sequenceSchema,
  receivedAt: z.iso.datetime(),
  timelineMs: clock,
  content: contentSchema,
  origin: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("publisher"),
      event: publishedEventSchema,
      digest: hashSchema,
    }),
    z.strictObject({ type: z.literal("server"), operationId: idSchema }),
  ]),
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

export const errorCodes = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "stream_gone",
  "sequence_gap",
  "event_conflict",
  "stale_lease",
  "publisher_busy",
  "revision_changed",
  "cursor_invalid",
  "resync_required",
  "retry_later",
  "version_unsupported",
  "corrupt_storage",
  "storage_failed",
  "recording_ended",
  "precondition_failed",
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Stable JSON used for retry identities and checksums; rejects lossy JSON inputs. */
export function canonicalJson(value: unknown): string {
  const parents = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new TypeError("JSON nesting exceeds 64 levels");
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || parents.has(item))
      throw new TypeError("Value is not acyclic JSON");
    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new TypeError("Expected a plain JSON object");
    parents.add(item);
    try {
      if (Array.isArray(item)) {
        const values: string[] = [];
        for (let i = 0; i < item.length; i++)
          values.push(encode(item[i], depth + 1));
        return `[${values.join(",")}]`;
      }
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(",")}}`;
    } finally {
      parents.delete(item);
    }
  }
  return encode(value, 0);
}

const requestFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: idSchema,
};
export const publisherMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...requestFields,
    type: z.literal("resume"),
    streamId: idSchema,
    revision: idSchema,
    publisherId: idSchema,
    producerEpoch: idSchema,
    attempt: sequenceSchema,
  }),
  z.strictObject({
    ...requestFields,
    type: z.literal("batch"),
    events: z.array(publishedEventSchema).max(100),
  }),
  z.strictObject({ ...requestFields, type: z.literal("heartbeat") }),
]);
export const subscriberMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...requestFields,
    type: z.literal("subscribe"),
    streamId: idSchema,
    revision: idSchema,
    afterServerSeq: cursorSchema,
  }),
  z.strictObject({ ...requestFields, type: z.literal("unsubscribe") }),
  z.strictObject({ ...requestFields, type: z.literal("heartbeat") }),
]);
