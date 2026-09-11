import { accountFetch } from "./account-transport.js";
import {
  changeTextPage,
  type TextPageChoice,
  type TextPosition,
} from "./inspection-choices.js";
import { changeExpansion } from "./inspection-choices.js";
import { BrowserSnapshotRetention } from "./snapshot-retention.js";
import { spendIdleGap, validateIdleCap } from "./idle-gap.js";
import {
  openRecordingHistory,
  SubscriberClient,
  RecordingSnapshotClient,
} from "@agentlive/client";
import { initialState } from "@agentlive/playback";
import {
  attachmentSchema,
  ProtocolError,
  type StoredEvent,
} from "@agentlive/protocol";
import { BrowserPagedState } from "./paged-state.js";
import type { PagedActivityView } from "./paged-activity.js";
import { MemoryPagedStore } from "./memory-paged-store.js";
import { MemorySnapshotRetention } from "./memory-retention.js";
import {
  BrowserHistoryCache,
  browserCachePlatform,
  CacheAheadError,
  type CachePlatform,
  type BrowserView,
} from "./history-cache.js";

async function persistEvents(
  paged: BrowserPagedState,
  events: readonly StoredEvent[],
  signal: AbortSignal,
  history?: Parameters<BrowserPagedState["select"]>[1],
) {
  let batch: StoredEvent[] = [],
    bytes = 2;
  for (const event of events) {
    const size = new TextEncoder().encode(JSON.stringify(event)).length + 1;
    if (batch.length && (batch.length === 256 || bytes + size > 1024 * 1024)) {
      await paged.apply(batch, signal, history);
      batch = [];
      bytes = 2;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length) await paged.apply(batch, signal, history);
}
/** Production persisted browser receipt; presentation never retains the complete event prefix. */
export class BrowserPagedSession {
  private readonly stop = new AbortController();
  private connection: AbortController | undefined;
  private selection: AbortController | undefined;
  private selectionTask: Promise<void> = Promise.resolve();
  private task: Promise<void> = Promise.resolve();
  private active = true;
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private savePending: import("./history-cache.js").BrowserView | undefined;
  private requestedTime = 0;
  private advancing = false;
  private idleAdvance: AbortController | undefined;
  private idleBudget = 0;
  private idleRunning = false;
  private cancelIdle() {
    this.idleAdvance?.abort();
    if (this.idleAdvance) this.selection?.abort();
    this.idleBudget = 0;
  }
  setIdleCap(cap: number | undefined) {
    validateIdleCap(cap);
    this.cancelIdle();
    this.selection?.abort();
    this.requestedTime = this.time;
    this.idleCapMs = cap;
    this.changed();
    this.scheduleSave(true);
  }
  private closed: Promise<void> | undefined;
  state = initialState();
  view: PagedActivityView;
  time = 0;
  follow = true;
  playing = false;
  speed = 1;
  idleCapMs: number | undefined;
  private gapAnchor = 0;
  status = "connecting";
  private inspectionWrites = new Set<Promise<void>>();
  private saveInspection(write: Promise<void>) {
    const pending = write.catch((error) => this.fail(error));
    this.inspectionWrites.add(pending);
    void pending.finally(() => this.inspectionWrites.delete(pending));
  }
  textPages: readonly TextPageChoice[] = [];
  selectedAttachment: import("./attachments.js").Attachment | undefined;
  setAttachmentChoice(
    value: import("./attachments.js").Attachment | undefined,
  ) {
    if (this.stop.signal.aborted) return;
    this.selectedAttachment =
      value === undefined ? undefined : attachmentSchema.parse(value);
    this.changed();
    this.saveInspection(
      this.paged.setAttachmentChoice(
        this.selectedAttachment,
        AbortSignal.timeout(10000),
      ),
    );
  }
  setTextPage(key: string, page: TextPosition) {
    if (
      this.stop.signal.aborted ||
      this.textPages.find(([id]) => id === key)?.[1] === page
    )
      return;
    this.textPages = changeTextPage(this.textPages, key, page);
    this.changed();
    this.saveInspection(
      this.paged.setTextPage(key, page, AbortSignal.timeout(10000)),
    );
  }
  expandedDisclosures: readonly string[] = [];
  setDisclosure(key: string, expanded: boolean) {
    if (this.stop.signal.aborted) return;
    if (this.expandedDisclosures.includes(key) === expanded) return;
    this.expandedDisclosures = changeExpansion(
      this.expandedDisclosures,
      key,
      expanded,
    );
    this.changed();
    this.saveInspection(
      this.paged.setExpansion(key, expanded, AbortSignal.timeout(10000)),
    );
  }
  error = "";
  private recoveryView: BrowserView | undefined;
  get recoveryPresentation(): BrowserView | undefined {
    return this.recoveryView ? { ...this.recoveryView } : undefined;
  }

  restoredEvents = 0;
  snapshotEvents = 0;
  private constructor(
    readonly title: string,
    readonly streamId: string,
    readonly credential: string,
    private readonly origin: string,
    private readonly revision: string,
    private readonly paged: BrowserPagedState,
    private readonly changed: () => void,
    private readonly snapshots: RecordingSnapshotClient,
    private readonly retention:
      BrowserSnapshotRetention | MemorySnapshotRetention,
    readonly cacheStatus: "saved" | "memory",
    initialView: PagedActivityView,
  ) {
    this.view = initialView;
    this.state = this.view.summary;
    this.time = this.duration;
  }
  get received() {
    return this.paged.state.appliedSeq;
  }
  get duration() {
    return this.paged.state.timelineMs;
  }
  order(_key: string) {
    return 0;
  }
  private fail(error: unknown) {
    if (this.stop.signal.aborted) return;
    const cause =
      error instanceof ProtocolError
        ? error
        : error instanceof Error
          ? error.cause
          : undefined;
    if (cause instanceof ProtocolError && cause.code === "stale_lease")
      this.recoveryView ??= this.presentation();
    this.error = error instanceof Error ? error.message : "Playback failed";
    this.playing = false;
    this.changed();
  }
  private history(
    after: number,
    through: number,
    signal: AbortSignal,
  ): AsyncIterable<StoredEvent> {
    const self = this;
    return (async function* () {
      const history = await openRecordingHistory({
        fetch: accountFetch,
        serverOrigin: self.origin,
        streamId: self.streamId,
        ...(self.credential ? { credential: self.credential } : {}),
        signal,
      });
      if (history.metadata.revision !== self.revision)
        throw new ProtocolError(
          "revision_changed",
          "Recording revision changed",
        );
      if (history.metadata.serverSeq < through)
        throw new CacheAheadError(
          "Saved receipt exceeds server history; clear saved histories explicitly to reload.",
        );
      yield* history.range({
        afterServerSeq: after,
        throughServerSeq: through,
      });
    })();
  }
  static async open(
    streamId: string,
    credential: string,
    signal: AbortSignal,
    changed: () => void,
    origin = location.origin,
    options: {
      cache?: boolean;
      platform?: CachePlatform;
      resumeView?: BrowserView;
    } = {},
  ): Promise<BrowserPagedSession> {
    try {
      return await this.openOnce(
        streamId,
        credential,
        signal,
        changed,
        origin,
        options,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProtocolError) || error.code !== "stale_lease")
        throw error;
      // openOnce drains each partially opened store before throwing. A different
      // tab may have advanced its generation while these connections opened.
      return this.openOnce(
        streamId,
        credential,
        signal,
        changed,
        origin,
        options,
      );
    }
  }
  private static async openOnce(
    streamId: string,
    credential: string,
    signal: AbortSignal,
    changed: () => void,
    origin: string,
    options: {
      cache?: boolean;
      platform?: CachePlatform;
      resumeView?: BrowserView;
    },
  ): Promise<BrowserPagedSession> {
    const platform = options.platform ?? browserCachePlatform();
    const persistent = options.cache !== false && !!platform;
    let history = await openRecordingHistory({
      fetch: accountFetch,
      serverOrigin: origin,
      streamId,
      ...(credential ? { credential } : {}),
      signal,
    });
    const snapshots = new RecordingSnapshotClient({
      fetch: accountFetch,
      serverOrigin: origin,
      streamId,
      revision: history.metadata.revision,
      ...(credential ? { credential } : {}),
    });
    const binding = {
      serverOrigin: origin,
      streamId,
      revision: history.metadata.revision,
    };
    const { retention, recoveryThrough } = persistent
      ? await BrowserSnapshotRetention.open(
          platform!.indexedDB,
          binding,
          snapshots,
          signal,
        ).catch((error) => {
          snapshots.close();
          throw error;
        })
      : {
          retention: new MemorySnapshotRetention(snapshots),
          recoveryThrough: 0,
        };
    let paged: BrowserPagedState;
    try {
      paged = persistent
        ? await BrowserPagedState.open(
            platform!.indexedDB,
            binding,
            signal,
            (ref, active) => retention.readBlob(ref, active),
          )
        : await BrowserPagedState.openContent(
            new MemoryPagedStore(binding, {
              loader: (ref, active) => retention.readBlob(ref, active),
            }),
            binding,
            signal,
          );
    } catch (error) {
      await retention.close();
      snapshots.close();
      throw error;
    }
    let session: BrowserPagedSession | undefined;
    try {
      if (recoveryThrough) {
        if (recoveryThrough > history.metadata.serverSeq)
          throw new CacheAheadError("Saved receipt exceeds server history");
        let recovered: StoredEvent[] = [],
          recoveredBytes = 2;
        for await (const event of history.range({
          throughServerSeq: recoveryThrough,
          afterServerSeq: paged.state.appliedSeq,
        })) {
          const size =
            new TextEncoder().encode(JSON.stringify(event)).length + 1;
          if (
            recovered.length &&
            (recovered.length === 256 || recoveredBytes + size > 1048576)
          ) {
            await persistEvents(paged, recovered, signal);
            recovered = [];
            recoveredBytes = 2;
          }
          recovered.push(event);
          recoveredBytes += size;
        }
        if (recovered.length) await persistEvents(paged, recovered, signal);
        await retention.finishRecovery(signal);
      }
      if (paged.state.appliedSeq > history.metadata.serverSeq) {
        const current = await openRecordingHistory({
          fetch: accountFetch,
          serverOrigin: origin,
          streamId,
          ...(credential ? { credential } : {}),
          signal,
        });
        if (
          current.metadata.revision !== history.metadata.revision ||
          current.metadata.serverSeq < paged.state.appliedSeq
        )
          throw new CacheAheadError(
            "Saved receipt exceeds server history; clear saved histories explicitly to reload.",
          );
        history = current;
      }
      if (paged.needsActivityRebuild)
        await paged.rebuildActivity(
          history.range({ throughServerSeq: paged.state.appliedSeq }),
          signal,
        );
      if (persistent && !(await paged.loadView(signal))) {
        const legacy = await BrowserHistoryCache.open(
          {
            serverOrigin: origin,
            streamId,
            revision: history.metadata.revision,
          },
          platform!,
          signal,
        );
        try {
          // A one-time migration retains the former cache's existing 64 MiB bound.
          const events = await legacy.read(history.metadata.serverSeq, signal);
          if (events.length) {
            await persistEvents(
              paged,
              events.slice(paged.state.appliedSeq),
              signal,
            );
            const saved = legacy.loadView();
            if (saved) await paged.saveView(saved, signal);
          }
        } finally {
          legacy.close();
        }
      }
      const restoredEvents = paged.state.appliedSeq;
      let snapshotEvents = 0;
      if (!paged.checkpoint) {
        const selected = await retention.select(
          history.metadata.serverSeq,
          signal,
        );
        if (selected?.format === "agentlive.paged-state" && selected.activity) {
          await paged.adoptSnapshot(selected, signal);
          snapshotEvents = selected.serverSeq;
        }
      }
      // A fresh memory visit has no saved receipt. Rebuild through the server's
      // frozen boundary before validating a recovery presentation descriptor.
      if (!persistent && options.resumeView) {
        let batch: StoredEvent[] = [],
          bytes = 2;
        for await (const event of history.range({
          afterServerSeq: paged.state.appliedSeq,
          throughServerSeq: history.metadata.serverSeq,
        })) {
          const size =
            new TextEncoder().encode(JSON.stringify(event)).length + 1;
          if (
            batch.length &&
            (batch.length === 256 || bytes + size > 1048576)
          ) {
            await persistEvents(paged, batch, signal);
            batch = [];
            bytes = 2;
          }
          batch.push(event);
          bytes += size;
        }
        if (batch.length) await persistEvents(paged, batch, signal);
      }
      session = new BrowserPagedSession(
        history.metadata.title,
        streamId,
        credential,
        origin,
        history.metadata.revision,
        paged,
        changed,
        snapshots,
        retention,
        persistent ? "saved" : "memory",
        await paged.retainedView(signal, (...args) =>
          session!.history(...args),
        ),
      );
      session.textPages = await paged.loadTextPages(signal);
      session.selectedAttachment = await paged.loadAttachmentChoice(signal);
      session.expandedDisclosures = await paged.loadExpansions(signal);
      session.restoredEvents = restoredEvents;
      session.snapshotEvents = snapshotEvents;
      const saved = options.resumeView ?? (await paged.loadView(signal));
      if (saved) {
        if (options.resumeView) await paged.saveView(saved, signal);
        session.speed = saved.speed;
        session.idleCapMs = saved.idleCapMs;
        if (
          saved.serverSeq > session.received ||
          saved.timelineMs > session.duration
        )
          throw new CacheAheadError("Saved playback exceeds receipt");
        if (saved.mode !== "follow") {
          if (saved.serverSeq < session.received) {
            const next = await history
              .range({
                afterServerSeq: saved.serverSeq,
                throughServerSeq: saved.serverSeq + 1,
              })
              .next();
            if (next.done || saved.timelineMs > next.value.timelineMs)
              throw new Error("Saved playback time exceeds its event boundary");
          }
          const view = await paged.select(
            saved.timelineMs,
            session.history.bind(session),
            signal,
            saved.serverSeq,
            false,
            session.remoteSnapshot.bind(session),
          );
          // Preserve the exact paused prefix, including when later receipt adds timestamp ties.
          if (view.sequence !== saved.serverSeq)
            throw new Error("Saved playback boundary is inconsistent");
          session.acceptView(view, signal);
          session.state = view.summary;
          session.time = saved.timelineMs;
          session.gapAnchor = Math.max(
            session.state.timelineMs,
            saved.gapAnchorMs ?? saved.timelineMs,
          );
          session.follow = false;
          session.playing = saved.mode === "playing";
        }
      }
      signal.throwIfAborted();
      const live = session;
      const active = AbortSignal.any([signal, live.stop.signal]);
      const client = new SubscriberClient({
        fetch: accountFetch,
        serverOrigin: origin,
        cursor: {
          streamId,
          revision: history.metadata.revision,
          serverSeq: live.received,
        },
        ...(credential ? { credential } : {}),
        onStatus: (status) => {
          live.status =
            status === "stopped" && !active.aborted
              ? live.active
                ? "reconnecting"
                : "suspended"
              : status;
          changed();
        },
        commit: async (events) => {
          // The transport batch may exceed reducer admission: publish complete contiguous sub-batches.
          // If a later sub-batch fails, reconnect starts from the durable head after reopen.
          await persistEvents(paged, events, active, live.history.bind(live));
          if (live.follow) await live.presentLatest();
          else changed();
          live.scheduleSave();
        },
      });
      live.task = live
        .receive(client, active)
        .catch((error) => {
          if (!active.aborted) {
            live.status = "error";
            live.fail(error);
          }
        })
        .finally(async () => {
          live.selection?.abort();
          await live.selectionTask;
          await live.view.close();
          await Promise.all(live.retiringViews);
          await live.flushSave();
          await Promise.all(live.inspectionWrites);
          await paged.close();
          await retention.close();
          snapshots.close();
          if (!live.error) live.status = "stopped";
          changed();
        });
      return live;
    } catch (error) {
      await paged.close();
      await retention.close();
      snapshots.close();
      throw error;
    }
  }
  private async remoteSnapshot(
    time: number,
    through: number,
    signal: AbortSignal,
  ) {
    return this.retention.select(through, signal, time);
  }
  private async receive(client: SubscriberClient, signal: AbortSignal) {
    while (!signal.aborted) {
      if (!this.active) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            this.wake = undefined;
            resolve();
          };
          this.wake = wake;
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted || this.active) wake();
        });
        continue;
      }
      this.connection = new AbortController();
      try {
        await client.run(AbortSignal.any([signal, this.connection.signal]));
      } finally {
        this.connection = undefined;
      }
    }
  }
  setActive(active: boolean) {
    if (this.active === active || this.stop.signal.aborted) return;
    this.active = active;
    this.connection?.abort();
    this.wake?.();
    if (!active) void this.flushSave();
  }
  reconnect() {
    if (this.active) this.connection?.abort();
  }
  setPlaying(playing: boolean) {
    this.cancelIdle();
    this.selection?.abort();
    this.playing = playing;
    this.follow = false;
    this.requestedTime = this.time;
    this.changed();
    this.scheduleSave(true);
  }
  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 1 / 1024 || speed > 1024)
      throw new RangeError("Invalid playback speed");
    this.speed = speed;
    this.changed();
    this.scheduleSave(true);
  }
  private retiringViews = new Set<Promise<void>>();
  private replaceView(view: PagedActivityView) {
    const previous = this.view;
    this.view = view;
    if (previous === view) return;
    this.retireView(previous);
  }
  private retireView(view: PagedActivityView) {
    const retiring = view.close().catch((error) => this.fail(error));
    this.retiringViews.add(retiring);
    void retiring.finally(() => this.retiringViews.delete(retiring));
  }
  private acceptView(view: PagedActivityView, signal: AbortSignal) {
    if (signal.aborted) {
      this.retireView(view);
      signal.throwIfAborted();
    }
    this.replaceView(view);
  }
  private presentLatest(): Promise<void> {
    this.selection?.abort();
    const abort = new AbortController();
    this.selection = abort;
    const signal = AbortSignal.any([abort.signal, this.stop.signal]);
    this.selectionTask = this.selectionTask
      .then(async () => {
        signal.throwIfAborted();
        const view = await this.paged.retainedView(
          signal,
          this.history.bind(this),
        );
        this.acceptView(view, signal);
        this.state = view.summary;
        this.time = view.summary.timelineMs;
        this.gapAnchor = this.time;
        this.changed();
      })
      .catch((error) => {
        if (!signal.aborted) this.fail(error);
      });
    return this.selectionTask;
  }
  seek(time: number, follow = false, persistSelection = true): Promise<void> {
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError("Invalid playback position");
    if (persistSelection) {
      this.cancelIdle();
      this.gapAnchor = Math.min(time, this.duration);
    }
    this.selection?.abort();
    this.follow = follow;
    if (follow) {
      this.playing = false;
      return this.presentLatest().then(() => this.scheduleSave(true));
    }
    const target = Math.min(time, this.duration);
    this.requestedTime = target;
    const abort = new AbortController();
    this.selection = abort;
    const signal = AbortSignal.any([abort.signal, this.stop.signal]);
    // Drain the superseded selection before admitting another; receipt stays independent.
    this.selectionTask = this.selectionTask
      .then(async () => {
        signal.throwIfAborted();
        const view = await this.paged.select(
          target,
          this.history.bind(this),
          signal,
          undefined,
          persistSelection,
          this.remoteSnapshot.bind(this),
        );
        this.acceptView(view, signal);
        this.state = view.summary;
        this.time = target;
        this.error = "";
        this.changed();
        this.scheduleSave();
      })
      .catch((error) => {
        if (!abort.signal.aborted) this.fail(error);
      });
    return this.selectionTask;
  }
  step(direction: -1 | 1): Promise<void> {
    if (direction !== -1 && direction !== 1)
      throw new RangeError("Invalid step direction");
    this.selection?.abort();
    this.cancelIdle();
    this.playing = false;
    this.follow = false;
    const through = Math.max(
      0,
      Math.min(this.received, this.state.appliedSeq + direction),
    );
    const abort = new AbortController();
    this.selection = abort;
    const signal = AbortSignal.any([abort.signal, this.stop.signal]);
    this.changed();
    this.selectionTask = this.selectionTask
      .then(async () => {
        signal.throwIfAborted();
        let time = 0;
        if (through) {
          let found = false;
          for await (const event of this.history(
            through - 1,
            through,
            signal,
          )) {
            time = event.timelineMs;
            found = true;
          }
          if (!found)
            throw new ProtocolError(
              "sequence_gap",
              "Step boundary is unavailable",
            );
        }
        const view = await this.paged.select(
          time,
          this.history.bind(this),
          signal,
          through,
          true,
          this.remoteSnapshot.bind(this),
        );
        if (signal.aborted) {
          await view.close();
          signal.throwIfAborted();
        }
        if (view.sequence !== through) {
          await view.close();
          throw new ProtocolError(
            "sequence_gap",
            "Step selected the wrong prefix",
          );
        }
        this.acceptView(view, signal);
        this.state = view.summary;
        this.time = time;
        this.requestedTime = time;
        this.gapAnchor = time;
        this.error = "";
        this.changed();
        this.scheduleSave(true);
      })
      .catch((error) => {
        if (!abort.signal.aborted) this.fail(error);
      });
    return this.selectionTask;
  }
  advance(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new RangeError("Invalid playback elapsed time");
    if (!this.playing) return;
    if (this.idleCapMs !== undefined) {
      this.idleBudget += elapsedMs * this.speed;
      this.advanceCompressed();
      return;
    }
    this.requestedTime = Math.min(
      this.duration,
      Math.max(this.requestedTime, this.time) + elapsedMs * this.speed,
    );
    if (this.advancing) return;
    this.advancing = true;
    void (async () => {
      while (
        this.playing &&
        this.idleCapMs === undefined &&
        !this.stop.signal.aborted &&
        this.requestedTime > this.time
      ) {
        const target = this.requestedTime;
        await this.seek(target, false, false);
        this.gapAnchor = Math.max(this.gapAnchor, this.state.timelineMs);
        if (this.error || this.time < target) break;
      }
    })()
      .finally(() => {
        this.advancing = false;
      })
      .catch((error) => this.fail(error));
  }
  private advanceCompressed() {
    if (this.idleRunning) return;
    this.idleRunning = true;
    const abort = new AbortController();
    this.idleAdvance = abort;
    const signal = AbortSignal.any([abort.signal, this.stop.signal]);
    void (async () => {
      do {
        signal.throwIfAborted();
        const cap = this.idleCapMs!;
        let time = this.time,
          anchor = this.gapAnchor,
          budget = this.idleBudget;
        this.idleBudget = 0;
        const through = Math.min(this.received, this.state.appliedSeq + 256);
        if (through === this.state.appliedSeq) break;
        // Bound each lookahead independently of recording length; no event-prefix array.
        for await (const event of this.history(
          this.state.appliedSeq,
          through,
          signal,
        )) {
          const next = spendIdleGap(
            time,
            anchor,
            event.timelineMs,
            budget,
            cap,
          );
          ({ time, anchor, budget } = next);
          if (!next.admitted) break;
        }
        signal.throwIfAborted();
        await this.seek(time, false, false);
        signal.throwIfAborted();
        if (this.error) break;
        this.gapAnchor = Math.max(anchor, this.state.timelineMs);
        this.idleBudget += budget;
      } while (this.playing && this.idleBudget > 0);
    })()
      .catch((error) => {
        if (!signal.aborted) this.fail(error);
      })
      .finally(() => {
        this.idleRunning = false;
        if (this.idleAdvance === abort) this.idleAdvance = undefined;
        if (
          this.playing &&
          !this.stop.signal.aborted &&
          this.idleCapMs !== undefined &&
          this.idleBudget > 0
        )
          this.advanceCompressed();
      });
  }
  private scheduleSave(immediate = false) {
    if (immediate) {
      void this.flushSave();
      return;
    }
    if (this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flushSave();
      }, 1000);
  }
  private presentation(): BrowserView {
    return {
      serverSeq: this.state.appliedSeq,
      timelineMs: this.time,
      speed: this.speed,
      gapAnchorMs: Math.min(
        this.time,
        Math.max(this.state.timelineMs, this.gapAnchor),
      ),
      ...(this.idleCapMs === undefined ? {} : { idleCapMs: this.idleCapMs }),
      mode: this.follow
        ? ("follow" as const)
        : this.playing
          ? ("playing" as const)
          : ("paused" as const),
    };
  }
  private flushSave(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const saved = this.presentation();
    this.savePending = saved;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.savePending) {
        const next = this.savePending;
        this.savePending = undefined;
        await this.paged.saveView(next, AbortSignal.timeout(10000));
      }
    })()
      .catch((error) => {
        this.savePending = undefined;
        this.fail(error);
      })
      .finally(() => {
        this.saving = undefined;
        if (this.savePending) return this.flushSave();
      });
    return this.saving;
  }
  close() {
    if (!this.closed) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.stop.abort();
      this.selection?.abort();
      this.wake?.();
      this.closed = this.task;
    }
    return this.closed;
  }
}
