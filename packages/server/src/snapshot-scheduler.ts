import { SnapshotReductionError } from "./snapshots.js";
import type { RecordingSession } from "./session.js";

export interface SnapshotScheduleOptions {
  batchEvents?: number;
  intervalMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  /** Automatic collection of superseded derived snapshot content. Default: enabled. */
  collect?: boolean;
  /** Encoded snapshot growth since a recording's last successful pass that makes
   * another one due. Default: 64 MiB. */
  collectGrowthBytes?: number;
  /** Deadline for one collection pass. Default: the build `timeoutMs`. */
  collectTimeoutMs?: number;
}
type Session = Pick<
  RecordingSession,
  "info" | "selectSnapshot" | "buildSnapshot"
> &
  Partial<
    Pick<
      RecordingSession,
      "collectSnapshots" | "snapshotStoredBytes" | "reportSnapshotBlocked"
    >
  >;
interface Job {
  session: Session;
  sequence: number;
  batch: number;
  checkedAt: number;
  retryAt: number;
  /** Encoded snapshot bytes measured after this recording's last completed pass. */
  collectedBytes: number;
  collectedAt: number;
  /** Set once an unreducible event stopped builds for this recording for good. */
  blocked?: { serverSeq: number; code: string };
  stop: AbortController;
}
/** One automatic build or collection at a time, with one coalesced job per cached session. */
export class SnapshotScheduler {
  private readonly jobs = new Map<Session, Job>();
  private readonly batch: number;
  private readonly interval: number;
  private readonly poll: number;
  private readonly timeout: number;
  private readonly collecting: boolean;
  private readonly growth: number;
  private readonly collectTimeout: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active:
    { job: Job; task: Promise<void>; collect: boolean } | undefined;
  private closing = false;
  private failures = 0;
  private blocked = 0;
  private collections = 0;
  private collectionFailures = 0;
  private reclaimedBytes = 0;
  private lastCollectionMs = 0;
  constructor(options: SnapshotScheduleOptions = {}) {
    this.batch = options.batchEvents ?? 1000;
    this.interval = options.intervalMs ?? 30000;
    this.poll = options.pollMs ?? 1000;
    this.timeout = options.timeoutMs ?? 30000;
    this.collecting = options.collect ?? true;
    this.growth = options.collectGrowthBytes ?? 64 * 1024 * 1024;
    this.collectTimeout = options.collectTimeoutMs ?? this.timeout;
    for (const value of [
      this.batch,
      this.interval,
      this.poll,
      this.timeout,
      this.growth,
      this.collectTimeout,
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        throw new RangeError("Invalid snapshot scheduling limit");
    if (typeof this.collecting !== "boolean")
      throw new RangeError("Invalid snapshot collection setting");
  }
  get status() {
    return {
      registered: this.jobs.size,
      active: this.active && !this.active.collect ? 1 : 0,
      failures: this.failures,
      blocked: this.blocked,
      collecting: this.active?.collect ? 1 : 0,
      collections: this.collections,
      collectionFailures: this.collectionFailures,
      reclaimedBytes: this.reclaimedBytes,
      lastCollectionMs: this.lastCollectionMs,
    };
  }
  add(session: Session) {
    if (this.closing) throw new Error("Snapshot scheduler is closing");
    if (this.jobs.has(session)) return;
    const now = Date.now();
    this.jobs.set(session, {
      session,
      sequence: 0,
      batch: this.batch,
      checkedAt: now,
      retryAt: 0,
      collectedBytes: session.snapshotStoredBytes ?? 0,
      collectedAt: now,
      stop: new AbortController(),
    });
    this.schedule();
  }
  private schedule() {
    if (this.closing || this.timer || this.active || !this.jobs.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.poll);
    this.timer.unref();
  }
  /** Measured growth, not elapsed time alone, makes another pass due. */
  private due(job: Job, now: number): boolean {
    if (!this.collecting || !job.session.collectSnapshots) return false;
    return (
      (job.session.snapshotStoredBytes ?? 0) - job.collectedBytes >=
        this.growth && now - job.collectedAt >= this.interval
    );
  }
  private tick() {
    if (this.closing || this.active) return;
    const now = Date.now();
    for (const [session, job] of this.jobs) {
      const info = session.info;
      if (now < job.retryAt) continue;
      const build =
        job.blocked === undefined &&
        info.serverSeq > job.sequence &&
        (info.serverSeq - job.sequence >= this.batch ||
          info.lifecycle === "ended" ||
          now - job.checkedAt >= this.interval);
      // Building keeps the head current; collection runs only when no build is due.
      const collect = !build && this.due(job, now);
      if (!build && !collect) continue;
      // Move the admitted session to the back, so a long recording cannot monopolize work.
      this.jobs.delete(session);
      this.jobs.set(session, job);
      const deadline = AbortSignal.timeout(
        collect ? this.collectTimeout : this.timeout,
      );
      const startedAt = Date.now();
      const task = Promise.resolve()
        .then(async () => {
          const signal = AbortSignal.any([job.stop.signal, deadline]);
          signal.throwIfAborted();
          if (collect) {
            const result = await session.collectSnapshots!(signal);
            this.collections++;
            this.reclaimedBytes += result.reclaimedBytes;
            this.lastCollectionMs = Date.now() - startedAt;
            job.collectedBytes = session.snapshotStoredBytes ?? 0;
            job.collectedAt = Date.now();
            return;
          }
          const snapshot = await session.selectSnapshot(info.serverSeq, signal);
          signal.throwIfAborted();
          job.sequence = snapshot?.serverSeq ?? 0;
          if (job.sequence < info.serverSeq) {
            const through = Math.min(info.serverSeq, job.sequence + job.batch);
            const built = await session.buildSnapshot(through, signal);
            job.sequence = built.serverSeq;
          }
          job.checkedAt = Date.now();
          job.retryAt = 0;
        })
        .catch((error: unknown) => {
          if (job.stop.signal.aborted) return;
          if (collect) {
            // A failed or cancelled pass deleted nothing; retry after the interval.
            this.collectionFailures++;
            job.collectedAt = Date.now();
            return;
          }
          this.failures++;
          if (error instanceof SnapshotReductionError) {
            // Retrying reproduces this exactly. Stop building for this recording and
            // say which event stopped it, instead of looping until someone reads a
            // counter.
            job.blocked = { serverSeq: error.serverSeq, code: error.code };
            this.blocked++;
            job.session.reportSnapshotBlocked?.({
              serverSeq: error.serverSeq,
              code: error.code,
              reason: error.message,
            });
            return;
          }
          if (deadline.aborted)
            job.batch = Math.max(1, Math.floor(job.batch / 2));
          job.retryAt = Date.now() + this.interval;
        })
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
      this.active = { job, task, collect };
      return;
    }
    this.schedule();
  }
  /** Which recordings stopped building, and at which event. Content-free. */
  get blockedJobs() {
    return [...this.jobs.values()]
      .filter((job) => job.blocked !== undefined)
      .map((job) => ({ ...job.blocked! }));
  }
  async remove(session: Session) {
    const job = this.jobs.get(session);
    if (!job) return;
    if (job.blocked !== undefined) this.blocked--;
    this.jobs.delete(session);
    job.stop.abort(new Error("Snapshot session removed"));
    if (this.active?.job === job) await this.active.task;
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of this.jobs.values())
      job.stop.abort(new Error("Snapshot scheduler is closing"));
    this.jobs.clear();
    await this.active?.task;
  }
}
