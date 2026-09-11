import {
  openCodeFileEvents,
  type OpenCodeArtifactResolvers,
} from "./opencode-artifacts.js";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  idSchema,
  type EventContent,
} from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import { chunkContent } from "./chunks.js";
import { openCodeLineage } from "./opencode-lineage.js";
const object = z.record(z.string(), z.unknown());
const timeSchema = z.object({
  created: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative().optional(),
});
const exportSchema = z.object({
  info: z
    .object({ id: idSchema, parentID: idSchema.optional(), time: timeSchema })
    .passthrough(),
  messages: z.array(
    z.object({
      info: z
        .object({
          id: idSchema,
          sessionID: idSchema,
          role: z.enum(["user", "assistant"]),
          time: timeSchema,
        })
        .passthrough(),
      parts: z.array(
        z
          .object({
            id: idSchema,
            sessionID: idSchema,
            messageID: idSchema,
            type: z.string(),
          })
          .passthrough(),
      ),
    }),
  ),
});
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
/** Validate ownership and uniqueness for either native exports or server snapshots. */
export function parseOpenCodeSnapshot(input: unknown) {
  const data = exportSchema.parse(input);
  if (data.info.parentID === data.info.id)
    throw new Error("OpenCode session cannot be its own parent");
  const ids = new Set<string>();
  for (const message of data.messages) {
    if (message.info.sessionID !== data.info.id || ids.has(message.info.id))
      throw new Error("OpenCode export has conflicting message identities");
    ids.add(message.info.id);
    for (const part of message.parts) {
      if (
        part.sessionID !== data.info.id ||
        part.messageID !== message.info.id ||
        ids.has(part.id)
      )
        throw new Error("OpenCode export has conflicting part identities");
      ids.add(part.id);
    }
  }
  return data;
}
export type OpenCodeSnapshot = ReturnType<typeof parseOpenCodeSnapshot>;
/** OpenCode 1.18.30 SessionRevert.cleanup boundary semantics, applied without
 * changing the retained native snapshot or its historical capture identities. */
export function visibleOpenCodeSnapshot(
  snapshot: OpenCodeSnapshot,
): OpenCodeSnapshot {
  if (snapshot.info.revert === undefined || snapshot.info.revert === null)
    return snapshot;
  const revert = z
    .object({ messageID: idSchema, partID: idSchema.optional() })
    .parse(snapshot.info.revert);
  const index = snapshot.messages.findIndex(
    (message) => message.info.id === revert.messageID,
  );
  if (index < 0)
    throw new Error("OpenCode revert message is absent from snapshot");
  const messages = snapshot.messages.slice(0, index);
  if (revert.partID !== undefined) {
    const target = snapshot.messages[index]!;
    const partIndex = target.parts.findIndex(
      (part) => part.id === revert.partID,
    );
    if (partIndex < 0)
      throw new Error("OpenCode revert part is absent from target message");
    messages.push({ ...target, parts: target.parts.slice(0, partIndex) });
  }
  return { ...snapshot, messages };
}
async function readExport(path: string, signal?: AbortSignal) {
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n * 1024n)
      throw new Error(
        "OpenCode export must be a regular file within the 64 MiB import limit",
      );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset,
      );
      if (!bytesRead) throw new Error("OpenCode export changed during read");
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("OpenCode export changed during read");
    const data = parseOpenCodeSnapshot(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return {
      data,
      boundary: { offset: bytes.length, prefixHash: hash(bytes) },
    };
  } finally {
    await file.close();
  }
}
export interface OpenCodeHistoryManifest {
  nativeSessionId: string;
  parentNativeSessionId?: string;
  createdAt: string;
  boundary: { offset: number; prefixHash: string };
  records: number;
}
export async function inspectOpenCodeHistory(
  path: string,
  signal?: AbortSignal,
): Promise<OpenCodeHistoryManifest> {
  const { data, boundary } = await readExport(path, signal);
  return {
    nativeSessionId: data.info.id,
    ...(data.info.parentID
      ? { parentNativeSessionId: data.info.parentID }
      : {}),
    createdAt: new Date(data.info.time.created).toISOString(),
    boundary,
    records: data.messages.length,
  };
}
/** Read the exact export inspected before creating an import binding. */
export async function readOpenCodeImportSnapshot(
  path: string,
  manifest: OpenCodeHistoryManifest,
  signal?: AbortSignal,
) {
  const { data, boundary } = await readExport(path, signal);
  if (
    data.info.id !== manifest.nativeSessionId ||
    canonicalJson(boundary) !== canonicalJson(manifest.boundary)
  )
    throw new Error("OpenCode export changed since preflight");
  return data;
}
export type OpenCodeCaptureSink = Pick<
  PublisherJournal,
  "identity" | "capture"
