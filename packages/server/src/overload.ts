import { monitorEventLoopDelay } from "node:perf_hooks";

export interface OverloadLimits {
  /**
   * Mean event-loop delay over the sampling window above which the server is over
   * capacity. Delivery is done on the loop, so this is what rises first when fan-out
   * outruns the process. Default: 250 ms.
   */
  eventLoopDelayMs?: number;
  /**
   * Bytes queued in viewer socket send buffers, summed across connections, above
   * which the server is over capacity. Per-socket shedding handles one slow viewer;
   * this catches many viewers that are each just under their own limit.
   * Default: 64 MiB.
   */
  bufferedBytes?: number;
  /** Sampling window for the event-loop measurement. Default: 1000 ms. */
  windowMs?: number;
  /**
   * How long the server stays over capacity after the measurements recover, so a
   * signal that flaps does not admit and refuse viewers alternately. Default: 5000 ms.
   */
  holdMs?: number;
}

export interface OverloadState {
  overloaded: boolean;
  eventLoopDelayMs: number;
  bufferedBytes: number;
  /** Milliseconds the server has been continuously over capacity, 0 when it is not. */
  forMs: number;
  /** Times the server entered the over-capacity state since it started. */
  episodes: number;
  /** Connections refused because the server was over capacity. */
  refused: number;
}

/**
 * Past its fan-out capacity the server queues rather than sheds: every socket stays
 * under its own buffer limit while delivery latency climbs, so nothing reports that
 * viewers are falling behind. This measures that state and makes it explicit —
 * readiness, metrics, and refusal of *new* viewers. Publishers are never refused:
 * durable capture is what the recording is for, and a publisher is not the fan-out.
 */
export class OverloadMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private readonly limitDelay: number;
  private readonly limitBuffered: number;
  private readonly window: number;
  private readonly hold: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private delay = 0;
  private since = 0;
  private until = 0;
  private episodes = 0;
  private refusals = 0;
  private buffered = () => 0;
  constructor(limits: OverloadLimits = {}) {
    this.limitDelay = limits.eventLoopDelayMs ?? 250;
    this.limitBuffered = limits.bufferedBytes ?? 64 * 1024 * 1024;
    this.window = limits.windowMs ?? 1000;
    this.hold = limits.holdMs ?? 5000;
    for (const value of [
      this.limitDelay,
      this.limitBuffered,
      this.window,
      this.hold,
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        throw new RangeError("Invalid overload limit");
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), this.window);
    this.timer.unref();
  }
  /** Supplies the summed send-buffer bytes of the open viewer sockets. */
  observeBuffered(source: () => number) {
    this.buffered = source;
  }
  private sample() {
    this.delay = this.histogram.mean / 1e6;
    this.histogram.reset();
    this.evaluate();
  }
  private evaluate() {
    const now = Date.now();
    if (this.delay > this.limitDelay || this.buffered() > this.limitBuffered) {
      if (!this.since) {
        this.since = now;
        this.episodes++;
      }
      this.until = now + this.hold;
    } else if (this.since && now >= this.until) this.since = 0;
  }
  get state(): OverloadState {
    // Re-evaluate on read so a buffer that filled between samples is not missed.
    this.evaluate();
    return {
      overloaded: this.since !== 0,
      eventLoopDelayMs: this.delay,
      bufferedBytes: this.buffered(),
      forMs: this.since ? Date.now() - this.since : 0,
      episodes: this.episodes,
      refused: this.refusals,
    };
  }
  /**
   * Whether a new viewer connection must be refused, counting the refusal. Existing
   * viewers keep their connections: dropping them would convert a latency problem
   * into a reconnect storm.
   */
  refuseViewer(): boolean {
    if (!this.state.overloaded) return false;
    this.refusals++;
    return true;
  }
  /** Test seam: force the measured delay, as a saturated loop would. */
  simulateDelayMs(value: number) {
    this.delay = value;
    this.evaluate();
  }
  close() {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}
