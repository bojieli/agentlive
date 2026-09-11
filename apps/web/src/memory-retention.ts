import {
  SnapshotRetention,
  type RecordingSnapshotClient,
} from "@agentlive/client";
import {
  canonicalJson,
  ProtocolError,
  snapshotLeaseSchema,
  type SnapshotLease,
  type TextReference,
} from "@agentlive/protocol";
type Client = Pick<
  RecordingSnapshotClient,
  "acquireLease" | "renewLease" | "releaseLease" | "readBlob"
>;
/** Visit-local import union. Close only after all derivative content readers drain. */
export class MemorySnapshotRetention {
  private retained = new Map<string, SnapshotRetention>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly stop = new AbortController();
  private closing: Promise<void> | undefined;
  constructor(private readonly client: Client) {}
  private bounded<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation();
        })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private run<T>(
    parent: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.closing)
      return Promise.reject(new Error("Memory snapshot retention is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Memory snapshot queue is full"),
      );
    const signal = AbortSignal.any([
      parent,
      this.stop.signal,
      AbortSignal.timeout(10000),
    ]);
    this.pending++;
    const task = this.tail
      .then(() => this.bounded(signal, () => operation(signal)))
      .finally(() => {
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async discard(lease: SnapshotLease) {
    const signal = AbortSignal.timeout(10000);
    await this.bounded(signal, () => this.client.releaseLease(lease, signal));
  }
  select(through: number, signal: AbortSignal, time?: number) {
    return this.run(signal, async (active) => {
      if (this.retained.size >= 128) return null;
      const acquired = await this.client.acquireLease(through, active, time);
      if (!acquired) {
        active.throwIfAborted();
        return null;
      }
      const lease = snapshotLeaseSchema.parse(acquired);
      let adopted = false;
      try {
        active.throwIfAborted();
        const sameToken = this.retained.get(lease.token);
        if (
          sameToken &&
          canonicalJson(sameToken.provenance.snapshot) !==
            canonicalJson(lease.snapshot)
        )
          throw new ProtocolError(
            "event_conflict",
            "Snapshot token changed roots",
          );
        const existing =
          sameToken ??
          [...this.retained.values()].find(
            (item) =>
              canonicalJson(item.provenance.snapshot) ===
              canonicalJson(lease.snapshot),
          );
        if (existing) {
          if (sameToken) adopted = true;
          await existing.ensure(active);
          active.throwIfAborted();
          return existing.provenance.snapshot;
        }
        const retention = await SnapshotRetention.open(
          this.client,
          lease,
          async (_next, renewalSignal) => {
            renewalSignal.throwIfAborted();
            this.stop.signal.throwIfAborted();
          },
          active,
        );
        if (active.aborted) {
          retention.close();
          active.throwIfAborted();
        }
        this.retained.set(lease.token, retention);
        adopted = true;
        return retention.provenance.snapshot;
      } finally {
        if (!adopted && !this.retained.has(lease.token))
          await this.discard(lease).catch(() => {});
      }
    });
  }
  readBlob(input: TextReference, signal: AbortSignal) {
    const ref = { ...input };
    return this.run(signal, async (active) => {
      // A derivative tree can contain content from any previously imported root.
      for (const retained of this.retained.values())
        await retained.ensure(active);
      active.throwIfAborted();
      const first = this.retained.values().next().value;
      if (!first)
        throw new ProtocolError(
          "stale_lease",
          "Remote content has no retained snapshot",
        );
      return first.readBlob(ref, active);
    });
  }
  finishRecovery(signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve();
  }
  close() {
    if (!this.closing) {
      this.stop.abort(
        new ProtocolError("stale_lease", "Memory snapshot retention is closed"),
      );
      for (const item of this.retained.values()) item.close();
      this.closing = this.tail.then(async () => {
        const releases = [...this.retained.values()].map((item) =>
          this.discard(item.provenance),
        );
        this.retained.clear();
        await Promise.allSettled(releases);
      });
    }
    return this.closing;
  }
}
