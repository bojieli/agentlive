/** Monotonic presentation timing. Callers retain responsibility for receipt and durable storage. */
export class PlaybackPacer {
  private position = 0;
  private lastEvent = 0;
  private resetGeneration = 0;
  private idleCap: number | undefined;
  private anchor = performance.now();
  private rate: number;
  private stopped = false;
  private steps = 0;
  private immediatePlayback = false;
  private seeks = new Set<(timelineMs: number) => void>();
  private backwardSteps = new Set<() => void>();
  /** Ask the viewer to restore the preceding exact event prefix. */
  stepBackward() {
    this.setPaused(true);
    for (const listener of [...this.backwardSteps]) listener();
  }
  onStepBackward(listener: () => void) {
    this.backwardSteps.add(listener);
    return () => {
      this.backwardSteps.delete(listener);
    };
  }
  /** Request source repositioning; the viewer resets timing after rebuilding state. */
  seek(timelineMs: number) {
    if (!Number.isFinite(timelineMs) || timelineMs < 0)
      throw new RangeError("Invalid seek position");
    this.steps = 0;
    for (const listener of [...this.seeks]) listener(timelineMs);
  }
  onSeek(listener: (timelineMs: number) => void) {
    this.seeks.add(listener);
    return () => {
      this.seeks.delete(listener);
    };
  }
  private changes = new Set<() => void>();
  onChange(listener: () => void) {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }
  private changed() {
    for (const listener of [...this.changes]) listener();
  }
  private wakeups = new Set<() => void>();
  constructor(speed = 1) {
    this.validateSpeed(speed);
    this.rate = speed;
  }
  /** Cap each recorded inter-event gap in timeline milliseconds, before speed scaling. */
  setIdleCap(milliseconds: number | undefined) {
    if (
      milliseconds !== undefined &&
      (!Number.isFinite(milliseconds) || milliseconds < 0)
    )
      throw new RangeError("Idle cap must be a nonnegative finite number");
    this.idleCap = milliseconds;
    this.wake();
    this.changed();
  }
  get idleCapMs() {
    return this.idleCap;
  }
  get speed() {
    return this.rate;
  }
  get immediate() {
    return this.immediatePlayback;
  }
  /** Skip timing delays while preserving pause and event ordering. */
  setImmediate(immediate: boolean) {
    this.checkpoint();
    this.immediatePlayback = immediate;
    this.wake();
    this.changed();
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
    this.changed();
  }
  setPaused(paused: boolean) {
    this.steps = 0;
    this.checkpoint();
    this.stopped = paused;
    this.wake();
    this.changed();
  }
  /** Admit exactly one next event (including tied timestamps), then remain paused. */
  step() {
    if (this.steps >= 1024)
      throw new RangeError("Too many pending playback steps");
    this.checkpoint();
    this.stopped = true;
    this.steps++;
    this.wake();
    this.changed();
  }
  /** Reset the presentation anchor after the caller has positioned its event source. */
  reset(position = 0) {
    if (!Number.isFinite(position) || position < 0)
      throw new RangeError("Invalid playback position");
    this.resetGeneration++;
    this.position = position;
    this.lastEvent = position;
    this.anchor = performance.now();
    this.wake();
  }
  async waitUntil(timelineMs: number, signal: AbortSignal) {
    if (!Number.isFinite(timelineMs) || timelineMs < 0)
      throw new RangeError("Invalid event timeline");
    signal.throwIfAborted();
    const generation = this.resetGeneration,
      previousEvent = this.lastEvent;
    let skipped = 0,
      admitted = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        // Recompute only this wait's offset, retaining time already elapsed and excluding pauses.
        if (generation === this.resetGeneration) {
          const desired =
            this.idleCap === undefined || this.immediatePlayback
              ? 0
              : Math.max(0, timelineMs - previousEvent - this.idleCap);
          this.position += desired - skipped;
          skipped = desired;
        }
        if (this.stopped && this.steps > 0) {
          this.steps--;
          this.position = timelineMs;
          this.anchor = performance.now();
          this.lastEvent = timelineMs;
          admitted = true;
          return "step" as const;
        }
        const remaining = this.immediatePlayback
          ? 0
          : timelineMs - this.current();
        if (!this.stopped && remaining <= 0) {
          this.lastEvent = timelineMs;
          admitted = true;
          return "play" as const;
        }
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
    } finally {
      if (!admitted && generation === this.resetGeneration)
        this.position -= skipped;
    }
  }
}
