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
export const snapshotContentReferenceSchema = z.strictObject({
  hash: hashSchema,
  byteSize: z.number().int().min(1).max(1048576),
  units: z.number().int().min(0).max(67108864),
});
const contentHash = /^[a-f0-9]{64}$/;
/** Same accept/reject result and output as
 * `snapshotContentReferenceSchema.safeParse(value)`. Exact plain descriptors,
 * which traversal reads by the million, are copied without the generic schema
 * machinery; every other input is decided by the schema itself. */
export function parseContentReference(
  value: unknown,
): z.infer<typeof snapshotContentReferenceSchema> | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const ref = value as Record<string, unknown>;
    const keys = Object.keys(ref);
    const { hash, byteSize, units } = ref;
    if (
      keys.length === 3 &&
      keys.every(
        (key) => key === "hash" || key === "byteSize" || key === "units",
      ) &&
      typeof hash === "string" &&
      contentHash.test(hash) &&
      typeof byteSize === "number" &&
      Number.isSafeInteger(byteSize) &&
      byteSize >= 1 &&
      byteSize <= 1048576 &&
      typeof units === "number" &&
      Number.isSafeInteger(units) &&
      units >= 0 &&
      units <= 67108864
    )
      return { hash, byteSize, units };
  }
  const parsed = snapshotContentReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export const snapshotDescriptorSchema = z.strictObject({
  format: z.literal("agentlive.paged-state").optional(),
  activity: snapshotContentReferenceSchema
    .extend({ units: z.number().int().min(0).max(32768) })
    .optional(),
  serverSeq: cursorSchema,
  timelineMs: z.number().finite().nonnegative(),
  ref: snapshotContentReferenceSchema.extend({
    units: z.number().int().min(0).max(32768),
  }),
});
export const snapshotLeaseTokenSchema = hashSchema;
export const snapshotLeaseSchema = z.strictObject({
  token: snapshotLeaseTokenSchema,
  expiresAt: cursorSchema,
  snapshot: snapshotDescriptorSchema.extend({
    format: z.literal("agentlive.paged-state"),
    activity: snapshotContentReferenceSchema.extend({
      units: z.number().int().min(0).max(32768),
    }),
  }),
});
export const snapshotLeaseSelectionSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  lease: snapshotLeaseSchema.nullable(),
});
export type SnapshotLease = z.infer<typeof snapshotLeaseSchema>;
export const snapshotSelectionSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  snapshot: snapshotDescriptorSchema.nullable(),
});
export type SnapshotDescriptor = z.infer<typeof snapshotDescriptorSchema>;
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

/** Content-free counts describing captured work that the native source never finished.
 * Both versions have one reason: the importer froze a native source at a boundary where
 * normalized work was still active or text was withheld by redaction. Version 1 counts
 * messages, tools and withheld text; version 2 adds running tasks, interactions awaiting
 * a response and attachments still pending. Version 1 remains valid for old recordings. */
const completenessNoticeV1Shape = {
  version: z.literal(1),
  reason: z.enum(["frozen-native-source"]),
  unfinishedMessages: cursorSchema,
  unfinishedTools: cursorSchema,
  withheldTextMessages: cursorSchema,
};
const completenessNoticeV2Shape = {
  ...completenessNoticeV1Shape,
  version: z.literal(2),
  runningTasks: cursorSchema,
  pendingInteractions: cursorSchema,
  pendingAttachments: cursorSchema,
};
export const completenessNoticeSchema = z.discriminatedUnion("version", [
  z.strictObject(completenessNoticeV1Shape),
  z.strictObject(completenessNoticeV2Shape),
]);
export type CompletenessNotice = z.infer<typeof completenessNoticeSchema>;
/** Newest payload version written by native imports that are not pinned to an older one. */
export const COMPLETENESS_NOTICE_VERSION = 2;
/** Reduced form: the notice plus the server sequence that recorded it. */
export const reducedCompletenessNoticeSchema = z.discriminatedUnion("version", [
  z.strictObject({ ...completenessNoticeV1Shape, at: sequenceSchema }),
  z.strictObject({ ...completenessNoticeV2Shape, at: sequenceSchema }),
]);
export type ReducedCompletenessNotice = z.infer<
  typeof reducedCompletenessNoticeSchema
>;
/** Shared deterministic transition: the latest notice applies until the recording reopens,
 * because continued capture may finish or reconcile the counted work. */
