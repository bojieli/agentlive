import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TextStore, atomicJson, syncDirectory } from "@agentlive/storage";
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
  type ContentReference,
  type SnapshotBinding,
} from "@agentlive/playback";

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
  private readonly stop = new AbortController();
  private readonly binding: SnapshotBinding;
  constructor(
    private readonly directory: string,
    binding: SnapshotBinding,
  ) {
    this.binding = {
      streamId: idSchema.parse(binding.streamId),
      revision: idSchema.parse(binding.revision),
    };
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
  private async store() {
    if (this.content) return this.content;
    const content = await TextStore.open(this.directory);
    try {
      // Persist the lazily created snapshots directory in its recording parent.
      await syncDirectory(dirname(this.directory));
      this.content = content;
      return content;
    } catch (error) {
      await content.close();
      throw error;
    }
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
  ): Promise<SnapshotDescriptor | null> {
    cursorSchema.parse(through);
    return this.run(async () => {
      signal?.throwIfAborted();
      const entries = await this.catalog();
      const entry = entries.findLast((item) => item.serverSeq <= through);
      return entry ? this.verify(entry, signal) : null;
    });
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
      for await (const event of history(state.appliedSeq)) {
        combined.throwIfAborted();
        if (
          event.serverSeq !== state.appliedSeq + 1 ||
          event.serverSeq > through
        )
          throw new ProtocolError(
            "corrupt_storage",
            "Snapshot history is not the requested contiguous suffix",
          );
        state = await reducer.apply(state, event, combined);
        rows = await activityIndex.apply(rows, event, state, reducer, combined);
      }
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
  read(
    ref: ContentReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    return this.run(async () => {
      signal?.throwIfAborted();
      return (await this.store()).read(ref, offset, length, signal);
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop.abort(new Error("Snapshot store is closing"));
    this.closing = (async () => {
      await this.tail;
      await this.content?.close();
    })();
    return this.closing;
  }
}
