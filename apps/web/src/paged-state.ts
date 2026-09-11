import { PagedActivityView } from "./paged-activity.js";
import { operationSignal } from "./operation-signal.js";
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
  snapshotDescriptorSchema,
  type SnapshotDescriptor,
} from "@agentlive/protocol";
import {
  BrowserContentStore,
  type BrowserCheckpoint,
  type SnapshotBlobLoader,
} from "./content-store.js";
import type { CacheBinding } from "./history-cache.js";
/** Storage operations required by receipt and presentation; no platform dependency. */
export type PagedContentStore = Pick<
  BrowserContentStore,
  | "put"
  | "append"
  | "read"
  | "loadCheckpoint"
  | "loadCheckpointBefore"
  | "publishCheckpoint"
  | "saveSeekCheckpoint"
  | "loadView"
  | "saveView"
  | "loadAttachmentChoice"
  | "setAttachmentChoice"
  | "loadTextPages"
  | "setTextPage"
  | "loadExpansions"
  | "setExpansion"
  | "close"
> & {
  beginWork?: () => () => void;
  acquireWork?: () => Promise<() => void>;
  maintain?: () => Promise<void>;
  pinCheckpoint?: (
    checkpoint: BrowserCheckpoint,
    signal: AbortSignal,
  ) => Promise<symbol>;
  releasePin?: (token: symbol, signal: AbortSignal) => Promise<void>;
};
/** Bound each source read; cancellation must not wait for an uncooperative iterator. */
async function* cancellableHistory(
  history: AsyncIterable<StoredEvent>,
  parent: AbortSignal,
) {
  const iterator = history[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const deadline = operationSignal([parent], 10000);
      const signal = deadline.signal;
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
      ).finally(() => deadline.dispose());
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
  private retainedViews = new Set<PagedActivityView>();
  private constructor(
    private readonly content: PagedContentStore,
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
    loader?: SnapshotBlobLoader,
  ) {
    binding = { ...binding };
    const content = await BrowserContentStore.open(
      factory,
      binding,
      signal,
      undefined,
      loader,
    );
    return this.openContent(content, binding, signal);
  }
  /** Takes ownership of the backend, including cleanup if opening fails. */
  static async openContent(
    content: PagedContentStore,
    binding: CacheBinding,
    signal: AbortSignal,
  ) {
    binding = { ...binding };
    let release: (() => void) | undefined;
    try {
      release = content.acquireWork
        ? await content.acquireWork()
        : content.beginWork?.();
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
    } finally {
      release?.();
    }
  }
  private async withRootWork<T>(
    work: (
      checkpoint: (
        root: PagedRecordingState,
        rows: ActivityIndexRoot,
        signal: AbortSignal,
      ) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    let release = this.content.acquireWork
      ? await this.content.acquireWork()
      : this.content.beginWork?.();
    try {
      return await work(async (root, rows, signal) => {
        if (
          !this.content.pinCheckpoint ||
          !this.content.acquireWork ||
          !release
        )
          return;
        const pinned = await this.retainPresentation(root, rows, signal);
        try {
          release();
          release = undefined;
          await this.content.maintain?.();
          release = await this.content.acquireWork();
          signal.throwIfAborted();
        } finally {
          await pinned.close();
        }
      });
    } finally {
      release?.();
      if (!this.closing) await this.content.maintain?.();
    }
  }
  private async snapshotRoots(input: SnapshotDescriptor, signal: AbortSignal) {
    const descriptor = snapshotDescriptorSchema.parse(input);
    if (descriptor.format !== "agentlive.paged-state" || !descriptor.activity)
      throw new ProtocolError(
        "precondition_failed",
        "Snapshot requires paired activity state",
      );
    const root = await this.reducer.open(descriptor.ref, this.binding, signal);
    const rows = await this.activityIndex.open(
      descriptor.activity,
      this.binding,
      signal,
    );
    if (
      root.appliedSeq !== descriptor.serverSeq ||
      root.timelineMs !== descriptor.timelineMs ||
      rows.appliedSeq !== root.appliedSeq ||
      rows.gaps !== (root.maps.gaps?.size ?? 0)
    )
      throw new ProtocolError(
        "corrupt_storage",
        "Snapshot checkpoint boundaries differ",
      );
    return { root, rows };
  }
  /** Adopt a verified server prefix; its remaining immutable blobs load through the scoped backend. */
  adoptSnapshot(input: SnapshotDescriptor, parent: AbortSignal): Promise<void> {
    const parsed = snapshotDescriptorSchema.parse(input);
    if (parsed.format !== "agentlive.paged-state" || !parsed.activity)
      return Promise.reject(
        new ProtocolError(
          "precondition_failed",
          "Snapshot requires paired activity state",
        ),
      );
    if (this.closing)
      return Promise.reject(new Error("Paged state is closing"));
    if (this.pending >= 16)
      return Promise.reject(
        new ProtocolError("retry_later", "Paged state queue is full"),
      );
    const next: BrowserCheckpoint = {
      format: parsed.format,
      serverSeq: parsed.serverSeq,
      timelineMs: parsed.timelineMs,
      ref: parsed.ref,
      activity: parsed.activity,
    };
    const signal = AbortSignal.any([parent, this.stop.signal]);
    this.pending++;
    const task = this.tail
      .then(() =>
        this.withRootWork(async () => {
          signal.throwIfAborted();
          const { root, rows } = await this.snapshotRoots(parsed, signal);
          const head = await this.content.publishCheckpoint(
            this.head,
            next,
            signal,
          );
          this.root = root;
          this.activityRoot = rows;
          this.head = head;
        }),
      )
      .finally(() => {
        this.pending--;
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
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
      .then(() =>
        this.withRootWork(async () => {
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
        }),
      )
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
  private async rebuildReceipt(
    history: Parameters<BrowserPagedState["select"]>[1],
    signal: AbortSignal,
  ) {
    const expected = this.head;
    let root = initialPagedState(),
      rows = initialActivityIndex();
    let batch: StoredEvent[] = [],
      bytes = 2;
    const flush = async () => {
      root = await this.reducer.applyBatch(
        root,
        batch,
        signal,
        async (reduced, group) => {
          rows =
            group.length > 1
              ? this.activityIndex.advanceAppends(rows, group, reduced)
              : await this.activityIndex.apply(
                  rows,
                  group[0]!,
                  reduced,
                  this.reducer,
                  signal,
                );
        },
      );
      batch = [];
      bytes = 2;
    };
    for await (const event of cancellableHistory(
      history(0, this.root.appliedSeq, signal),
      signal,
    )) {
      if (event.serverSeq > this.root.appliedSeq)
        throw new ProtocolError(
          "sequence_gap",
          "Receipt recovery exceeds saved boundary",
        );
      const size = new TextEncoder().encode(canonicalJson(event)).length + 1;
      if (batch.length && (batch.length === 256 || bytes + size > 1048576))
        await flush();
      batch.push(event);
      bytes += size;
    }
    if (batch.length) await flush();
    if (root.appliedSeq !== this.root.appliedSeq)
      throw new ProtocolError("sequence_gap", "Receipt recovery is incomplete");
    if (expected) {
      const ref = await this.reducer.checkpoint(root, this.binding, signal);
      const activity = await this.activityIndex.checkpoint(
        rows,
        this.binding,
        signal,
      );
      if (
        canonicalJson(ref) !== canonicalJson(expected.ref) ||
        canonicalJson(activity) !== canonicalJson(expected.activity)
      )
        throw new ProtocolError(
          "event_conflict",
          "Recovered receipt differs from committed roots",
        );
    }
    return { root, rows };
  }
  apply(
    events: readonly StoredEvent[],
    parent: AbortSignal,
    history?: Parameters<BrowserPagedState["select"]>[1],
  ): Promise<void> {
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
      .then(() =>
        this.withRootWork(async () => {
          signal.throwIfAborted();
          if (!saved.length) return;
          let candidate = this.root,
            rows = this.activityRoot;
          if (!rows)
            throw new ProtocolError(
              "precondition_failed",
              "Activity index requires history rebuild",
            );
          const reduce = async () => {
            candidate = await this.reducer.applyBatch(
              candidate,
              saved,
              signal,
              async (reduced, group) => {
                rows =
                  group.length > 1
                    ? this.activityIndex.advanceAppends(rows!, group, reduced)
                    : await this.activityIndex.apply(
                        rows!,
                        group[0]!,
                        reduced,
                        this.reducer,
                        signal,
                      );
              },
            );
          };
          try {
            await reduce();
          } catch (error) {
            signal.throwIfAborted();
            if (
              !history ||
              !(error instanceof ProtocolError) ||
              error.code !== "stale_lease"
            )
              throw error;
            const rebuilt = await this.rebuildReceipt(history, signal);
            candidate = rebuilt.root;
            rows = rebuilt.rows;
            await reduce();
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
        }),
      )
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
  view(
    history?: Parameters<BrowserPagedState["select"]>[1],
  ): PagedActivityView {
    if (this.content.pinCheckpoint)
      throw new Error("Memory views require retainedView");
    const boundary = this.root;
    return new PagedActivityView(
      this.reducer,
      this.root,
      (ref) => this.textSource(ref),
      this.activityRoot
        ? { index: this.activityIndex, root: this.activityRoot }
        : undefined,
      history
        ? async (signal) => {
            await this.selectAttempt(
              boundary.timelineMs,
              history,
              signal,
              boundary.appliedSeq,
              false,
              undefined,
              true,
            );
          }
        : undefined,
    );
  }
  async retainedView(
    signal: AbortSignal,
    history?: Parameters<BrowserPagedState["select"]>[1],
  ): Promise<PagedActivityView> {
    if (this.closing) throw new Error("Paged state is closing");
    if (this.selections.size >= 2)
      throw new ProtocolError(
        "retry_later",
        "Playback selection queue is full",
      );
    const task = this.withRootWork(() => {
      const root = this.root,
        rows = this.activityRoot;
      if (!rows)
        throw new ProtocolError(
          "precondition_failed",
          "Activity index requires history rebuild",
        );
      return this.retainPresentation(
        root,
        rows,
        AbortSignal.any([signal, this.stop.signal]),
        history
          ? async (active) => {
              const recovered = await this.selectAttempt(
                root.timelineMs,
                history,
                active,
                root.appliedSeq,
                false,
                undefined,
                true,
              );
              await recovered.close();
            }
          : undefined,
      );
    });
    this.selections.add(task);
    try {
      return await task;
    } finally {
      this.selections.delete(task);
    }
  }
  private async retainPresentation(
    root: PagedRecordingState,
    rows: ActivityIndexRoot,
    signal: AbortSignal,
    recover?: (signal: AbortSignal) => Promise<void>,
  ) {
    let release: (() => Promise<void>) | undefined;
    if (this.content.pinCheckpoint) {
      if (!this.content.releasePin) throw new Error("Pin release is required");
      const descriptor: BrowserCheckpoint = {
        format: "agentlive.paged-state",
        serverSeq: root.appliedSeq,
        timelineMs: root.timelineMs,
        ref: await this.reducer.checkpoint(root, this.binding, signal),
        activity: await this.activityIndex.checkpoint(
          rows,
          this.binding,
          signal,
        ),
      };
      const token = await this.content.pinCheckpoint(descriptor, signal);
      release = () =>
        this.content.releasePin!(token, AbortSignal.timeout(10000));
    }
    const view = new PagedActivityView(
      this.reducer,
      root,
      (ref) => this.textSource(ref),
      { index: this.activityIndex, root: rows },
      recover,
      async () => {
        try {
          await release?.();
        } finally {
          this.retainedViews.delete(view);
        }
      },
    );
    if (release) this.retainedViews.add(view);
    return view;
  }
  loadAttachmentChoice(signal: AbortSignal) {
    return this.content.loadAttachmentChoice(signal);
  }
  setAttachmentChoice(
    value: import("./attachments.js").Attachment | undefined,
    signal: AbortSignal,
  ) {
    return this.content.setAttachmentChoice(value, signal);
  }
  loadTextPages(signal: AbortSignal) {
    return this.content.loadTextPages(signal);
  }
  setTextPage(
    key: string,
    page: import("./inspection-choices.js").TextPosition,
    signal: AbortSignal,
  ) {
    return this.content.setTextPage(key, page, signal);
  }
  loadExpansions(signal: AbortSignal) {
    return this.content.loadExpansions(signal);
  }
  setExpansion(key: string, expanded: boolean, signal: AbortSignal) {
    return this.content.setExpansion(key, expanded, signal);
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
  async select(
    time: number,
    history: (
      after: number,
      through: number,
      signal: AbortSignal,
    ) => AsyncIterable<StoredEvent>,
    parent: AbortSignal,
    through = this.root.appliedSeq,
    persistSelection = false,
    remote?: (
      time: number,
      through: number,
      signal: AbortSignal,
    ) => Promise<SnapshotDescriptor | null>,
  ): Promise<PagedActivityView> {
    try {
      return await this.selectAttempt(
        time,
        history,
        parent,
        through,
        persistSelection,
        remote,
      );
    } catch (error) {
      parent.throwIfAborted();
      this.stop.signal.throwIfAborted();
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      return this.selectAttempt(
        time,
        history,
        parent,
        through,
        persistSelection,
        undefined,
        true,
      );
    }
  }
  private selectAttempt(
    time: number,
    history: (
      after: number,
      through: number,
      signal: AbortSignal,
    ) => AsyncIterable<StoredEvent>,
    parent: AbortSignal,
    through = this.root.appliedSeq,
    persistSelection = false,
    remote?: (
      time: number,
      through: number,
      signal: AbortSignal,
    ) => Promise<SnapshotDescriptor | null>,
    rebuild = false,
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
    if (
      !Number.isSafeInteger(through) ||
      through < 0 ||
      through > this.root.appliedSeq
    )
      return Promise.reject(
        new RangeError("Invalid playback receipt boundary"),
      );
    const previous = this.content.pinCheckpoint ? undefined : this.selected;
    const task = this.withRootWork(async (checkpointWork) => {
      signal.throwIfAborted();
      const receipt = this.root,
        receivedRows = this.activityRoot;
      if (!receivedRows)
        throw new ProtocolError(
          "precondition_failed",
          "Activity index requires history rebuild",
        );
      let root =
        !rebuild && receipt.appliedSeq <= through && receipt.timelineMs <= time
          ? receipt
          : !rebuild &&
              previous &&
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
      if (!rebuild && root.appliedSeq < through) {
        const checkpoint = await this.content.loadCheckpointBefore(
          time,
          through,
          signal,
        );
        if (checkpoint && checkpoint.serverSeq > root.appliedSeq) {
          const restored = await this.reducer.open(
            checkpoint.ref,
            this.binding,
            signal,
          );
          const restoredRows = await this.activityIndex.open(
            checkpoint.activity!,
            this.binding,
            signal,
          );
          if (
            restored.appliedSeq !== checkpoint.serverSeq ||
            restored.timelineMs !== checkpoint.timelineMs ||
            restoredRows.appliedSeq !== restored.appliedSeq ||
            restoredRows.gaps !== (restored.maps.gaps?.size ?? 0)
          )
            throw new ProtocolError(
              "corrupt_storage",
              "Seek checkpoint boundaries differ",
            );
          root = restored;
          rows = restoredRows;
        }
      }
      if (remote && root.appliedSeq < through && root.timelineMs < time) {
        const descriptor = await remote(time, through, signal);
        signal.throwIfAborted();
        if (descriptor) {
          if (descriptor.serverSeq > through || descriptor.timelineMs > time)
            throw new ProtocolError(
              "sequence_gap",
              "Remote snapshot exceeds seek boundary",
            );
          if (
            descriptor.format === "agentlive.paged-state" &&
            descriptor.activity &&
            descriptor.serverSeq > root.appliedSeq
          ) {
            const restored = await this.snapshotRoots(descriptor, signal);
            root = restored.root;
            rows = restored.rows;
          }
        }
      }
      if (root.appliedSeq < through) {
        let boundary = false,
          received = root.appliedSeq,
          bytes = 2;
        let batch: StoredEvent[] = [];
        const flush = async () => {
          root = await this.reducer.applyBatch(
            root,
            batch,
            signal,
            async (reduced, group) => {
              rows =
                group.length > 1
                  ? this.activityIndex.advanceAppends(rows, group, reduced)
                  : await this.activityIndex.apply(
                      rows,
                      group[0]!,
                      reduced,
                      this.reducer,
                      signal,
                    );
            },
          );
          batch = [];
          bytes = 2;
          await checkpointWork(root, rows, signal);
        };
        for await (const event of cancellableHistory(
          history(root.appliedSeq, through, signal),
          signal,
        )) {
          if (event.serverSeq !== ++received || event.serverSeq > through)
            throw new ProtocolError(
              "sequence_gap",
              "Playback history is not contiguous",
            );
          if (event.timelineMs > time) {
            boundary = true;
            break;
          }
          const size =
            new TextEncoder().encode(JSON.stringify(event)).length + 1;
          if (batch.length && (batch.length === 256 || bytes + size > 1048576))
            await flush();
          batch.push(event);
          bytes += size;
        }
        if (batch.length) await flush();
        if (!boundary && root.appliedSeq !== through)
          throw new ProtocolError(
            "sequence_gap",
            "Playback history is incomplete",
          );
      }
      signal.throwIfAborted();
      if (
        persistSelection &&
        root.appliedSeq > 0 &&
        root.appliedSeq < receipt.appliedSeq
      ) {
        const ref = await this.reducer.checkpoint(root, this.binding, signal);
        const activity = await this.activityIndex.checkpoint(
          rows,
          this.binding,
          signal,
        );
        await this.content.saveSeekCheckpoint(
          {
            format: "agentlive.paged-state",
            serverSeq: root.appliedSeq,
            timelineMs: root.timelineMs,
            ref,
            activity,
          },
          signal,
        );
      }
      if (!this.content.pinCheckpoint) this.selected = { root, rows };
      return this.retainPresentation(root, rows, signal, async (active) => {
        const recovered = await this.selectAttempt(
          root.timelineMs,
          history,
          active,
          root.appliedSeq,
          false,
          undefined,
          true,
        );
        await recovered.close();
      });
    });
    this.selections.add(task);
    void task.finally(() => this.selections.delete(task)).catch(() => {});
    return task;
  }
  close() {
    if (!this.closing) {
      this.stop.abort(new Error("Paged state is closing"));
      this.closing = Promise.allSettled([this.tail, ...this.selections]).then(
        async () => {
          await Promise.allSettled(
            [...this.retainedViews].map((view) => view.close()),
          );
          await this.content.close();
        },
      );
    }
    return this.closing;
  }
}
