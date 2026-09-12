import { constants } from "node:fs";
import type { WriteBarrier } from "./write-barrier.js";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson } from "@agentlive/storage";
import { canonicalJson, idSchema, ProtocolError } from "@agentlive/protocol";
export const reportInputSchema = z.strictObject({
  operationId: idSchema,
  category: z.enum(["privacy", "harmful", "spam", "other"]),
  details: z.string().trim().min(1).max(1000),
});
export const reportDecisionSchema = z.strictObject({
  operationId: idSchema,
  action: z.enum(["dismiss", "remove"]),
  revision: idSchema,
  note: z.string().trim().min(1).max(500),
});
const reportSchema = reportInputSchema.extend({
  id: idSchema,
  streamId: idSchema,
  revision: idSchema,
  reporterId: idSchema.optional(),
  createdAt: z.number().int().nonnegative().safe(),
  status: z.enum(["open", "removing", "dismissed", "removed"]),
  decision: reportDecisionSchema.optional(),
  reviewRevision: idSchema.optional(),
  reconciliations: z
    .array(
      z.strictObject({
        previousRevision: idSchema,
        revision: idSchema,
        restoredAt: z.number().int().nonnegative().safe(),
        previousDecision: reportDecisionSchema.optional(),
      }),
    )
    .max(32)
    .optional(),
  resolvedAt: z.number().int().nonnegative().safe().optional(),
});
type Report = z.infer<typeof reportSchema>;
/**
 * Anyone who can read a public recording can file a report, so the intake is
 * shared by strangers. These bounds keep one recording's flood from consuming
 * the whole queue, and keep already reviewed reports from consuming any of it.
 */
const OPEN_LIMIT = 500;
const OPEN_PER_STREAM = 16;
const LEDGER_LIMIT = 1000;
const resolved = (report: Report) =>
  report.status === "dismissed" || report.status === "removed";
