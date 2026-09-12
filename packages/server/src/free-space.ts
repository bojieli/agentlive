import { statfs } from "node:fs/promises";
import { ProtocolError } from "@agentlive/protocol";

/** Filesystem capacity probe; `statfs` by default, injectable for tests and embedders. */
export type StatfsProbe = (
  directory: string,
) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;

const defaultProbe: StatfsProbe = (directory) =>
  statfs(directory, { bigint: true });

/**
 * Server-wide free-space floor for durable growth. Filesystem queries are
 * asynchronous while quota admission is synchronous, so admission uses a briefly
 * cached `statfs` sample minus the growth committed since the sample started and
 * the bytes of every pending reservation. Only one probe is ever in flight (a
 * stalled filesystem cannot accumulate probes), and callers that wait for one
 * are released after a bounded deadline, like the readiness probe.
 */
export class FreeSpaceFloor {
  private sample: { available: number; at: number } | undefined;
  private failed = false;
  /** Committed growth since the current sample's probe started. */
  private growth = 0;
  private pending: Promise<void> | undefined;
  constructor(
    readonly directory: string,
    readonly minFreeBytes: number,
    private readonly probe: StatfsProbe = defaultProbe,
    private readonly maxAgeMs = 1000,
    private readonly timeoutMs = 1000,
  ) {}

  /** Start (or join) a probe; resolves when it settles or after the deadline. */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const base = this.growth;
    const started = Date.now();
    const work = Promise.resolve()
      .then(() => this.probe(this.directory))
      .then((result) => {
        const available = BigInt(result.bavail) * BigInt(result.bsize);
        if (available < 0n) throw new RangeError("Invalid statfs result");
        // Growth committed while the probe ran may or may not be reflected by
        // it; keep counting it (conservative) until the next sample.
        this.growth = Math.max(0, this.growth - base);
        this.sample = {
          available:
            available > BigInt(Number.MAX_SAFE_INTEGER)
              ? Number.MAX_SAFE_INTEGER
              : Number(available),
          at: started,
        };
        this.failed = false;
      })
      .catch(() => {
        // Keep the previous sample (and its accumulated growth) for admission;
        // readiness reports the failed probe.
        this.failed = true;
      });
    const wait = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.timeoutMs);
      timer.unref?.();
      void work.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.pending = wait;
    void work.then(() => {
      if (this.pending === wait) this.pending = undefined;
    });
    return wait;
  }

  /** Estimated available bytes after committed growth, or undefined before a sample. */
  private estimate(reserved: number): number | undefined {
    return this.sample === undefined
      ? undefined
      : this.sample.available - this.growth - reserved;
  }

  /**
   * Synchronous admission of `requested` more bytes while `reserved` bytes are
   * already admitted but not committed. Throws the non-retryable
   * `quota_exceeded` when the write would leave less than the floor free.
   * Before the first successful sample the floor cannot be evaluated and the
   * write is admitted (readiness reports the failing probe).
   */
  admit(requested: number, reserved: number): void {
    if (requested <= 0) return;
    if (!this.sample || Date.now() - this.sample.at >= this.maxAgeMs)
      void this.refresh();
    const estimate = this.estimate(reserved);
    if (estimate === undefined) return;
    if (estimate - requested < this.minFreeBytes)
      throw new ProtocolError(
        "quota_exceeded",
        `Server storage quota exceeded: the server keeps at least ${this.minFreeBytes} bytes of filesystem space free; this write needs ${requested} more bytes`,
        {
          quota: "minFreeBytes",
          scope: "global",
          limit: this.minFreeBytes,
          requested,
        },
      );
  }

  /** Record committed durable growth (deletions are observed by the next sample). */
  grew(bytes: number): void {
    if (bytes > 0) this.growth += bytes;
  }

  /** Fresh check for readiness: false below the floor, or when the probe fails or stalls. */
  async ready(): Promise<boolean> {
    await this.refresh();
    const estimate = this.estimate(0);
    return (
      !this.failed &&
      this.sample !== undefined &&
      Date.now() - this.sample.at < this.maxAgeMs + this.timeoutMs &&
      estimate !== undefined &&
      estimate >= this.minFreeBytes
    );
  }

  /** Content-free status for metrics. */
  get status() {
    const estimate = this.estimate(0);
    return {
      minFreeBytes: this.minFreeBytes,
      availableBytes:
        estimate === undefined ? undefined : Math.max(0, estimate),
      probeFailed: this.failed,
    };
  }
}
