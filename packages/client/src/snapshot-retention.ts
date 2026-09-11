import { retryable } from "./http.js";
import {
  ProtocolError,
  snapshotLeaseSchema,
  type SnapshotLease,
} from "@agentlive/protocol";
import type { ContentReference } from "@agentlive/playback";
import type { RecordingSnapshotClient } from "./snapshots.js";
/** Bound caller waiting even if an external callback ignores its abort signal.
 * Persistence implementations must fence their commit on signal cancellation.
 */
function bounded<T>(
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const signal = AbortSignal.any([parent, stop.signal]);
  const timer = setTimeout(
    () =>
      stop.abort(
        new ProtocolError(
          "retry_later",
          "Snapshot retention operation timed out",
        ),
      ),
    30000,
  );
  let abort!: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .then((value) => {
        signal.throwIfAborted();
        resolve(value);
      })
      .catch(reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      });
    if (signal.aborted) abort();
  }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  });
}
/** One retained snapshot's lifetime. Persist provenance after each renewal before
 * using the renewed lease. A stale lease must be recovered from authoritative history.
 */
export class SnapshotRetention {
  private lease: SnapshotLease;
  private readonly stop = new AbortController();
  private renewing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  private failed = false;
  private renewedAt = -Infinity;
  private constructor(
    private readonly client: Pick<
      RecordingSnapshotClient,
      "renewLease" | "releaseLease" | "readBlob"
    >,
    lease: SnapshotLease,
    private readonly persist: (
      lease: SnapshotLease,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    this.lease = snapshotLeaseSchema.parse(lease);
  }
  /** Renew even a recently saved lease on restore; server expiry is authoritative. */
  static async open(
    client: Pick<
      RecordingSnapshotClient,
      "renewLease" | "releaseLease" | "readBlob"
    >,
    lease: SnapshotLease,
    persist: (lease: SnapshotLease, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<SnapshotRetention> {
    const retention = new SnapshotRetention(client, lease, persist);
    const abort = () => retention.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await retention.renew();
      signal.throwIfAborted();
      return retention;
    } catch (error) {
      retention.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  get provenance(): SnapshotLease {
    return snapshotLeaseSchema.parse(this.lease);
  }
  private active() {
    this.stop.signal.throwIfAborted();
    if (this.failed) throw this.failure;
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.stop.signal.aborted || this.failed) return;
    this.timer = setTimeout(() => {
      void this.renew().catch(() => {});
    }, 60000);
    // Browser timers are numbers; Node timers should not keep a closed viewer alive.
    if (typeof this.timer === "object")
      (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private renew(): Promise<void> {
    this.active();
    if (this.renewing) return this.renewing;
    let persisting = false;
    this.renewing = (async () => {
      const next = await bounded(this.stop.signal, (signal) =>
        this.client.renewLease(this.lease, signal),
      );
      this.stop.signal.throwIfAborted();
      persisting = true;
      await bounded(this.stop.signal, (signal) =>
        this.persist(snapshotLeaseSchema.parse(next), signal),
      );
      this.stop.signal.throwIfAborted();
      this.lease = next;
      this.renewedAt = performance.now();
    })()
      .catch((error) => {
        this.renewedAt = -Infinity;
        // Only retry transport renewal failures. An uncertain persistence commit
        // needs reopen/reconciliation, and invalid leases must remain unusable.
        this.failed = persisting || !retryable(error);
        this.failure = error;
        throw error;
      })
      .finally(() => {
        this.renewing = undefined;
        this.schedule();
      });
    return this.renewing;
  }
  async ensure(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.active();
    if (this.renewing || performance.now() - this.renewedAt >= 60000)
      await bounded(signal, () => this.renew());
    signal.throwIfAborted();
    this.active();
  }
  async readBlob(
    ref: ContentReference,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const copied = { ...ref };
    signal.throwIfAborted();
    this.active();
    // A suspended tab cannot trust its timer; renew before the next remote read.
    if (this.renewing || performance.now() - this.renewedAt >= 60000)
      await bounded(signal, () => this.renew());
    signal.throwIfAborted();
    this.active();
    return this.client.readBlob(
      copied,
      AbortSignal.any([signal, this.stop.signal]),
      this.lease.token,
    );
  }
  /** Stop use first. Caller clears persisted provenance only after release succeeds. */
  async release(signal: AbortSignal): Promise<void> {
    this.close();
    await this.renewing?.catch(() => {});
    await bounded(signal, (active) =>
      this.client.releaseLease(this.lease, active),
    );
  }
  close(): void {
    clearTimeout(this.timer);
    this.stop.abort(
      new ProtocolError("stale_lease", "Snapshot retention is closed"),
    );
  }
}