/** Private operator ledger. Caller owns the exclusive server lock for its lifetime. */
export class Reports {
  private entries = new Map<string, Report>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private failed = false;
  private window = 0;
  private submitted = 0;
  /** Reviewed reports dropped to keep the ledger bounded; reported to operators. */
  private dropped = 0;
  /** Online backup admission gate for ledger mutations. */
  private barrier: WriteBarrier | undefined;
  private constructor(private readonly path: string) {}
  static async open(path: string, barrier?: WriteBarrier) {
    const reports = new Reports(path);
    reports.barrier = barrier;
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reports;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 8 * 1024 * 1024 ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("Invalid report ledger");
      const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length)
        throw new Error("Report ledger exceeds limit");
      const data = z
        .strictObject({
          version: z.literal(1),
          reports: z.array(reportSchema).max(LEDGER_LIMIT),
          droppedReviewed: z.number().int().nonnegative().safe().optional(),
        })
        .parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, length),
            ),
          ),
        );
      const operations = new Set<string>();
      for (const report of data.reports) {
        if (
          reports.entries.has(report.id) ||
          operations.has(report.operationId)
        )
          throw new Error("Duplicate report identity");
        operations.add(report.operationId);
        reports.entries.set(report.id, report);
      }
      reports.dropped = data.droppedReviewed ?? 0;
      return reports;
    } finally {
      await file.close();
    }
  }
  private serial<T>(work: () => Promise<T>, mutation = true) {
    if (this.pending >= 32)
      return Promise.reject(
        new ProtocolError("retry_later", "Report queue is full"),
      );
    this.pending++;
    const enqueue = () => {
      const task = this.queue.then(() => {
        if (this.failed)
          throw new ProtocolError(
            "storage_failed",
            "Report storage must be reopened",
          );
        return work();
      });
      this.queue = task
        .catch(() => {})
        .finally(() => {
          this.pending--;
        });
      return task;
    };
    return mutation && this.barrier ? this.barrier.shared(enqueue) : enqueue();
  }
  private async save(next: Map<string, Report>) {
    const saved = {
      version: 1,
      reports: [...next.values()],
      ...(this.dropped ? { droppedReviewed: this.dropped } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(saved)) > 8 * 1024 * 1024)
      throw new ProtocolError("retry_later", "Report ledger capacity reached");
    try {
      await atomicJson(this.path, saved);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.entries = next;
  }
  submit(
    raw: z.infer<typeof reportInputSchema>,
    streamId: string,
    revision: string,
    reporterId?: string,
  ) {
    const input = reportInputSchema.parse(raw);
    idSchema.parse(streamId);
    idSchema.parse(revision);
    if (reporterId !== undefined) idSchema.parse(reporterId);
    return this.serial(async () => {
      const identity = {
        ...input,
        streamId,
        revision,
        ...(reporterId === undefined ? {} : { reporterId }),
      };
      const existing = [...this.entries.values()].find(
        (row) => row.operationId === input.operationId,
      );
      if (existing) {
        const {
          id,
          createdAt,
          status,
          resolvedAt,
          decision,
          reviewRevision,
          reconciliations,
          ...previous
        } = existing;
        if (canonicalJson(previous) !== canonicalJson(identity))
          throw new ProtocolError(
            "event_conflict",
            "Report operation was reused",
          );
        return { reportId: id, receivedAt: createdAt };
      }
      const now = Date.now();
      if (now - this.window >= 60000) {
        this.window = now;
        this.submitted = 0;
      }
      const open = [...this.entries.values()].filter((row) => !resolved(row));
      if (
        open.filter((row) => row.streamId === streamId).length >=
        OPEN_PER_STREAM
      )
        throw new ProtocolError(
          "retry_later",
          "Reports already awaiting review for this recording",
        );
      if (this.submitted >= 32 || open.length >= OPEN_LIMIT)
        throw new ProtocolError(
          "retry_later",
          "Report intake capacity reached",
        );
      this.submitted++;
      const next = new Map(this.entries);
      // Reviewed reports are kept as the operator's record, but they never keep a
      // new report out: the oldest of them make room, and the count of dropped
      // ones is durable so the trim is visible.
      let dropped = 0;
      for (const row of next.values()) {
        if (next.size < LEDGER_LIMIT) break;
        if (!resolved(row)) continue;
        next.delete(row.id);
        dropped++;
      }
      if (next.size >= LEDGER_LIMIT)
        throw new ProtocolError(
          "retry_later",
          "Report intake capacity reached",
        );
      const report: Report = {
        ...identity,
        id: randomUUID(),
        createdAt: now,
        status: "open",
      };
      next.set(report.id, report);
      this.dropped += dropped;
      await this.save(next);
      return { reportId: report.id, receivedAt: now };
    });
  }
  /** Commit the review intent before its recording-side effect. Retry pending
   * removal with exactly the same decision after interruption or restart. */
  decide(
    id: string,
    raw: z.infer<typeof reportDecisionSchema>,
    remove: (input: {
      id: string;
      revision: string;
      operationId: string;
    }) => Promise<unknown>,
  ) {
    idSchema.parse(id);
    const decision = reportDecisionSchema.parse(raw);
    return this.serial(async () => {
      let report = this.entries.get(id);
      if (!report) throw new ProtocolError("invalid_request", "Unknown report");
      if (decision.revision !== (report.reviewRevision ?? report.revision))
        throw new ProtocolError(
          "revision_changed",
          "Decision revision differs from reported recording",
        );
      if (
        report.reconciliations?.some(
          (entry) =>
            entry.previousDecision?.operationId === decision.operationId,
        )
      )
        throw new ProtocolError(
          "event_conflict",
          "Restored reports require a new review operation",
        );
      if (
        report.decision &&
        canonicalJson(report.decision) !== canonicalJson(decision)
      )
        throw new ProtocolError(
          "event_conflict",
          "Report already has a different decision",
        );
      if (report.status === "dismissed" || report.status === "removed")
        return structuredClone(report);
      if (!report.decision) {
        report = {
          ...report,
          decision,
          status: decision.action === "remove" ? "removing" : "dismissed",
          ...(decision.action === "dismiss" ? { resolvedAt: Date.now() } : {}),
        };
        const next = new Map(this.entries);
        next.set(id, report);
        await this.save(next);
      }
      if (decision.action === "remove") {
        await remove({
          id: report.streamId,
          revision: report.reviewRevision ?? report.revision,
          operationId: decision.operationId,
        });
        report = { ...report, status: "removed", resolvedAt: Date.now() };
        const next = new Map(this.entries);
        next.set(id, report);
        await this.save(next);
      }
      return structuredClone(report);
    });
  }
  /** Restore-only reconciliation under exclusive destination ownership. Keep the
   * reported revision and prior decision, but require fresh review for new bytes. */
  reconcileRestore(
    revisions: {
      streamId: string;
      previousRevision: string;
      revision: string;
    }[],
  ) {
    return this.serial(async () => {
      const mapping = new Map(revisions.map((row) => [row.streamId, row]));
      const next = new Map(this.entries);
      let changed = false;
      for (const report of this.entries.values()) {
        if (report.status !== "open" && report.status !== "removing") continue;
        const target = mapping.get(report.streamId);
        if (!target)
          throw new Error("Report references a missing restored recording");
        if (target.revision === target.previousRevision) continue;
        if (
          (report.reviewRevision ?? report.revision) !== target.previousRevision
        )
          throw new Error("Report revision differs from restored source");
        const history = report.reconciliations ?? [];
        if (history.length >= 32)
          throw new Error("Report restore history limit reached");
        const { decision, resolvedAt, ...retained } = report;
        next.set(report.id, {
          ...retained,
          status: "open",
          reviewRevision: target.revision,
          reconciliations: [
            ...history,
            {
              previousRevision: target.previousRevision,
              revision: target.revision,
              restoredAt: Date.now(),
              ...(decision ? { previousDecision: decision } : {}),
            },
          ],
        });
        changed = true;
      }
      if (changed) await this.save(next);
    });
  }
  list(after?: string, limit = 50) {
    if (after !== undefined) idSchema.parse(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ProtocolError("invalid_request", "Invalid report page size");
    return this.serial(async () => {
      const rows = [...this.entries.values()]
        .filter((row) => after === undefined || row.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit + 1);
      const more = rows.length > limit;
      if (more) rows.pop();
      return {
        reports: structuredClone(rows),
        nextAfter: more ? rows.at(-1)!.id : null,
        // Visible on every page so a trimmed ledger is never silent.
        ...(this.dropped ? { droppedReviewed: this.dropped } : {}),
      };
    }, false);
  }
  async close() {
    await this.queue;
    this.failed = true;
  }
}
