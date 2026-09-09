import { PagedActivityView } from "./paged-activity.js";
import type { TextSource } from "./text-source.js";
import {
  PagedReducer,
  initialPagedState,
  type PagedRecordingState,
} from "@agentlive/playback";
import {
  canonicalJson,
  ProtocolError,
  storedEventSchema,
  type StoredEvent,
  type SnapshotDescriptor,
  snapshotContentReferenceSchema,
} from "@agentlive/protocol";
import { BrowserContentStore } from "./content-store.js";
import type { CacheBinding } from "./history-cache.js";
/** Serialized local event reduction with atomic checkpoint publication. */
export class BrowserPagedState {
  private readonly stop = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly content: BrowserContentStore,
    private readonly binding: CacheBinding,
    private readonly reducer: PagedReducer,
    private root: PagedRecordingState,
    private head: SnapshotDescriptor | null,
  ) {}
  static async open(
    factory: IDBFactory,
    binding: CacheBinding,
    signal: AbortSignal,
  ) {
    binding = { ...binding };
    const content = await BrowserContentStore.open(factory, binding, signal);
    try {
      const head = await content.loadCheckpoint(signal),
        reducer = new PagedReducer(content);
      const root = head
        ? await reducer.open(head.ref, binding, signal)
        : initialPagedState();
      if (
        head &&
        (head.serverSeq !== root.appliedSeq ||
          head.timelineMs !== root.timelineMs)
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Browser checkpoint boundary differs",
        );
      return new BrowserPagedState(content, binding, reducer, root, head);
    } catch (error) {
      await content.close();
      throw error;
    }
  }
  get state() {
    return structuredClone(this.root);
  }
  get checkpoint() {
    return this.head ? structuredClone(this.head) : null;
  }
  apply(events: readonly StoredEvent[], parent: AbortSignal): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Paged state is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Paged state queue is full"),
      );
    if (events.length > 256)
      return Promise.reject(new RangeError("Paged event batch exceeds limit"));
    const encoded = canonicalJson(events);
    if (new TextEncoder().encode(encoded).length > 1024 * 1024)
      return Promise.reject(
        new RangeError("Paged event batch exceeds byte limit"),
      );
    const saved = JSON.parse(encoded).map((event: unknown) =>
      storedEventSchema.parse(event),
    ) as StoredEvent[];
    const signal = AbortSignal.any([parent, this.stop.signal]);
    this.pending++;
    const task = this.tail
      .then(async () => {
        signal.throwIfAborted();
        if (!saved.length) return;
        let candidate = this.root;
        for (const event of saved)
          candidate = await this.reducer.apply(candidate, event, signal);
        const ref = await this.reducer.checkpoint(
          candidate,
          this.binding,
          signal,
        );
        const head = await this.content.publishCheckpoint(
          this.head,
          {
            format: "agentlive.paged-state",
            serverSeq: candidate.appliedSeq,
            timelineMs: candidate.timelineMs,
            ref,
          },
          signal,
        );
        // A timeout after a committed transaction requires reopen; do not guess whether publication happened.
        this.root = candidate;
        this.head = head;
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
  get<K extends keyof PagedRecordingState["maps"]>(
    name: K,
    key: string | number,
    signal?: AbortSignal,
  ) {
    return this.reducer.get(this.root, name, key, signal);
  }
  entries<K extends keyof PagedRecordingState["maps"]>(
    name: K,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return this.reducer.entries(this.root, name, offset, limit, signal);
  }
  text(
    ref: Parameters<BrowserContentStore["read"]>[0],
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    return this.content.read(ref, offset, length, signal);
  }
  textSource(
    reference: Parameters<BrowserContentStore["read"]>[0],
  ): TextSource {
    const ref = snapshotContentReferenceSchema.parse(reference);
    Object.freeze(ref);
    return Object.freeze({
      key: canonicalJson({ ...this.binding, ref }),
      units: ref.units,
      read: (offset: number, length: number, signal: AbortSignal) =>
        this.content.read(ref, offset, length, signal),
    });
  }
  view(): PagedActivityView {
    return new PagedActivityView(this.reducer, this.root, (ref) =>
      this.textSource(ref),
    );
  }
  close() {
    if (!this.closing) {
      this.stop.abort(new Error("Paged state is closing"));
      this.closing = this.tail.then(() => this.content.close());
    }
    return this.closing;
  }
}
