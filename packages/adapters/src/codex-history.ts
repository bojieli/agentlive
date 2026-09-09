import { createHash } from "node:crypto";
import { z } from "zod";
import { readJsonlSource, type SourceCursor } from "./jsonl.js";
import { CodexCapture } from "./codex.js";
import type { RpcNotification } from "./stdio.js";
const object = z.record(z.string(), z.unknown());
const rowSchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  payload: object,
});
export interface CodexHistoryManifest {
  nativeSessionId: string;
  nativeThreadIds: string[];
  createdAt: string;
  cliVersion: string;
  boundary: SourceCursor;
  records: number;
  structuredItems: number;
}
/** Preflight a frozen prefix without publishing vendor instructions or raw envelopes. */
export async function inspectCodexHistory(
  path: string,
  signal?: AbortSignal,
): Promise<CodexHistoryManifest> {
  const nativeThreadIds = new Set<string>();
  let logicalSessionId: string | undefined;
  let firstTimestamp: string | undefined;
  let metadata:
    { id: string; timestamp: string; cli_version: string } | undefined;
  let boundary: SourceCursor | undefined,
    records = 0,
    structuredItems = 0;
  for await (const record of readJsonlSource(path, {
    tail: "parse",
    ...(signal ? { signal } : {}),
  })) {
    const row = rowSchema.parse(record.value);
    records++;
    boundary = record.cursor;
    if (row.type === "session_meta") {
      const current = z
        .object({
          id: z.string(),
          session_id: z.string().optional(),
          timestamp: z.iso.datetime(),
          cli_version: z.string(),
        })
        .parse(row.payload);
      const logical = current.session_id ?? current.id;
      nativeThreadIds.add(current.id);
      if (logicalSessionId && logicalSessionId !== logical)
        throw new Error("Source contains multiple native session identities");
      logicalSessionId = logical;
      if (
        !firstTimestamp ||
        Date.parse(current.timestamp) < Date.parse(firstTimestamp)
      )
        firstTimestamp = current.timestamp;
      metadata = current;
    }
    if (row.type === "event_msg" && row.payload.type === "item_completed")
      structuredItems++;
  }
  if (!metadata || !boundary) throw new Error("Not a Codex session rollout");
  return {
    nativeSessionId: logicalSessionId!,
    nativeThreadIds: [...nativeThreadIds],
    createdAt: firstTimestamp!,
    cliVersion: metadata.cli_version,
    boundary,
    records,
    structuredItems,
  };
}
const textParts = (raw: unknown) =>
  z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(raw)
    .filter((x) => x.type === "Text" || x.type === "text")
    .map((x) => x.text ?? "")
    .join("");
