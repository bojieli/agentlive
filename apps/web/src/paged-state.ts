import { PagedActivityView } from "./paged-activity.js";
import type { TextSource } from "./text-source.js";
import {
  PagedReducer,
  ActivityIndex,
  initialActivityIndex,
  type ActivityIndexRoot,
  initialPagedState,
  type PagedRecordingState,
} from "@agentlive/playback";
import {
  canonicalJson,
  ProtocolError,
  storedEventSchema,
  type StoredEvent,
  snapshotContentReferenceSchema,
} from "@agentlive/protocol";
import {
  BrowserContentStore,
  type BrowserCheckpoint,
} from "./content-store.js";
import type { CacheBinding } from "./history-cache.js";
/** Bound each source read; cancellation must not wait for an uncooperative iterator. */
async function* cancellableHistory(
  history: AsyncIterable<StoredEvent>,
  parent: AbortSignal,
) {
  const iterator = history[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
      signal.throwIfAborted();
      const item = await new Promise<IteratorResult<StoredEvent>>(
        (resolve, reject) => {
          const cleanup = () => signal.removeEventListener("abort", abort);
          const abort = () => {
            cleanup();
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return iterator.next();
            })
            .then(resolve, reject)
            .finally(cleanup);
        },
      );
      parent.throwIfAborted();
      if (item.done) {
        complete = true;
        return;
      }
      yield item.value;
    }
  } finally {
    if (!complete && iterator.return)
      void Promise.resolve()
        .then(() => iterator.return!())
        .catch(() => {});
  }
}
/** Serialized local event reduction with atomic checkpoint publication. */
export class BrowserPagedState {
  private readonly stop = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing: Promise<void> | undefined;
  private selected:
    { root: PagedRecordingState; rows: ActivityIndexRoot } | undefined;
  private selections = new Set<Promise<unknown>>();
  private constructor(
    private readonly content: BrowserContentStore,
    private readonly binding: CacheBinding,
    private readonly reducer: PagedReducer,
    private root: PagedRecordingState,
    private head: BrowserCheckpoint | null,
    private readonly activityIndex: ActivityIndex,
    private activityRoot: ActivityIndexRoot | null,
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
      const activityIndex = new ActivityIndex(content);
      const activityRoot = head
        ? head.activity
          ? await activityIndex.open(head.activity, binding, signal)
          : null
        : initialActivityIndex();
      if (
        activityRoot &&
        (activityRoot.appliedSeq !== root.appliedSeq ||
          activityRoot.gaps !== (root.maps.gaps?.size ?? 0))
      )
        throw new ProtocolError(
          "corrupt_storage",
          "Browser activity checkpoint boundary differs",
        );
      return new BrowserPagedState(
        content,
        binding,
        reducer,
        root,
        head,
        activityIndex,
        activityRoot,
      );
    } catch (error) {
      await content.close();
      throw error;
    }
  }
  get needsActivityRebuild() {
    return this.activityRoot === null;
  }
  /** Upgrade an older state-only checkpoint by replaying its exact authoritative prefix. */
  rebuildActivity(
    history: AsyncIterable<StoredEvent>,
    parent: AbortSignal,
  ): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Paged state is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Paged state queue is full"),
      );
    const signal = AbortSignal.any([parent, this.stop.signal]);
    this.pending++;
    const task = this.tail
      .then(async () => {
        signal.throwIfAborted();
        if (this.activityRoot) return;
        const expected = this.head!;
        let candidate = initialPagedState(),
          rows = initialActivityIndex();
        for await (const event of cancellableHistory(history, signal)) {
          signal.throwIfAborted();
          if (event.serverSeq > expected.serverSeq)
            throw new ProtocolError(
              "sequence_gap",
              "Activity rebuild exceeds saved prefix",
            );
          candidate = await this.reducer.apply(candidate, event, signal);
          rows = await this.activityIndex.apply(
            rows,
            event,
            candidate,
            this.reducer,
            signal,
          );
        }
        if (candidate.appliedSeq !== expected.serverSeq)
          throw new ProtocolError(
            "sequence_gap",
            "Activity rebuild prefix is incomplete",
          );
        const ref = await this.reducer.checkpoint(
          candidate,
          this.binding,
          signal,
        );
        if (canonicalJson(ref) !== canonicalJson(expected.ref))
          throw new ProtocolError(
            "event_conflict",
            "Activity rebuild differs from saved state",
          );
        const activity = await this.activityIndex.checkpoint(
          rows,
          this.binding,
          signal,
        );
        const head = await this.content.publishCheckpoint(
          expected,
          { ...expected, activity },
          signal,
        );
        this.activityRoot = rows;
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
        let candidate = this.root,
          rows = this.activityRoot;
        if (!rows)
          throw new ProtocolError(
            "precondition_failed",
            "Activity index requires history rebuild",
          );
        for (const event of saved) {
          candidate = await this.reducer.apply(candidate, event, signal);
          rows = await this.activityIndex.apply(
            rows,
            event,
            candidate,
            this.reducer,
            signal,
          );
        }
        const ref = await this.reducer.checkpoint(
          candidate,
          this.binding,
          signal,
        );
        const activity = await this.activityIndex.checkpoint(
          rows,
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
            activity,
          },
          signal,
        );
        // A timeout after a committed transaction requires reopen; do not guess whether publication happened.
        this.root = candidate;
        this.activityRoot = rows;
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
    return new PagedActivityView(
      this.reducer,
      this.root,
      (ref) => this.textSource(ref),
      this.activityRoot
        ? { index: this.activityIndex, root: this.activityRoot }
        : undefined,
    );
  }
  loadView(signal: AbortSignal) {
    return this.content.loadView(signal);
  }
  saveView(
    view: import("./history-cache.js").BrowserView,
    signal: AbortSignal,
  ) {
    return this.content.saveView(view, signal);
  }
  /** Reconstruct a frozen presentation without changing the durable receipt head. */
  select(
    time: number,
    history: (
      after: number,
      through: number,
      signal: AbortSignal,
    ) => AsyncIterable<StoredEvent>,
    parent: AbortSignal,
    through = this.root.appliedSeq,
  ): Promise<PagedActivityView> {
    if (!Number.isFinite(time) || time < 0)
      return Promise.reject(new RangeError("Invalid playback position"));
    if (this.closing)
      return Promise.reject(new Error("Paged state is closing"));
    if (this.selections.size >= 2)
      return Promise.reject(
        new ProtocolError("retry_later", "Playback selection queue is full"),
      );
    const signal = AbortSignal.any([parent, this.stop.signal]);
    const receipt = this.root,
      receivedRows = this.activityRoot;
    if (
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through > receipt.appliedSeq
    )
      return Promise.reject(
        new RangeError("Invalid playback receipt boundary"),
      );
    const previous = this.selected;
    const task = (async () => {
      signal.throwIfAborted();
      if (!receivedRows)
        throw new ProtocolError(
          "precondition_failed",
          "Activity index requires history rebuild",
        );
      let root =
        receipt.appliedSeq <= through && receipt.timelineMs <= time
          ? receipt
          : previous &&
              previous.root.timelineMs <= time &&
              previous.root.appliedSeq <= through
            ? previous.root
            : initialPagedState();
      let rows =
        root === receipt
          ? receivedRows
          : root === previous?.root
            ? previous.rows
            : initialActivityIndex();
      if (root.appliedSeq < through) {
        let boundary = false;
        for await (const event of cancellableHistory(
          history(root.appliedSeq, through, signal),
          signal,
        )) {
          if (
            event.serverSeq !== root.appliedSeq + 1 ||
            event.serverSeq > through
          )
            throw new ProtocolError(
              "sequence_gap",
              "Playback history is not contiguous",
            );
          if (event.timelineMs > time) {
            boundary = true;
            break;
          }
          root = await this.reducer.apply(root, event, signal);
          rows = await this.activityIndex.apply(
            rows,
            event,
            root,
            this.reducer,
            signal,
          );
        }
        if (!boundary && root.appliedSeq !== through)
          throw new ProtocolError(
            "sequence_gap",
            "Playback history is incomplete",
          );
      }
      signal.throwIfAborted();
      this.selected = { root, rows };
      return new PagedActivityView(
        this.reducer,
        root,
        (ref) => this.textSource(ref),
        { index: this.activityIndex, root: rows },
      );
    })();
    this.selections.add(task);
    void task.finally(() => this.selections.delete(task)).catch(() => {});
    return task;
  }
  close() {
    if (!this.closing) {
      this.stop.abort(new Error("Paged state is closing"));
      this.closing = Promise.allSettled([this.tail, ...this.selections]).then(
        () => this.content.close(),
      );
    }
    return this.closing;
  }
}
