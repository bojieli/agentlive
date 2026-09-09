import { openRecordingHistory, SubscriberClient } from "@agentlive/client";
import { initialState } from "@agentlive/playback";
import { ProtocolError, type StoredEvent } from "@agentlive/protocol";
import { BrowserPagedState } from "./paged-state.js";
import type { PagedActivityView } from "./paged-activity.js";
import { BrowserSession } from "./session.js";
import {
  BrowserHistoryCache,
  browserCachePlatform,
  CacheAheadError,
  type CachePlatform,
} from "./history-cache.js";

async function persistEvents(
  paged: BrowserPagedState,
  events: readonly StoredEvent[],
  signal: AbortSignal,
) {
  let batch: StoredEvent[] = [],
    bytes = 2;
  for (const event of events) {
    const size = new TextEncoder().encode(JSON.stringify(event)).length + 1;
    if (batch.length && (batch.length === 256 || bytes + size > 1024 * 1024)) {
      await paged.apply(batch, signal);
      batch = [];
      bytes = 2;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length) await paged.apply(batch, signal);
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
  private closed: Promise<void> | undefined;
  state = initialState();
  view: PagedActivityView;
  time = 0;
  follow = true;
  playing = false;
  speed = 1;
  status = "connecting";
  error = "";
  readonly cacheStatus = "saved";
  restoredEvents = 0;
  private constructor(
    readonly title: string,
    readonly streamId: string,
    readonly credential: string,
    private readonly origin: string,
    private readonly revision: string,
    private readonly paged: BrowserPagedState,
    private readonly changed: () => void,
  ) {
    this.view = paged.view();
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
    options: { cache?: boolean; platform?: CachePlatform } = {},
  ): Promise<BrowserPagedSession | BrowserSession> {
    const platform = options.platform ?? browserCachePlatform();
    if (options.cache === false || !platform)
      return BrowserSession.open(
        streamId,
        credential,
        signal,
        changed,
        origin,
        options,
      );
    let history = await openRecordingHistory({
      serverOrigin: origin,
      streamId,
      ...(credential ? { credential } : {}),
      signal,
    });
    const paged = await BrowserPagedState.open(
      platform.indexedDB,
      { serverOrigin: origin, streamId, revision: history.metadata.revision },
      signal,
    );
    let session: BrowserPagedSession | undefined;
    try {
      if (paged.state.appliedSeq > history.metadata.serverSeq) {
        const current = await openRecordingHistory({
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
      if (!(await paged.loadView(signal))) {
        const legacy = await BrowserHistoryCache.open(
          {
            serverOrigin: origin,
            streamId,
            revision: history.metadata.revision,
          },
          platform,
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
      session = new BrowserPagedSession(
        history.metadata.title,
        streamId,
        credential,
        origin,
        history.metadata.revision,
        paged,
        changed,
      );
      session.restoredEvents = session.received;
      const saved = await paged.loadView(signal);
      if (saved) {
        session.speed = saved.speed;
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
          );
          // Preserve the exact paused prefix, including when later receipt adds timestamp ties.
          if (view.sequence !== saved.serverSeq)
            throw new Error("Saved playback boundary is inconsistent");
          session.view = view;
          session.state = view.summary;
          session.time = saved.timelineMs;
          session.follow = false;
          session.playing = saved.mode === "playing";
        }
      }
      signal.throwIfAborted();
      const live = session;
      const active = AbortSignal.any([signal, live.stop.signal]);
      const client = new SubscriberClient({
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
          await persistEvents(paged, events, active);
          if (live.follow) live.presentLatest();
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
          await live.flushSave();
          await paged.close();
          if (!live.error) live.status = "stopped";
          changed();
        });
      return live;
    } catch (error) {
      await paged.close();
      throw error;
    }
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
  private presentLatest() {
    this.selection?.abort();
    this.view = this.paged.view();
    this.state = this.view.summary;
    this.time = this.duration;
    this.changed();
  }
  seek(time: number, follow = false, persistSelection = true): Promise<void> {
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError("Invalid playback position");
    this.selection?.abort();
    this.follow = follow;
    if (follow) {
      this.playing = false;
      this.presentLatest();
      this.scheduleSave(true);
      return Promise.resolve();
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
        );
        signal.throwIfAborted();
        this.view = view;
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
  advance(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new RangeError("Invalid playback elapsed time");
    if (!this.playing) return;
    this.requestedTime = Math.min(
      this.duration,
      Math.max(this.requestedTime, this.time) + elapsedMs * this.speed,
    );
    if (this.advancing) return;
    this.advancing = true;
    void (async () => {
      while (
        this.playing &&
        !this.stop.signal.aborted &&
        this.requestedTime > this.time
      ) {
        const target = this.requestedTime;
        await this.seek(target, false, false);
        if (this.error || this.time < target) break;
      }
    })()
      .finally(() => {
        this.advancing = false;
      })
      .catch((error) => this.fail(error));
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
  private flushSave(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const saved = {
      serverSeq: this.state.appliedSeq,
      timelineMs: this.time,
      speed: this.speed,
      mode: this.follow
        ? ("follow" as const)
        : this.playing
          ? ("playing" as const)
          : ("paused" as const),
    };
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
