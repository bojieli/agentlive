import { RecordingSnapshotClient, SnapshotRetention } from "@agentlive/client";
import {
  ProtocolError,
  canonicalJson,
  type SnapshotLease,
  type TextReference,
} from "@agentlive/protocol";
import { BrowserContentStore } from "./content-store.js";
import type { CacheBinding } from "./history-cache.js";
type RetentionClient = Pick<
  RecordingSnapshotClient,
  "acquireLease" | "renewLease" | "releaseLease" | "readBlob"
>;
/** Keep every imported snapshot root until derivative cache invalidation. */
export class BrowserSnapshotRetention {
  private readonly retained = new Map<string, SnapshotRetention>();
  private closed = false;
  private readonly stop = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private constructor(
    private readonly metadata: BrowserContentStore,
    private readonly client: RetentionClient,
  ) {}
  static async open(
    factory: IDBFactory,
    binding: CacheBinding,
    client: RetentionClient,
    signal: AbortSignal,
  ) {
    const metadata = await BrowserContentStore.open(factory, binding, signal);
    const result = new BrowserSnapshotRetention(metadata, client);
    let recoveryThrough = 0;
    try {
      await metadata.prepareSnapshotRetention(signal);
      recoveryThrough = await metadata.loadRecoveryThrough(signal);
      const head = await metadata.loadCheckpoint(signal);
      const leases = await metadata.loadSnapshotLeases(signal);
      for (const lease of leases) {
        try {
          await result.adopt(lease, signal, true);
        } catch (error) {
          if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
            throw error;
          for (const retained of result.retained.values()) retained.close();
          result.retained.clear();
          // Renewals above may have updated the ledger. Compare the current records
          // and the original head so another writer's publication is never erased.
          await metadata.invalidateSnapshotRoots(
            head,
            await metadata.loadSnapshotLeases(signal),
            signal,
          );
          recoveryThrough = await metadata.loadRecoveryThrough(signal);
          break;
        }
      }
      return { retention: result, recoveryThrough };
    } catch (error) {
      await result.close();
      throw error;
    }
  }
  private async adopt(
    lease: SnapshotLease,
    signal: AbortSignal,
    saved = false,
  ) {
    if (!saved) await this.metadata.saveSnapshotLease(null, lease, signal);
    const retention = await SnapshotRetention.open(
      this.client,
      lease,
      async (next, active) => {
        await this.metadata.renewSnapshotLease(next, active);
      },
      signal,
    );
    if (this.closed) {
      retention.close();
      throw new Error("Snapshot retention is closed");
    }
    this.retained.set(lease.token, retention);
  }
  private run<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.closed)
      return Promise.reject(new Error("Snapshot retention is closed"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Snapshot retention queue is full"),
      );
    const active = AbortSignal.any([signal, this.stop.signal]);
    this.pending++;
    const task = this.tail
      .then(async () => {
        active.throwIfAborted();
        return operation(active);
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  /** Another tab can publish roots that depend on newly imported snapshots. */
  private async synchronize(signal: AbortSignal) {
    const leases = await this.metadata.loadSnapshotLeases(signal);
    const saved = new Map(leases.map((lease) => [lease.token, lease]));
    for (const [token, retention] of this.retained) {
      const lease = saved.get(token);
      if (!lease) {
        retention.close();
        throw new ProtocolError(
          "stale_lease",
          "Snapshot provenance was invalidated by another tab",
        );
      }
      if (
        canonicalJson(lease.snapshot) !==
        canonicalJson(retention.provenance.snapshot)
      )
        throw new ProtocolError(
          "event_conflict",
          "Snapshot lease roots changed",
        );
    }
    for (const lease of leases)
      if (!this.retained.has(lease.token))
        await this.adopt(lease, signal, true);
  }
  select(through: number, signal: AbortSignal, time?: number) {
    return this.run(signal, (active) => this.selectOnce(through, active, time));
  }
  private async selectOnce(
    through: number,
    signal: AbortSignal,
    time?: number,
  ) {
    if (this.closed) throw new Error("Snapshot retention is closed");
    await this.synchronize(signal);
    // At capacity use authoritative event history instead of evicting live roots.
    if (this.retained.size >= 128) return null;
    const lease = await this.client.acquireLease(through, signal, time);
    if (!lease) return null;
    const existing = [...this.retained.values()].find(
      (item) =>
        canonicalJson(item.provenance.snapshot) ===
        canonicalJson(lease.snapshot),
    );
    if (existing) {
      await this.client.releaseLease(lease, signal);
      await existing.ensure(signal);
      return existing.provenance.snapshot;
    }
    await this.adopt(lease, signal);
    return lease.snapshot;
  }
  readBlob(ref: TextReference, signal: AbortSignal) {
    const copied = { ...ref };
    return this.run(signal, (active) => this.readOnce(copied, active));
  }
  private async readOnce(ref: TextReference, signal: AbortSignal) {
    if (this.closed) throw new Error("Snapshot retention is closed");
    await this.synchronize(signal);
    // Derivative trees may share pages from several imports. Keep their entire union
    // valid before a lazy load; a token alone does not establish page provenance.
    for (const retention of this.retained.values())
      await retention.ensure(signal);
    const first = this.retained.values().next().value;
    if (!first)
      throw new ProtocolError(
        "stale_lease",
        "Cached remote content has no retained snapshot",
      );
    return first.readBlob(ref, signal);
  }
  finishRecovery(signal: AbortSignal) {
    return this.metadata.finishRecovery(signal);
  }
  async close() {
    this.closed = true;
    this.stop.abort(
      new ProtocolError("stale_lease", "Snapshot retention is closed"),
    );
    for (const retention of this.retained.values()) retention.close();
    await this.tail;
    this.retained.clear();
    await this.metadata.close();
  }
}
