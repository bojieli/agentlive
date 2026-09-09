import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventContent } from "@agentlive/protocol";
const time = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isFinite(new Date(value).getTime()));
const comments = z.object({
  type: z.literal("artifact-comment-monitor"),
  v: z.literal(1),
  artifacts: z.record(
    z.string().min(1).max(500),
    z.strictObject({
      state: z.string().max(500),
      title: z.string(),
      writtenAtMs: time,
    }),
  ),
});
const reactions = z.object({
  type: z.literal("artifact-autoreact-ledger"),
  v: z.literal(1),
  artifacts: z.record(
    z.string().min(1).max(500),
    z.strictObject({
      everBaselined: z.boolean(),
      everHadThreads: z.boolean(),
      interrupted: z.boolean().optional(),
      savedAt: time,
      stampHighWater: z.null(),
      threads: z.array(z.never()).length(0),
      turnTimestamps: z.array(z.never()).length(0),
    }),
  ),
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Snapshot observations, not commands to activate monitoring or send reactions. */
export function claudeMonitors(
  input: unknown,
  filter: (value: string) => string,
) {
  const monitor = comments.safeParse(input);
  const ledger = reactions.safeParse(input);
  const result: { key: string; timestamp: string; content: EventContent }[] =
    [];
  if (monitor.success) {
    for (const [id, value] of Object.entries(monitor.data.artifacts).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
      const monitorId = hash("claude-comment-monitor/" + id);
      result.push({
        key: monitorId,
        timestamp: new Date(value.writtenAtMs).toISOString(),
        content: {
          kind: "monitor.updated",
          payload: {
            monitorId,
            monitorType: "artifact-comments",
            sourceReference: "claude:artifact/" + hash(id),
            title: filter(value.title).slice(0, 500),
            status: value.state === "armed" ? "armed" : "unknown",
            nativeState: filter(value.state).slice(0, 500),
          },
        },
      });
    }
  } else if (ledger.success) {
    for (const [id, value] of Object.entries(ledger.data.artifacts).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
      const monitorId = hash("claude-autoreact-monitor/" + id);
      result.push({
        key: monitorId,
        timestamp: new Date(value.savedAt).toISOString(),
        content: {
          kind: "monitor.updated",
          payload: {
            monitorId,
            monitorType: "artifact-autoreact",
            sourceReference: "claude:artifact/" + hash(id),
            title: "Artifact automatic reactions",
            status: value.interrupted ? "interrupted" : "unknown",
            baselineEstablished: value.everBaselined,
            hasObservedThreads: value.everHadThreads,
          },
        },
      });
    }
  } else return undefined;
  return result;
}