export function reduceCompletenessNotice(
  current: ReducedCompletenessNotice | undefined,
  event: { serverSeq: number; content: { kind: string; payload: unknown } },
): ReducedCompletenessNotice | undefined {
  if (event.content.kind === "capture.completeness")
    return reducedCompletenessNoticeSchema.parse({
      ...(event.content.payload as CompletenessNotice),
      at: event.serverSeq,
    });
  if (event.content.kind === "recording.reopened") return undefined;
  return current;
}

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
  event("monitor.updated", {
    monitorId: idSchema,
    monitorType: z.enum(["artifact-comments", "artifact-autoreact"]),
    sourceReference: z.string().max(1024),
    title: z.string().max(500),
    status: z.enum(["armed", "interrupted", "unknown"]),
    nativeState: z.string().max(500).optional(),
    baselineEstablished: z.boolean().optional(),
    hasObservedThreads: z.boolean().optional(),
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
    status: z.enum(["active", "inactive", "unknown"]),
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
  event("object.visibility", {
    objectType: z.enum(["message", "tool", "attachment"]),
    objectId: idSchema,
    visible: z.boolean(),
  }),
  event("message.started", {
    messageId: idSchema,
    role: z.enum(["user", "assistant", "system"]),
    agentId: idSchema.optional(),
  }),
  event("message.text.append", { messageId: idSchema, text }),
  event("message.reconciled", { messageId: idSchema, text }),
  event("message.completed", { messageId: idSchema }),
  event("message.reopened", { messageId: idSchema }),
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
  event("tool.reopened", { toolId: idSchema }),
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
  z.strictObject({
    kind: z.literal("capture.completeness"),
    payload: completenessNoticeSchema,
  }),
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

/** Owner-declared replacement lineage; disposition records intent, not deletion proof. */
export const migrationOriginSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  sourceStreamId: idSchema,
  sourceRevision: idSchema,
  externalSource: z
    .strictObject({
      serverOrigin: z
        .string()
        .max(2048)
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) && url.origin === value
            );
          } catch {
            return false;
          }
        }, "Expected an HTTP(S) server origin"),
      verification: z.literal("owner-declared"),
    })
    .optional(),
  sourceConverterVersion: z.string().min(1).max(200),
  targetConverterVersion: z.string().min(1).max(200),
  requestedSourceDisposition: z.enum(["retain", "remove"]),
});
export type MigrationOrigin = z.infer<typeof migrationOriginSchema>;

/** Immediate archive-import source; inherited projection lineage remains separate. */
export const archiveServerOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && url.origin === value;
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) server origin");
export const archiveOriginSchema = z.strictObject({
  serverOrigin: archiveServerOriginSchema.optional(),
  streamId: idSchema,
  revision: idSchema,
  throughServerSeq: cursorSchema,
});
/** Portable recording envelope; deliberately excludes server/publisher secrets. */
export const archiveManifestSchema = z.strictObject({
  format: z.literal("agentlive.recording"),
  version: z.literal(1),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  reducerVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  recording: z.strictObject({
    serverOrigin: archiveServerOriginSchema.optional(),
    streamId: idSchema,
    revision: idSchema,
    title: z.string().max(500),
    createdAt: z.iso.datetime(),
    throughServerSeq: cursorSchema,
    timelineMs: clock,
    lifecycle: z.enum(["open", "ended"]),
  }),
  provenance: z.strictObject({
    migrationOrigin: migrationOriginSchema.optional(),
    archiveOrigin: archiveOriginSchema.optional(),
    agent: agentSchema.nullable(),
    sourceVersion: z.string().max(200).nullable(),
    adapterVersion: z.string().max(200).nullable(),
    capabilities: z.array(z.string().max(200)).max(128),
    completeness: z.enum(["captured-prefix", "ended-recording"]),
    gapCount: cursorSchema,
    /** Effective `capture.completeness` notice at the frozen boundary; omitted when none. */
    completenessNotice: reducedCompletenessNoticeSchema.optional(),
  }),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^(events\.jsonl|attachments\/[a-f0-9]{64})$/),
        byteSize: cursorSchema,
        hash: hashSchema,
      }),
    )
    .min(1)
    .max(100000),
});
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

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
  /** A hosted per-account quota rejects the write; not retryable until usage drops. */
  "quota_exceeded",
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

export {
  TextContent,
  validateTextReference,
  CONTENT_PAGE_UNITS,
  type TextReference,
  type TextContentBackend,
} from "./text-content.js";

export {
  ARTIFACT_BUNDLE_MEDIA_TYPE,
  ARTIFACT_BUNDLE_MAX_BYTES,
  ARTIFACT_BUNDLE_MAX_CONTENT_BYTES,
  ARTIFACT_BUNDLE_MAX_FILES,
  artifactBundlePathSchema,
  artifactBundleManifestSchema,
  artifactBundleHash,
  decodeArtifactBundle,
  type ArtifactBundleManifest,
} from "./artifact-bundle.js";
