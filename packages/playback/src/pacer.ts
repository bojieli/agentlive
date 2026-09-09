/** Monotonic presentation timing. Callers retain responsibility for receipt and durable storage. */
export class PlaybackPacer {
  private position = 0;
  private anchor = performance.now();
  private rate: number;
  private stopped = false;
  private wakeups = new Set<() => void>();
  constructor(speed = 1) {
    this.validateSpeed(speed);
    this.rate = speed;
  }
  get speed() {
    return this.rate;
  }
  get paused() {
    return this.stopped;
  }
  private validateSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed <= 0 || speed > 1024)
      throw new RangeError(
        "Playback speed must be greater than zero and at most 1024",
      );
  }
  private current() {
    return (
      this.position +
      (this.stopped
        ? 0
        : Math.max(0, performance.now() - this.anchor) * this.rate)
    );
  }
  private checkpoint() {
    this.position = this.current();
    this.anchor = performance.now();
  }
  private wake() {
    for (const wake of [...this.wakeups]) wake();
  }
  setSpeed(speed: number) {
    this.validateSpeed(speed);
    this.checkpoint();
    this.rate = speed;
    this.wake();
  }
  setPaused(paused: boolean) {
    this.checkpoint();
    this.stopped = paused;
    this.wake();
  }
  /** Reset the presentation anchor after the caller has positioned its event source. */
  reset(position = 0) {
    if (!Number.isFinite(position) || position < 0)
      throw new RangeError("Invalid playback position");
    this.position = position;
    this.anchor = performance.now();
    this.wake();
  }
  async waitUntil(timelineMs: number, signal: AbortSignal) {
    if (!Number.isFinite(timelineMs) || timelineMs < 0)
      throw new RangeError("Invalid event timeline");
    for (;;) {
      signal.throwIfAborted();
      const remaining = timelineMs - this.current();
      if (!this.stopped && remaining <= 0) return;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          this.wakeups.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        this.wakeups.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        if (!this.stopped)
          timer = setTimeout(
            wake,
            Math.min(
              2_147_483_647,
              Math.max(1, Math.ceil(remaining / this.rate)),
            ),
          );
      });
    }
  }
}
