import { TerminalLeaseCatalog } from "./watch-leases.js";
import {
  SnapshotRetention,
  type RecordingSnapshotClient,
} from "@agentlive/client";
import { retryable } from "@agentlive/client/transport";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  TextStore,
  atomicJson,
  type SubscriberCache,
} from "@agentlive/storage";
import {
  PagedReducer,
  initialPagedState,
  type PagedRecordingState,
} from "@agentlive/playback";
import {
  snapshotDescriptorSchema,
  canonicalJson,
  ProtocolError,
  type SnapshotDescriptor,
  type SnapshotLease,
  type StoredEvent,
} from "@agentlive/protocol";
/** Derivative presentation checkpoints. The caller holds SubscriberCache ownership until close. */
export class TerminalWatchState {
  readonly reducer: PagedReducer;
  private checkpoints: SnapshotDescriptor[] = [];
  private readonly retained = new Map<string, SnapshotRetention>();
  private readonly leases: TerminalLeaseCatalog;
  private restored = false;
  private readonly stop = new AbortController();
  private saving: Promise<void> = Promise.resolve();
  private savePending = 0;
  private publication: Promise<void> = Promise.resolve();
  private publicationPending = 0;
  private generation = 0;
  private readonly stateGenerations = new WeakMap<
    PagedRecordingState,
    number
  >();
  private closing: Promise<void> | undefined;
  private constructor(
    readonly content: TextStore,
    private readonly cache: SubscriberCache,
    private readonly snapshots?: RecordingSnapshotClient,
  ) {
    this.reducer = new PagedReducer(content);
    this.leases = new TerminalLeaseCatalog(cache);
  }
  static async open(
    cache: SubscriberCache,
    signal: AbortSignal,
    snapshots?: RecordingSnapshotClient,
  ) {
    let state!: TerminalWatchState;
    const content = await TextStore.open(
      cache.contentDirectory,
      undefined,
      snapshots ? (ref, active) => state.readRemote(ref, active) : undefined,
    );
    state = new TerminalWatchState(content, cache, snapshots);
    try {
      signal.throwIfAborted();
      let file;
      try {
        file = await open(
          join(cache.contentDirectory, "checkpoints.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32768)
          throw new Error("Invalid terminal checkpoint catalog size");
        const bytes = Buffer.alloc(32769);
        let length = 0;
        while (length < bytes.length) {
          signal.throwIfAborted();
          const result = await file.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== stat.size || length > 32768)
          throw new Error("Terminal checkpoint catalog changed");
        const saved = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, length),
          ),
        );
        if (
          Object.keys(saved).sort().join(",") !==
            "binding,checkpoints,version" ||
          ![1, 2].includes(saved.version) ||
          canonicalJson(saved.binding) !== canonicalJson(cache.binding) ||
          !Array.isArray(saved.checkpoints) ||
          saved.checkpoints.length > 32
        )
          throw new Error("Invalid terminal checkpoint binding");
        state.checkpoints = saved.checkpoints.map((item: unknown) =>
          snapshotDescriptorSchema.parse(item),
        );
        let previous = -1;
        for (const checkpoint of state.checkpoints) {
          if (
            checkpoint.format !== "agentlive.paged-state" ||
            checkpoint.serverSeq <= previous ||
            checkpoint.serverSeq > cache.cursor.serverSeq
          )
            throw new Error(
              "Terminal checkpoint exceeds or conflicts with receipt",
            );
          previous = checkpoint.serverSeq;
        }
        signal.throwIfAborted();
        if (saved.version === 1) {
          // Old derivatives may contain lazy imports without durable leases.
          // The independently committed event cache reconstructs any selected prefix.
          await atomicJson(join(cache.contentDirectory, "checkpoints.json"), {
            version: 2,
            binding: cache.binding,
            checkpoints: [],
          });
          state.checkpoints = [];
        }
        return state;
      } finally {
        await file.close();
      }
    } catch (error) {
      await content.close();
      throw error;
    }
  }
  private async retain(
    lease: SnapshotLease,
    signal: AbortSignal,
    existing = false,
  ) {
    let previous = lease;
    if (!existing) {
      // Persistence may succeed before renewal fails. Reconcile that saved
      // provenance on the next selection/read rather than abandoning it.
      this.restored = false;
      await this.leases.save(null, lease, signal);
    }
    const retention = await SnapshotRetention.open(
      this.snapshots!,
      lease,
      async (next, active) => {
        await this.leases.save(previous, next, active);
        previous = next;
      },
      signal,
    );
    this.retained.set(lease.token, retention);
  }
  private async restoreLeases(signal: AbortSignal) {
    if (this.restored || !this.snapshots) return;
    const leases = await this.leases.load(signal);
    try {
      for (const lease of leases)
        if (!this.retained.has(lease.token))
          await this.retain(lease, signal, true);
      this.restored = true;
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      await this.invalidateImports(signal);
    }
  }
  private publish(operation: () => Promise<void>): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Terminal watch state is closing"));
    if (this.publicationPending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Terminal publication queue is full"),
      );
    this.publicationPending++;
    const task = this.publication.then(operation).finally(() => {
      this.publicationPending--;
    });
    this.publication = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async invalidateImports(signal: AbortSignal) {
    signal.throwIfAborted();
    // Fence every save admitted before this invalidation, even if it is still
    // constructing a checkpoint. Only metadata publication shares this queue:
    // lazy content reads may themselves trigger invalidation.
    this.generation++;
    await this.publish(async () => {
      signal.throwIfAborted();
      this.restored = false;
      for (const retained of this.retained.values()) retained.close();
      this.retained.clear();
      // Invalidate catalog first. A crash during lease cleanup still leaves event
      // receipt authoritative and forces local reconstruction on the next open.
      await atomicJson(join(this.cache.contentDirectory, "checkpoints.json"), {
        version: 2,
        binding: this.cache.binding,
        checkpoints: [],
      });
      this.checkpoints = [];
      await this.leases.clear(await this.leases.load(signal), signal);
      this.restored = true;
    });
  }
  private async readRemote(
    ref: import("@agentlive/protocol").TextReference,
    signal: AbortSignal,
  ) {
    await this.restoreLeases(signal);
    for (const retention of this.retained.values())
      await retention.ensure(signal);
    const first = this.retained.values().next().value;
    if (!first)
      throw new ProtocolError(
        "stale_lease",
        "Terminal content has no retained snapshot",
      );
    return first.readBlob(ref, signal);
  }
  async select(
    through: number,
    signal: AbortSignal,
  ): Promise<PagedRecordingState> {
    signal = AbortSignal.any([signal, this.stop.signal]);
    signal.throwIfAborted();
    try {
      return await this.selectOnce(through, signal, true);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      await this.invalidateImports(signal);
      // One bounded retry from authoritative receipt. Never reacquire a snapshot
      // during this recovery attempt or loop on a failing remote dependency.
      return this.selectOnce(through, signal, false);
    }
  }
  private async selectOnce(
    through: number,
    signal: AbortSignal,
    remote: boolean,
  ): Promise<PagedRecordingState> {
    if (
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through > this.cache.cursor.serverSeq
    )
      throw new RangeError("Invalid terminal seek boundary");
    if (remote && this.snapshots) {
      try {
        await this.restoreLeases(signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!retryable(error)) throw error;
      }
    }
    const generation = this.generation;
    let checkpoint = this.checkpoints.findLast(
      (item) => item.serverSeq <= through,
    );
    if (
      remote &&
      this.snapshots &&
      this.retained.size < 128 &&
      through > (checkpoint?.serverSeq ?? 0)
    ) {
      try {
        const selected = await this.snapshots.acquireLease(through, signal);
        if (selected) {
          const existing = [...this.retained.values()].find(
            (item) =>
              canonicalJson(item.provenance.snapshot) ===
              canonicalJson(selected.snapshot),
          );
          if (existing) {
            await this.snapshots.releaseLease(selected, signal);
            await existing.ensure(signal);
          } else await this.retain(selected, signal);
          if (selected.snapshot.serverSeq > (checkpoint?.serverSeq ?? 0))
            checkpoint = selected.snapshot;
        }
      } catch (error) {
        signal.throwIfAborted();
        // Snapshot acceleration is optional when transport is temporarily unavailable.
        // Binding, integrity and protocol failures still fail explicitly.
        if (!retryable(error)) throw error;
      }
    }
    let state = checkpoint
      ? await this.reducer.open(checkpoint.ref, this.cache.binding, signal)
      : initialPagedState();
    if (
      checkpoint &&
      (state.appliedSeq !== checkpoint.serverSeq ||
        state.timelineMs !== checkpoint.timelineMs)
    )
      throw new ProtocolError(
        "corrupt_storage",
        "Terminal checkpoint boundary differs",
      );
    let batch: import("@agentlive/protocol").StoredEvent[] = [],
      bytes = 2;
    for await (const event of this.cache.events(state.appliedSeq, through)) {
      signal.throwIfAborted();
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (batch.length && (batch.length === 256 || bytes + size > 1048576)) {
        state = await this.reducer.applyBatch(state, batch, signal);
        batch = [];
        bytes = 2;
      }
      batch.push(event);
      bytes += size;
    }
    if (batch.length)
      state = await this.reducer.applyBatch(state, batch, signal);
    if (state.appliedSeq !== through)
      throw new ProtocolError(
        "sequence_gap",
        "Terminal seek history is incomplete",
      );
    signal.throwIfAborted();
    if (generation !== this.generation)
      throw new ProtocolError(
        "stale_lease",
        "Terminal imports changed during selection",
      );
    this.stateGenerations.set(state, generation);
    return state;
  }
  /** Apply an already committed event. If lazy imports expire, reconstruct the
   * accepted prefix locally and tell presentation to render a replacement view.
   */
  async advance(
    previous: PagedRecordingState,
    event: StoredEvent,
    signal: AbortSignal,
  ): Promise<{ state: PagedRecordingState; recovered: boolean }> {
    signal = AbortSignal.any([signal, this.stop.signal]);
    signal.throwIfAborted();
    if (
      event.serverSeq !== previous.appliedSeq + 1 ||
      event.serverSeq > this.cache.cursor.serverSeq
    )
      throw new ProtocolError(
        "sequence_gap",
        "Terminal presentation event is outside committed receipt",
      );
    try {
      const generation = this.stateGenerations.get(previous) ?? 0;
      if (generation !== this.generation)
        throw new ProtocolError(
          "stale_lease",
          "Terminal presentation belongs to invalidated imports",
        );
      const next = await this.reducer.apply(previous, event, signal);
      if (generation !== this.generation)
        throw new ProtocolError(
          "stale_lease",
          "Terminal imports changed during reduction",
        );
      this.stateGenerations.set(next, generation);
      return { state: next, recovered: false };
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      await this.invalidateImports(signal);
      return {
        state: await this.selectOnce(event.serverSeq, signal, false),
        recovered: true,
      };
    }
  }
  /** Recover a failed lazy renderer once. Output already emitted cannot be
   * retracted; finish it with a newline and append a complete replacement view.
   * Sink failures occur outside this generator and are never retried here.
   */
  async *render(
    output: AsyncIterable<string>,
    current: PagedRecordingState,
    snapshot: (state: PagedRecordingState) => AsyncIterable<string>,
    replace: (state: PagedRecordingState) => void,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    signal = AbortSignal.any([signal, this.stop.signal]);
    signal.throwIfAborted();
    try {
      yield* output;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      await this.invalidateImports(signal);
      const rebuilt = await this.selectOnce(current.appliedSeq, signal, false);
      signal.throwIfAborted();
      replace(rebuilt);
      yield "\n";
      yield* snapshot(rebuilt);
    }
  }
  save(state: PagedRecordingState, signal: AbortSignal): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Terminal watch state is closing"));
    if (this.savePending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Terminal checkpoint queue is full"),
      );
    const active = AbortSignal.any([signal, this.stop.signal]);
    const generation = this.stateGenerations.get(state) ?? 0;
    if (generation !== this.generation)
      return Promise.reject(
        new ProtocolError(
          "stale_lease",
          "Cannot save a state from invalidated terminal imports",
        ),
      );
    this.savePending++;
    const task = this.saving
      .then(() => this.saveOnce(state, active, generation))
      .finally(() => {
        this.savePending--;
      });
    this.saving = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async saveOnce(
    state: PagedRecordingState,
    signal: AbortSignal,
    generation: number,
  ) {
    signal.throwIfAborted();
    if (state.appliedSeq > this.cache.cursor.serverSeq)
      throw new Error("Terminal presentation exceeds receipt");
    const ref = await this.reducer.checkpoint(
      state,
      this.cache.binding,
      signal,
    );
    return this.publish(async () => {
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new ProtocolError(
          "stale_lease",
          "Terminal imports changed during checkpoint save",
        );
      const checkpoint: SnapshotDescriptor = {
        format: "agentlive.paged-state",
        serverSeq: state.appliedSeq,
        timelineMs: state.timelineMs,
        ref,
      };
      const previous = this.checkpoints.find(
        (item) => item.serverSeq === state.appliedSeq,
      );
      if (previous && canonicalJson(previous) !== canonicalJson(checkpoint))
        throw new ProtocolError(
          "event_conflict",
          "Terminal checkpoint prefix changed",
        );
      if (previous) return;
      const next = [...this.checkpoints, checkpoint].sort(
        (a, b) => a.serverSeq - b.serverSeq,
      );
      // Keep the selected boundary, sampling older retained positions when the bounded catalog fills.
      if (next.length > 32) {
        const candidates = next
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.serverSeq !== checkpoint.serverSeq);
        const victim = candidates.reduce((best, candidate) => {
          const span = (index: number) =>
            (next[index + 1]?.serverSeq ?? Number.MAX_SAFE_INTEGER) -
            (next[index - 1]?.serverSeq ?? 0);
          return span(candidate.index) < span(best.index) ? candidate : best;
        });
        next.splice(victim.index, 1);
      }
      signal.throwIfAborted();
      await atomicJson(join(this.cache.contentDirectory, "checkpoints.json"), {
        version: 2,
        binding: this.cache.binding,
        checkpoints: next,
      });
      this.checkpoints = next;
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stop.abort(new Error("Terminal watch state is closing"));
      for (const retained of this.retained.values()) retained.close();
      this.closing = (async () => {
        // A started atomic publication must drain before content ownership ends.
        await this.saving;
        await this.publication;
        await this.leases.close();
        await this.content.close();
      })();
    }
    return this.closing;
  }
}