>;
export async function captureOpenCodeHistory(
  path: string,
  manifest: OpenCodeHistoryManifest,
  sink: OpenCodeCaptureSink,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
  artifacts?: OpenCodeArtifactResolvers,
) {
  if (
    sink.identity.nativeAgent !== "opencode" ||
    sink.identity.nativeSessionId !== manifest.nativeSessionId
  )
    throw new Error("OpenCode source does not match publisher binding");
  const { data, boundary } = await readExport(path, signal);
  if (canonicalJson(boundary) !== canonicalJson(manifest.boundary))
    throw new Error("OpenCode export changed since preflight");
  const report = {
    records: data.messages.length,
    items: 0,
    omittedReasoning: 0,
    unavailableAttachments: 0,
    availableAttachments: 0,
    unsupported: {} as Record<string, number>,
  };
  const filter = (text: string) => {
    const redactor = new StreamingRedactor(secrets);
    return redactor.push(text) + redactor.finish();
  };
  let elapsedMs = 0;
  const emit = async (key: string, content: EventContent[], time: number) => {
    signal?.throwIfAborted();
    const observedAt = new Date(time).toISOString();
    elapsedMs = Math.max(elapsedMs, time - Date.parse(manifest.createdAt));
    for (const [index, event] of content.flatMap(chunkContent).entries())
      await sink.capture({
        sourceKey: `opencode/${key}/${index}`,
        content: [event],
        observedAt,
        clockSegmentId: `history_${hash(manifest.nativeSessionId)}`,
        elapsedMs,
        fidelity: "reconstructed",
        adapterState: { version: 1, agent: "opencode" },
      });
  };
  const gap = async (key: string, type: string, time: number) => {
    report.unsupported[type] = (report.unsupported[type] ?? 0) + 1;
    await emit(
      key,
      [
        {
          kind: "capture.gap",
          payload: {
            reason: filter(`Unsupported OpenCode source object: ${type}`),
            recoveredState: false,
          },
        },
      ],
      time,
    );
  };
  await emit(
    "session",
    [
      {
        kind: "session.started",
        payload: {
          agent: "opencode",
          nativeSessionId: manifest.nativeSessionId,
          title: "OpenCode session",
        },
      },
    ],
    data.info.time.created,
  );
  if (data.info.parentID)
    await emit(
      "session-lineage",
      openCodeLineage(data.info.id, data.info.parentID),
      data.info.time.created,
    );
  for (const message of data.messages) {
    const messageId = hash(message.info.id),
      time = message.info.time.created;
    await emit(
      `${messageId}/start`,
      [
        {
          kind: "message.started",
          payload: { messageId, role: message.info.role },
        },
      ],
      time,
    );
    const text: string[] = [];
    for (const part of message.parts) {
      report.items++;
      const key = hash(part.id);
      if (part.type === "text") {
        const value = z.string().parse(part.text);
        await emit(
          key,
          [
            {
              kind: "message.text.append",
              payload: {
                messageId,
                text: filter((text.length ? "\n" : "") + value),
              },
            },
          ],
          time,
        );
        text.push(value);
      } else if (part.type === "reasoning") report.omittedReasoning++;
      else if (part.type === "tool") {
        const state = object.parse(part.state),
          status = z
            .enum(["pending", "running", "completed", "error"])
            .parse(state.status);
        const timing = state.time === undefined ? {} : object.parse(state.time);
        const start = typeof timing.start === "number" ? timing.start : time;
        await emit(
          `${key}/start`,
          [
            {
              kind: "tool.started",
              payload: {
                toolId: key,
                name: filter(z.string().max(200).parse(part.tool)),
                input: filter(canonicalJson(state.input ?? null)),
              },
            },
          ],
          start,
        );
        if (status === "completed" || status === "error")
          await emit(
            `${key}/end`,
            [
              {
                kind: "tool.completed",
                payload: {
                  toolId: key,
                  status: status === "error" ? "failed" : "completed",
                  output: filter(
                    z
                      .string()
                      .parse(status === "error" ? state.error : state.output),
                  ),
                },
              },
            ],
            typeof timing.end === "number" ? timing.end : start,
          );
        else await gap(`${key}/unfinished`, `tool/${status}`, start);
        if (Array.isArray(state.attachments)) {
          for (const [index, value] of state.attachments.entries()) {
            const attachment = object.parse(value);
            if (
              (attachment.sessionID !== undefined &&
                attachment.sessionID !== manifest.nativeSessionId) ||
              (attachment.messageID !== undefined &&
                attachment.messageID !== message.info.id)
            )
              throw new Error(
                "OpenCode tool attachment has conflicting ownership",
              );
            const artifactId = hash(
              `${part.id}/attachment/${typeof attachment.id === "string" ? attachment.id : index}`,
            );
            const events = await openCodeFileEvents({
              part: attachment,
              artifactId,
              messageId,
              sourceScope: manifest.nativeSessionId,
              ...(artifacts ? { resolvers: artifacts } : {}),
              filter,
            });
            await emit(`${key}/attachment/${index}`, events, start);
            if (events.some((event) => event.kind === "attachment.available"))
              report.availableAttachments++;
            else report.unavailableAttachments++;
          }
        }
      } else if (part.type === "file") {
        const events = await openCodeFileEvents({
          part,
          artifactId: key,
          messageId,
          sourceScope: manifest.nativeSessionId,
          ...(artifacts ? { resolvers: artifacts } : {}),
          filter,
        });
        await emit(key, events, time);
        if (events.some((event) => event.kind === "attachment.available"))
          report.availableAttachments++;
        else report.unavailableAttachments++;
      } else if (!["step-start", "step-finish"].includes(part.type))
        await gap(key, part.type, time);
    }
    if (message.info.error) {
      const error = object.parse(message.info.error),
        detail =
          error.data && typeof error.data === "object"
            ? object.parse(error.data)
            : {};
      text.push(
        typeof detail.message === "string"
          ? detail.message
          : typeof error.message === "string"
            ? error.message
            : `OpenCode source error: ${typeof error.name === "string" ? error.name : "unknown"}`,
      );
    }
    await emit(
      `${messageId}/end`,
      [
        {
          kind: "message.reconciled",
          payload: { messageId, text: filter(text.join("\n")) },
        },
        { kind: "message.completed", payload: { messageId } },
      ],
      message.info.time.completed ?? time,
    );
  }
  return report;
}
