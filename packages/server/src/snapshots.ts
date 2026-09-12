import { SnapshotLeases, type SnapshotLease } from "./snapshot-leases.js";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ContentPins,
  TextStore,
  atomicJson,
  syncDirectory,
} from "@agentlive/storage";
import {
  ProtocolError,
  idSchema,
  cursorSchema,
  type StoredEvent,
  snapshotDescriptorSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import {
  PagedReducer,
  ActivityIndex,
  initialActivityIndex,
  initialPagedState,
  openRecordingSnapshot,
  tracePairedSnapshot,
  type ContentReference,
  type PagedContent,
  type SnapshotBinding,
} from "@agentlive/playback";

/**
 * An event the reducer can never apply — an append before its object started, a
 * second start for one id, a gap the history cannot close. Retrying reproduces it
 * exactly, so the builder reports which event is unreducible instead of looping.
 */
export class SnapshotReductionError extends Error {
  constructor(
    readonly serverSeq: number,
    readonly code: string,
    readonly reason: string,
  ) {
    super(`Recording event ${serverSeq} cannot be reduced: ${reason}`);
    this.name = "SnapshotReductionError";
  }
}
/** Reducer codes raised by event content rather than by storage or cancellation. */
const unreducible = new Set(["event_conflict", "sequence_gap"]);
const contentFailure = (error: unknown) =>
  error instanceof ProtocolError && unreducible.has(error.code)
    ? error
    : undefined;

/** Content-free result of one automatic collection pass. */
export interface SnapshotCollection {
  /** Paired roots in the frozen retained union: head, live leases and in-process pins. */
  retainedRoots: number;
  /** Catalog descriptors dropped because nothing in that union retained them. */
  prunedDescriptors: number;
  removedBlobs: number;
  reclaimedBytes: number;
  /** True when a descriptor this collector cannot trace made a sweep unsafe; nothing was deleted. */
  skipped: boolean;
}
const nothing = (skipped: boolean): SnapshotCollection => ({
  retainedRoots: 0,
  prunedDescriptors: 0,
  removedBlobs: 0,
  reclaimedBytes: 0,
  skipped,
});
const paired = (entry: SnapshotDescriptor) =>
  entry.format === "agentlive.paged-state" && !!entry.activity;
const rootKey = (entry: SnapshotDescriptor) =>
  `${entry.serverSeq}:${entry.ref.hash}:${entry.activity?.hash ?? ""}`;
const catalogSchema = z.strictObject({
  version: z.literal(1),
  streamId: idSchema,
  revision: idSchema,
  entries: z.array(snapshotDescriptorSchema).max(128),
});
/** Derived recording data. The caller must retain recording ownership through close. */
export class RecordingSnapshots {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing: Promise<void> | undefined;
  private content: TextStore | undefined;
  private opening: Promise<TextStore> | undefined;
  private readonly readers = new Set<Promise<unknown>>();
  private readonly stop = new AbortController();
  private readonly pins = new ContentPins(32, 2);
  private readonly binding: SnapshotBinding;
  private readonly leases: SnapshotLeases;
  constructor(
    private readonly directory: string,
    binding: SnapshotBinding,
  ) {
    this.binding = {
      streamId: idSchema.parse(binding.streamId),
      revision: idSchema.parse(binding.revision),
    };
    this.leases = new SnapshotLeases(directory, this.binding);
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("storage_failed", "Snapshots are closing"),
      );
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Snapshot queue is full"),
      );
    this.pending++;
    const task = this.tail.then(operation).finally(() => {
      this.pending--;
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private reading<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ProtocolError("storage_failed", "Snapshots are closing"),
      );
    if (this.readers.size >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Snapshot reads are at capacity"),
      );
    const task = Promise.resolve().then(operation);
    this.readers.add(task);
    void task.finally(() => this.readers.delete(task)).catch(() => {});
    return task;
  }
  private async store(): Promise<TextStore> {
    if (this.content) return this.content;
    this.opening ??= (async () => {
      let content: TextStore | undefined;
      try {
        content = await TextStore.open(this.directory);
        await syncDirectory(dirname(this.directory));
        this.content = content;
        return content;
      } catch (error) {
        await content?.close();
        this.opening = undefined;
        throw error;
      }
    })();
    return this.opening;
  }
  private async catalog(): Promise<SnapshotDescriptor[]> {
    let file;
    try {
      file = await open(
        join(this.directory, "catalog.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536)
        throw new Error("Invalid catalog size");
      const bytes = Buffer.alloc(65537);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== stat.size || length > 65536)
        throw new Error("Invalid catalog length");
      const catalog = catalogSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, length),
          ),
        ),
      );
      if (
        catalog.streamId !== this.binding.streamId ||
        catalog.revision !== this.binding.revision
      )
        throw new ProtocolError(
          "revision_changed",
          "Snapshot catalog binding differs from recording",
        );
      let previous = -1;
      for (const entry of catalog.entries) {
        if (entry.serverSeq <= previous)
          throw new Error("Invalid catalog order");
        previous = entry.serverSeq;
      }
      return catalog.entries;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("corrupt_storage", "Invalid snapshot catalog");
    } finally {
      await file.close();
    }
  }
  private async verify(entry: SnapshotDescriptor, signal?: AbortSignal) {
    const reader = await openRecordingSnapshot(
      entry,
      this.binding,
      await this.store(),
      signal,
    );
    if (
      reader.manifest.serverSeq !== entry.serverSeq ||
      reader.manifest.timelineMs !== entry.timelineMs
    )
      throw new ProtocolError(
        "corrupt_storage",
        "Snapshot catalog boundary mismatch",
      );
    return entry;
  }
  select(
    through: number,
    signal?: AbortSignal,
    timelineMs?: number,
  ): Promise<SnapshotDescriptor | null> {
    cursorSchema.parse(through);
    if (
      timelineMs !== undefined &&
      (!Number.isFinite(timelineMs) || timelineMs < 0)
    )
      throw new RangeError("Invalid snapshot time");
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.reading(async () => {
      active.throwIfAborted();
      const entries = await this.catalog();
      active.throwIfAborted();
      const entry = entries.findLast(
        (item) =>
          item.serverSeq <= through &&
          (timelineMs === undefined || item.timelineMs <= timelineMs),
      );
      return entry ? this.verify(entry, active) : null;
    });
  }
  /** Select and durably retain paired roots under the publication queue. */
  selectLeased(
    through: number,
    signal?: AbortSignal,
    timelineMs?: number,
  ): Promise<SnapshotLease | null> {
    cursorSchema.parse(through);
    if (
      timelineMs !== undefined &&
      (!Number.isFinite(timelineMs) || timelineMs < 0)
    )
      throw new RangeError("Invalid snapshot time");
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.run(async () => {
      active.throwIfAborted();
      const entries = await this.catalog();
      const entry = entries.findLast(
        (item) =>
          item.serverSeq <= through &&
          (timelineMs === undefined || item.timelineMs <= timelineMs),
      );
      if (!entry) return null;
      await this.verify(entry, active);
      return this.leases.acquire(entry, active);
    });
  }
  renewLease(token: string, signal?: AbortSignal): Promise<SnapshotLease> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.run(() => this.leases.renew(token, active));
  }
  releaseLease(token: string, signal?: AbortSignal): Promise<void> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.run(() => this.leases.release(token, active));
  }
  build(
    through: number,
    history: (after: number) => AsyncIterable<StoredEvent>,
    signal?: AbortSignal,
  ): Promise<SnapshotDescriptor> {
    cursorSchema.parse(through);
    const combined = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.run(async () => {
      combined.throwIfAborted();
      const entries = await this.catalog();
      const existing = entries.find((entry) => entry.serverSeq === through);
      if (existing) return this.verify(existing, combined);
      const store = await this.store(),
        reducer = new PagedReducer(store),
        activityIndex = new ActivityIndex(store);
      const previous = entries.findLast(
        (entry) =>
          entry.serverSeq < through &&
          entry.format === "agentlive.paged-state" &&
          !!entry.activity,
      );
      let state = initialPagedState(),
        rows = initialActivityIndex();
      if (previous) {
        await this.verify(previous, combined);
        state = await reducer.open(previous.ref, this.binding, combined);
        rows = await activityIndex.open(
          previous.activity!,
          this.binding,
          combined,
        );
      }
      let batch: StoredEvent[] = [],
        bytes = 2,
        received = state.appliedSeq;
      const flush = async () => {
        try {
          state = await reducer.applyBatch(
            state,
            batch,
            combined,
            async (reduced, group) => {
              rows =
                group.length > 1
                  ? activityIndex.advanceAppends(rows, group, reduced)
                  : await activityIndex.apply(
                      rows,
                      group[0]!,
                      reduced,
                      reducer,
                      combined,
                    );
            },
          );
        } catch (error) {
          const failure = contentFailure(error);
          if (!failure) throw error;
          throw new SnapshotReductionError(
            typeof failure.details.serverSeq === "number"
              ? failure.details.serverSeq
              : batch[0]!.serverSeq,
            failure.code,
            failure.message,
          );
        }
        batch = [];
        bytes = 2;
      };
      for await (const event of history(state.appliedSeq)) {
        combined.throwIfAborted();
        if (event.serverSeq !== ++received || event.serverSeq > through)
          throw new ProtocolError(
            "corrupt_storage",
            "Snapshot history is not the requested contiguous suffix",
          );
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (batch.length && (batch.length === 256 || bytes + size > 1048576))
          await flush();
        batch.push(event);
        bytes += size;
      }
      if (batch.length) await flush();
      if (state.appliedSeq !== through)
        throw new ProtocolError(
          "corrupt_storage",
          "Snapshot history prefix is incomplete",
        );
      const ref = await reducer.checkpoint(state, this.binding, combined);
      const entry: SnapshotDescriptor = {
        format: "agentlive.paged-state",
        serverSeq: through,
        timelineMs: state.timelineMs,
        ref,
        activity: await activityIndex.checkpoint(rows, this.binding, combined),
      };
      await this.verify(entry, combined);
      combined.throwIfAborted();
      const next = [...entries, entry]
        .sort((a, b) => a.serverSeq - b.serverSeq)
        .slice(-128);
      await atomicJson(join(this.directory, "catalog.json"), {
        version: 1,
        ...this.binding,
        entries: next,
      });
      // After catalog commit starts, cancellation cannot retract a durable publication.
      return entry;
    });
  }
  /** Encoded derived content currently stored for this recording (0 before first use). */
  get storedBytes(): number {
    return this.content?.usage.storedBytes ?? 0;
  }
  /** Reclaim superseded derived content under the publication/lease queue.
   *
   * The retained union is the published head the server would select, every unexpired
   * durable lease and every in-process read/export pin. Holding this queue for the whole
   * pass freezes publication, lease acquisition/renewal/release and leased reads behind it;
   * the pin barrier freezes unleased reads (they receive a retryable error meanwhile).
   * The catalog is pruned to that union before any sweep, so selection can never return a
   * descriptor whose content was reclaimed, and a crash mid-sweep leaves every retained
   * root readable. Cancellation or a failed trace deletes nothing.
   */
  collect(signal?: AbortSignal): Promise<SnapshotCollection> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    return this.run(async () => {
      active.throwIfAborted();
      const entries = await this.catalog();
      const leases = await this.leases.retained(active);
      // A descriptor this collector cannot trace (legacy formats) must never be swept.
      if (
        entries.some((entry) => !paired(entry)) ||
        leases.some((lease) => !paired(lease.snapshot))
      )
        return nothing(true);
      const roots = new Map<string, SnapshotDescriptor>();
      const head = entries[entries.length - 1];
      if (head) roots.set(rootKey(head), head);
      for (const lease of leases)
        roots.set(rootKey(lease.snapshot), lease.snapshot);
      // Prove every retained root opens before anything is pruned or removed.
      for (const root of roots.values()) await this.verify(root, active);
      const kept = entries.filter((entry) => roots.has(rootKey(entry)));
      active.throwIfAborted();
      if (kept.length !== entries.length)
        await atomicJson(join(this.directory, "catalog.json"), {
          version: 1,
          ...this.binding,
          entries: kept,
        });
      active.throwIfAborted();
      const store = await this.store();
      const swept = await this.pins.withBarrier(
        (pinned, frozen) =>
          store.collect(async (scope, traced) => {
            const reader: PagedContent = {
              read: (ref, offset, length, signal) =>
                scope.read(ref, offset, length, signal),
              put: () => {
                throw new ProtocolError(
                  "precondition_failed",
                  "Collection tracing cannot write content",
                );
              },
              append: () => {
                throw new ProtocolError(
                  "precondition_failed",
                  "Collection tracing cannot write content",
                );
              },
            };
            for (const root of roots.values())
              await tracePairedSnapshot(
                reader,
                root,
                this.binding,
                scope.retain,
                traced,
              );
            for (const pin of pinned)
              await (pin.kind === "blob"
                ? scope.retainBlob(pin.ref)
                : scope.retain(pin.ref));
          }, frozen),
        active,
      );
      return {
        retainedRoots: roots.size,
        prunedDescriptors: entries.length - kept.length,
        removedBlobs: swept.removed,
        reclaimedBytes: swept.reclaimedBytes,
        skipped: false,
      };
    });
  }
  read(
    ref: ContentReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
    lease?: string,
  ) {
    ref = { ...ref };
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const operation = async () => {
      active.throwIfAborted();
      if (lease !== undefined) await this.leases.validate(lease, active);
      const pin = this.pins.pin([ref]);
      try {
        return await (await this.store()).read(ref, offset, length, active);
      } finally {
        pin.release();
      }
    };
    return lease === undefined ? this.reading(operation) : this.run(operation);
  }
  readBlob(ref: ContentReference, signal?: AbortSignal, lease?: string) {
    ref = { ...ref };
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const operation = async () => {
      active.throwIfAborted();
      if (lease !== undefined) await this.leases.validate(lease, active);
      const pin = this.pins.pin([ref], "blob");
      try {
        return await (await this.store()).readBlob(ref, active);
      } finally {
        pin.release();
      }
    };
    return lease === undefined ? this.reading(operation) : this.run(operation);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop.abort(new Error("Snapshot store is closing"));
    this.closing = (async () => {
      await Promise.allSettled([this.tail, ...this.readers]);
      await this.content?.close();
    })();
    return this.closing;
  }
}
