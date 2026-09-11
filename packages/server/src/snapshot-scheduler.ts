import type { RecordingSession } from "./session.js";

export interface SnapshotScheduleOptions {
  batchEvents?: number;
  intervalMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}
type Session = Pick<
  RecordingSession,
  "info" | "selectSnapshot" | "buildSnapshot"
>;
interface Job {
  session: Session;
  sequence: number;
  batch: number;
  checkedAt: number;
  retryAt: number;
  stop: AbortController;
}
/** One automatic build at a time, with one coalesced job per cached session. */
export class SnapshotScheduler {
  private readonly jobs = new Map<Session, Job>();
  private readonly batch: number;
  private readonly interval: number;
  private readonly poll: number;
  private readonly timeout: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: { job: Job; task: Promise<void> } | undefined;
  private closing = false;
  private failures = 0;
  constructor(options: SnapshotScheduleOptions = {}) {
    this.batch = options.batchEvents ?? 1000;
    this.interval = options.intervalMs ?? 30000;
    this.poll = options.pollMs ?? 1000;
    this.timeout = options.timeoutMs ?? 30000;
    for (const value of [this.batch, this.interval, this.poll, this.timeout])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        throw new RangeError("Invalid snapshot scheduling limit");
  }
  get status() {
    return {
      registered: this.jobs.size,
      active: this.active ? 1 : 0,
      failures: this.failures,
    };
  }
  add(session: Session) {
    if (this.closing) throw new Error("Snapshot scheduler is closing");
    if (this.jobs.has(session)) return;
    this.jobs.set(session, {
      session,
      sequence: 0,
      batch: this.batch,
      checkedAt: Date.now(),
      retryAt: 0,
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
  private tick() {
    if (this.closing || this.active) return;
    const now = Date.now();
    for (const [session, job] of this.jobs) {
      const info = session.info;
      if (info.serverSeq <= job.sequence || now < job.retryAt) continue;
      if (
        info.serverSeq - job.sequence < this.batch &&
        info.lifecycle !== "ended" &&
        now - job.checkedAt < this.interval
      )
        continue;
      // Move the admitted session to the back, so a long recording cannot monopolize work.
      this.jobs.delete(session);
      this.jobs.set(session, job);
      const deadline = AbortSignal.timeout(this.timeout);
      const task = Promise.resolve()
        .then(async () => {
          const signal = AbortSignal.any([job.stop.signal, deadline]);
          signal.throwIfAborted();
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
        .catch(() => {
          if (!job.stop.signal.aborted) {
            this.failures++;
            if (deadline.aborted)
              job.batch = Math.max(1, Math.floor(job.batch / 2));
            job.retryAt = Date.now() + this.interval;
          }
        })
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
      this.active = { job, task };
      return;
    }
    this.schedule();
  }
  async remove(session: Session) {
    const job = this.jobs.get(session);
    if (!job) return;
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