const shellWord = (word: string) =>
  /^[a-zA-Z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
/** Translate persisted completed-item fields to the same public item shape used live. */
export function codexHistoryItem(raw: unknown): Record<string, unknown> {
  const item = z
    .object({ id: z.string(), type: z.string() })
    .passthrough()
    .parse(raw);
  switch (item.type) {
    case "UserMessage":
      return { id: item.id, type: "userMessage", content: item.content };
    case "AgentMessage":
      return {
        id: item.id,
        type: "agentMessage",
        text: textParts(item.content),
      };
    case "CommandExecution":
      return {
        id: item.id,
        type: "commandExecution",
        command: z
          .array(z.string())
          .parse(item.command)
          .map(shellWord)
          .join(" "),
        status: item.status,
        aggregatedOutput: item.aggregated_output ?? "",
        exitCode: item.exit_code,
      };
    case "McpToolCall":
      return {
        id: item.id,
        type: "mcpToolCall",
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        result: item.result ?? null,
      };
    case "ImageView":
      return { id: item.id, type: "imageView", path: item.path };
    case "FileChange":
      return {
        id: item.id,
        type: "fileChange",
        status: item.status,
        changes: Object.entries(object.parse(item.changes)).map(
          ([path, value]) => {
            const change = object.parse(value);
            return {
              path,
              diff:
                typeof change.unified_diff === "string"
                  ? change.unified_diff
                  : typeof change.content === "string"
                    ? change.content
                    : "",
            };
          },
        ),
      };
    case "SubAgentActivity":
      return {
        id: item.id,
        type: "subAgentActivity",
        agentThreadId: item.agent_thread_id,
        agentPath: item.agent_path,
        kind: item.kind,
      };
    case "CollabAgentToolCall":
      return {
        id: item.id,
        type: "collabAgentToolCall",
        tool: item.tool,
        status: item.status,
        senderThreadId: item.sender_thread_id,
        receiverThreadIds: item.receiver_thread_ids,
        agentsStates: item.agents_states,
        prompt: item.prompt,
      };
    case "Reasoning":
      return { id: item.id, type: "reasoning" };
    case "ContextCompaction":
      return { id: item.id, type: "contextCompaction" };
    default:
      return { id: item.id, type: item.type };
  }
}
export interface CodexHistoryReport {
  records: number;
  items: number;
  omittedInternalRecords: number;
  artifacts: { available: number; unavailable: number; currentFile: number };
  unsupportedItemTypes: Record<string, number>;
  unsupportedRecordTypes: Record<string, number>;
  boundary: SourceCursor;
}
/** Replay a validated source prefix through live normalization; immutable source keys deduplicate retries. */
export async function captureCodexHistory(
  path: string,
  manifest: CodexHistoryManifest,
  capture: CodexCapture,
  signal?: AbortSignal,
): Promise<CodexHistoryReport> {
  // Verify the preflight prefix before emitting any effect. A replaced source cannot be silently adopted.
  for await (const _ of readJsonlSource(path, {
    after: manifest.boundary,
    through: manifest.boundary.offset,
    ...(signal ? { signal } : {}),
  }))
    void _;
  const report: CodexHistoryReport = {
    records: 0,
    items: 0,
    omittedInternalRecords: 0,
    artifacts: { available: 0, unavailable: 0, currentFile: 0 },
    unsupportedItemTypes: {},
    unsupportedRecordTypes: {},
    boundary: manifest.boundary,
  };
  const legacyCalls = new Map<string, Record<string, unknown>>();
  let activeTurnId: unknown;
  await capture.acceptHistorical(
    { method: "session/begin", params: {} },
    manifest.createdAt,
  );
  for await (const record of readJsonlSource(path, {
    through: manifest.boundary.offset,
    tail: "parse",
    ...(signal ? { signal } : {}),
  })) {
    const row = rowSchema.parse(record.value);
    report.records++;
    const p = row.payload;
    let notification: RpcNotification | undefined;
    if (row.type === "session_meta")
      notification = {
        method: "agent/metadata",
        params: {
          threadId: manifest.nativeSessionId,
          nativeThreadId: p.id,
          parentThreadId: p.parent_thread_id,
          name: p.agent_path ?? p.agent_nickname,
        },
      };
    if (row.type === "event_msg") {
      if (p.type === "task_started") activeTurnId = p.turn_id;
      if (p.type === "task_started")
        notification = {
          method: "turn/started",
          params: {
            threadId: manifest.nativeSessionId,
            turn: { id: p.turn_id, status: "inProgress" },
          },
        };
      else if (p.type === "task_complete" || p.type === "turn_aborted")
        notification = {
          method: "turn/completed",
          params: {
            threadId: manifest.nativeSessionId,
            turn: {
              id: p.turn_id ?? activeTurnId,
              status: p.type === "turn_aborted" ? "interrupted" : "completed",
            },
          },
        };
      else if (p.type === "item_completed") {
        const item = codexHistoryItem(p.item);
        report.items++;
        if (item.type === "userMessage")
          for (const part of z
            .array(z.object({ type: z.string() }))
            .parse(item.content))
            if (!["text", "local_image", "localImage"].includes(part.type)) {
              const type = `userMessage/content/${part.type}`;
              report.unsupportedItemTypes[type] =
                (report.unsupportedItemTypes[type] ?? 0) + 1;
            }
        if (
          ![
            "userMessage",
            "agentMessage",
            "commandExecution",
            "mcpToolCall",
            "fileChange",
            "reasoning",
            "contextCompaction",
            "subAgentActivity",
            "collabAgentToolCall",
            "imageView",
          ].includes(String(item.type))
        )
          report.unsupportedItemTypes[String(item.type)] =
            (report.unsupportedItemTypes[String(item.type)] ?? 0) + 1;
        notification = {
          method: "item/completed",
          params: {
            threadId: manifest.nativeSessionId,
            agentThreadId: p.thread_id,
            item,
          },
        };
      }
    }
    if (!manifest.structuredItems && row.type === "response_item") {
      if (
        p.type === "message" &&
        (p.role === "user" || p.role === "assistant")
      ) {
        const itemId =
          typeof p.id === "string"
            ? p.id
            : `legacy_${createHash("sha256").update(record.cursor.prefixHash).digest("hex")}`;
        const parts = z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .parse(p.content)
          .filter(
            (part) =>
              part.type === "input_text" ||
              part.type === "output_text" ||
              part.type === "text",
          );
        const item =
          p.role === "user"
            ? {
                id: itemId,
                type: "userMessage",
                content: parts.map((part) => ({
                  type: "text",
                  text: part.text ?? "",
                })),
              }
            : {
                id: itemId,
                type: "agentMessage",
                text: parts.map((part) => part.text ?? "").join(""),
              };
        notification = {
          method: "item/completed",
          params: { threadId: manifest.nativeSessionId, item },
        };
        report.items++;
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        const callId = z.string().parse(p.call_id);
        if (legacyCalls.size >= 1024)
          throw new Error("Legacy source has too many pending tool calls");
        const item = {
          id: callId,
          type: "mcpToolCall",
          server: "codex",
          tool: z.string().parse(p.name),
          arguments: p.arguments ?? p.input ?? "",
          status: "inProgress",
          result: null,
        };
        legacyCalls.set(callId, item);
        notification = {
          method: "item/started",
          params: { threadId: manifest.nativeSessionId, item },
        };
      } else if (
        p.type === "function_call_output" ||
        p.type === "custom_tool_call_output"
      ) {
        const callId = z.string().parse(p.call_id),
          previous = legacyCalls.get(callId);
        if (!previous)
          throw new Error("Legacy tool output has no retained call");
        legacyCalls.delete(callId);
        notification = {
          method: "item/completed",
          params: {
            threadId: manifest.nativeSessionId,
            item: {
              ...previous,
              status: "completed",
              result: p.output ?? null,
            },
          },
        };
        report.items++;
      }
    }
    if (
      !notification &&
      row.type === "event_msg" &&
      !["token_count", "thread_settings_applied"].includes(String(p.type))
    ) {
      const type = String(p.type);
      report.unsupportedRecordTypes[type] =
        (report.unsupportedRecordTypes[type] ?? 0) + 1;
      notification = {
        method: "source/unsupported",
        params: {
          threadId: manifest.nativeSessionId,
          sourceKey: record.cursor.prefixHash,
          sourceType: type,
        },
      };
    }
    if (notification)
      await capture.acceptHistorical(notification, row.timestamp);
    else report.omittedInternalRecords++;
  }
  for await (const _ of readJsonlSource(path, {
    after: manifest.boundary,
    through: manifest.boundary.offset,
    ...(signal ? { signal } : {}),
  }))
    void _;
  report.artifacts = { ...capture.artifactReport };
  return report;
}
