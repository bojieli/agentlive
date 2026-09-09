import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, type EventContent } from "@agentlive/protocol";
import {
  PublisherJournal,
  StreamingRedactor,
  type InlineArtifactCapture,
  type CapturedAttachment,
} from "@agentlive/publisher";
import {
  readJsonlSource,
  type SourceCursor,
  type SourceRecord,
} from "./jsonl.js";
import { claudeMonitors } from "./claude-monitors.js";
import { claudeFileAttachment } from "./claude-file-attachments.js";
import { chunkContent } from "./chunks.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const rowSchema = z
  .object({
    type: z.string(),
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    uuid: z.string().optional(),
  })
  .passthrough();
const object = z.record(z.string(), z.unknown());
export interface ClaudeHistoryManifest {
  nativeSessionId: string;
  createdAt: string;
  boundary: SourceCursor;
  records: number;
}
export async function inspectClaudeHistory(
  path: string,
  signal?: AbortSignal,
  tail: "parse" | "defer" = "parse",
): Promise<ClaudeHistoryManifest> {
  let nativeSessionId: string | undefined,
    createdAt: string | undefined,
    boundary: SourceCursor | undefined,
    records = 0;
  for await (const record of readJsonlSource(path, {
    tail,
    ...(signal ? { signal } : {}),
  })) {
    const row = rowSchema.parse(record.value);
    records++;
    boundary = record.cursor;
    if (row.sessionId) {
      if (nativeSessionId && nativeSessionId !== row.sessionId)
        throw new Error("Claude source contains multiple session identities");
      nativeSessionId = row.sessionId;
    }
    const timestamps = [
      ...(row.timestamp ? [row.timestamp] : []),
      ...(["artifact-comment-monitor", "artifact-autoreact-ledger"].includes(
        row.type,
      )
        ? (claudeMonitors(row, (value) => value) ?? []).map(
            (value) => value.timestamp,
          )
        : []),
    ];
    for (const timestamp of timestamps)
      if (
        Number.isFinite(Date.parse(timestamp)) &&
        (!createdAt || Date.parse(timestamp) < Date.parse(createdAt))
      )
        createdAt = new Date(timestamp).toISOString();
  }
  if (!nativeSessionId || !createdAt || !boundary)
    throw new Error("Claude source lacks session identity or timestamp");
  return { nativeSessionId, createdAt, boundary, records };
}
export type ClaudeCaptureSink = Pick<PublisherJournal, "identity" | "capture">;
export async function captureClaudeHistory(
  path: string,
  manifest: ClaudeHistoryManifest,
  sink: ClaudeCaptureSink,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
  resolveInline?: (input: InlineArtifactCapture) => Promise<CapturedAttachment>,
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
  const consumer = await createClaudeHistoryConsumer(
    manifest,
    sink,
    secrets,
    resolveInline,
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
export async function createClaudeHistoryConsumer(
  manifest: ClaudeHistoryManifest,
  sink: ClaudeCaptureSink,
  secrets: readonly string[] = [],
  resolveInline?: (input: InlineArtifactCapture) => Promise<CapturedAttachment>,
) {
  if (
    sink.identity.nativeAgent !== "claude" ||
    sink.identity.nativeSessionId !== manifest.nativeSessionId
  )
    throw new Error("Claude source does not match publisher binding");
  const report = {
    records: 0,
    messages: 0,
    tools: 0,
    monitors: 0,
    unavailableAttachments: 0,
    availableAttachments: 0,
    omittedReasoning: 0,
    unsupported: {} as Record<string, number>,
  };
  const filter = (text: string) => {
    const redactor = new StreamingRedactor(secrets);
    return redactor.push(text) + redactor.finish();
  };
  const tools = new Set<string>();
  let elapsedMs = 0;
  const emit = async (
    sourceKey: string,
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
        sourceKey: `claude/${sourceKey}/${index}`,
        content: [parts[index]!],
        observedAt: timestamp,
        clockSegmentId: `history_${hash(manifest.nativeSessionId)}`,
        elapsedMs,
        fidelity: "reconstructed",
        adapterState: { version: 1, agent: "claude" },
      });
  };
  const unsupported = async (key: string, type: string, timestamp: string) => {
    report.unsupported[type] = (report.unsupported[type] ?? 0) + 1;
    await emit(
      key,
      [
        {
          kind: "capture.gap",
          payload: {
            reason: filter(`Unsupported Claude source object: ${type}`),
            recoveredState: false,
          },
        },
      ],
      timestamp,
    );
  };
  await emit(
    "session",
    [
      {
        kind: "session.started",
        payload: {
          agent: "claude",
          nativeSessionId: manifest.nativeSessionId,
          title: "Claude Code session",
        },
      },
    ],
    manifest.createdAt,
  );
  const accept = async (record: SourceRecord) => {
    const row = rowSchema.parse(record.value);
    if (row.sessionId && row.sessionId !== manifest.nativeSessionId)
      throw new Error("Claude source contains multiple session identities");
    report.records++;
    const key = hash(row.uuid ?? record.cursor.prefixHash);
    const timestamp =
      row.timestamp && Number.isFinite(Date.parse(row.timestamp))
        ? new Date(row.timestamp).toISOString()
        : manifest.createdAt;
    if (row.type === "user" || row.type === "assistant") {
      const message = object.parse(row.message);
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : z.array(object).parse(message.content);
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!,
          blockKey = `${key}/${index}`,
          messageId = hash(blockKey);
        if (block.type === "text") {
          await emit(
            blockKey,
            [
              {
                kind: "message.started",
                payload: { messageId, role: row.type },
              },
              {
                kind: "message.reconciled",
                payload: {
                  messageId,
                  text: filter(z.string().parse(block.text)),
                },
              },
              { kind: "message.completed", payload: { messageId } },
            ],
            timestamp,
          );
          report.messages++;
        } else if (block.type === "tool_use") {
          const toolId = hash(z.string().parse(block.id));
          if (tools.has(toolId)) {
            await emit(
              blockKey + "/arguments",
              [
                {
                  kind: "tool.arguments.ready",
                  payload: {
                    toolId,
                    input: filter(canonicalJson(block.input ?? null)),
                  },
                },
              ],
              timestamp,
            );
            continue;
          }
          tools.add(toolId);
          await emit(
            `tool/${toolId}/start`,
            [
              {
                kind: "tool.started",
                payload: {
                  toolId,
                  name: filter(z.string().max(200).parse(block.name)),
                  input: filter(canonicalJson(block.input ?? null)),
                },
              },
            ],
            timestamp,
          );
          report.tools++;
        } else if (block.type === "tool_result") {
          const toolId = hash(z.string().parse(block.tool_use_id));
          if (!tools.has(toolId)) {
            await emit(
              `tool/${toolId}/missing`,
              [
                {
                  kind: "tool.started",
                  payload: {
                    toolId,
                    name: "unavailable source tool",
                    input: "",
                  },
                },
              ],
              timestamp,
            );
            await unsupported(
              `${blockKey}/missing`,
              "tool_result/missing_call",
              timestamp,
            );
            tools.add(toolId);
          }
          let output = "";
          if (typeof block.content === "string") output = block.content;
          else if (Array.isArray(block.content)) {
            const text: string[] = [];
            for (
              let partIndex = 0;
              partIndex < block.content.length;
              partIndex++
            ) {
              const part = object.parse(block.content[partIndex]);
              if (part.type === "text" && typeof part.text === "string")
                text.push(part.text);
              else
                await unsupported(
                  `${blockKey}/part/${partIndex}`,
                  `tool_result/${String(part.type)}`,
                  timestamp,
                );
            }
            output = text.join("\n");
          } else if (block.content != null)
            await unsupported(
              blockKey + "/content",
              "tool_result/unknown_content",
              timestamp,
            );
          await emit(
            blockKey,
            [
              {
                kind: "tool.completed",
                payload: {
                  toolId,
                  status: block.is_error === true ? "failed" : "completed",
                  output: filter(output),
                },
              },
            ],
            timestamp,
          );
        } else if (
          block.type === "thinking" ||
          block.type === "redacted_thinking"
        )
          report.omittedReasoning++;
        else if (block.type === "image" || block.type === "document") {
          const nativeSource =
            block.source && typeof block.source === "object"
              ? object.parse(block.source)
              : {};
          let attachment: CapturedAttachment | undefined;
          const mediaType =
            typeof nativeSource.media_type === "string"
              ? nativeSource.media_type
              : "";
          const extensions: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
            "application/pdf": "pdf",
            "text/plain": "txt",
            "image/svg+xml": "svg",
          };
          if (
            resolveInline &&
            nativeSource.type === "base64" &&
            typeof nativeSource.data === "string" &&
            extensions[mediaType]
          ) {
            const encoded = nativeSource.data;
            if (
              encoded.length <= 32 * 1024 * 1024 &&
              encoded.length % 4 === 0 &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
            ) {
              const bytes = Buffer.from(encoded, "base64");
              if (bytes.toString("base64") === encoded)
                attachment = await resolveInline({
                  artifactId: messageId,
                  sourceKey: `claude/${blockKey}`,
                  bytes,
                  filename: `${String(block.type)}.${extensions[mediaType]}`,
                  mediaType,
                  text:
                    mediaType === "text/plain" || mediaType === "image/svg+xml",
                  historical: true,
                });
            }
          }
          const content: EventContent[] = [
            {
              kind: "attachment.pending",
              payload: { artifactId: messageId, filename: String(block.type) },
            },
          ];
          if (attachment) {
            content.push(
              {
                kind: "message.started",
                payload: { messageId, role: row.type },
              },
              { kind: "attachment.available", payload: { attachment } },
              {
                kind: "reference.resolved",
                payload: {
                  messageId,
                  sourceReference: `claude:attachment/${messageId}`,
                  artifactId: messageId,
                  version: attachment.version,
                },
              },
              { kind: "message.completed", payload: { messageId } },
            );
            report.availableAttachments++;
          } else {
            content.push({
              kind: "attachment.unavailable",
              payload: {
                artifactId: messageId,
                reason:
                  "Claude native attachment encoding or media type requires source conversion",
              },
            });
            report.unavailableAttachments++;
          }
          await emit(blockKey, content, timestamp);
        } else
          await unsupported(
            blockKey,
            `message/${String(block.type)}`,
            timestamp,
          );
      }
    } else if (
      row.type === "artifact-comment-monitor" ||
      row.type === "artifact-autoreact-ledger"
    ) {
      const observations = claudeMonitors(row, filter);
      if (!observations) await unsupported(key, row.type, timestamp);
      else
        for (const observation of observations) {
          await emit(
            key + "/" + observation.key,
            [observation.content],
            observation.timestamp,
          );
          report.monitors++;
        }
    } else if (row.type === "attachment") {
      const converted = await claudeFileAttachment(
        row.attachment,
        key,
        filter,
        resolveInline,
      );
      if (converted) {
        await emit(key, converted.content, timestamp);
        report.messages++;
        if (converted.available) report.availableAttachments++;
        else report.unavailableAttachments++;
      } else await unsupported(key, "attachment", timestamp);
    } else if (
      row.type === "system" &&
      (typeof row.content === "string" ||
        (row.error && typeof row.error === "object"))
    ) {
      const error =
        row.error && typeof row.error === "object"
          ? object.parse(row.error)
          : {};
      const nested =
        error.error && typeof error.error === "object"
          ? object.parse(error.error)
          : {};
      const description =
        typeof row.content === "string"
          ? row.content
          : typeof error.message === "string"
            ? error.message
            : typeof nested.message === "string"
              ? nested.message
              : "API error (details unavailable)";
      await emit(
        key,
        [
          {
            kind: "message.started",
            payload: { messageId: key, role: "system" },
          },
          {
            kind: "message.reconciled",
            payload: {
              messageId: key,
              text: filter(
                `${String(row.subtype ?? "system")}: ${description}`,
              ),
            },
          },
          { kind: "message.completed", payload: { messageId: key } },
        ],
        timestamp,
      );
      report.messages++;
    } else if (
      [
        "mode",
        "permission-mode",
        "last-prompt",
        "ai-title",
        "cost-state",
        "bridge-session",
        "atis-latch",
      ].includes(row.type)
    ) {
      // Local session bookkeeping; no conversation content is forwarded.
    } else
      await unsupported(
        key,
        `${row.type}${typeof row.subtype === "string" ? `/${row.subtype}` : ""}`,
        timestamp,
      );
  };
  return { accept, report };
}
