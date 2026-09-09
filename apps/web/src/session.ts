import { openRecordingHistory, SubscriberClient } from "@agentlive/client";
import { apply, initialState, activityMentions } from "@agentlive/playback";
import {
  BrowserHistoryCache,
  CacheAheadError,
  browserCachePlatform,
  type CachePlatform,
} from "./history-cache.js";
import type { StoredEvent } from "@agentlive/protocol";
/** A bounded receipt buffer with optional evictable browser persistence. */
export class BrowserSession {
  private events: StoredEvent[] = [];
  private cache: BrowserHistoryCache | undefined;
  private cacheWritable = true;
  private restoring = true;
  playing = false;
  speed = 1;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private saveDirty = false;
  setPlaying(playing: boolean) {
    this.playing = playing;
    this.follow = false;
    this.changed();
    this.scheduleView(true);
  }
  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 1 / 1024 || speed > 1024)
      throw new RangeError("Invalid playback speed");
    this.speed = speed;
    this.changed();
    this.scheduleView(true);
  }
  private scheduleView(immediate = false) {
    if (
      this.restoring ||
      this.stop.signal.aborted ||
      !this.cache ||
      !this.cacheWritable
    )
      return;
    if (immediate) {
      void this.flushView();
      return;
    }
    if (this.saveTimer === undefined)
      this.saveTimer = setTimeout(() => {
        void this.flushView();
      }, 1000);
  }
  private flushView(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.cache || !this.cacheWritable) return Promise.resolve();
    this.saveDirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.saveDirty && this.cache && this.cacheWritable) {
        this.saveDirty = false;
        const saved = await this.cache.saveView(
          {
            serverSeq: this.state.appliedSeq,
            timelineMs: this.time,
            speed: this.speed,
            mode: this.follow ? "follow" : this.playing ? "playing" : "paused",
          },
          AbortSignal.timeout(10000),
        );
        if (!saved) this.disableCache();
      }
    })()
      .catch(() => this.disableCache())
      .finally(() => {
        this.saving = undefined;
        if (this.saveDirty && this.cache && this.cacheWritable)
          return this.flushView();
      });
    return this.saving;
  }
  cacheStatus: "memory" | "saved" = "memory";
  restoredEvents = 0;
  disableCache() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.saveDirty = false;
    this.cacheWritable = false;
    this.cache?.close();
    this.cache = undefined;
    this.cacheStatus = "memory";
    this.changed();
  }
  private bytes = 0;
  private readonly objectOrder = new Map<string, number>();
  order(key: string) {
    return this.objectOrder.get(key) ?? Number.MAX_SAFE_INTEGER;
  }
  private stop = new AbortController();
  private active = true;
  private connection: AbortController | undefined;
  private wake: (() => void) | undefined;
  /** Hidden pages retain their prefix and playback intent, without relying on a background socket. */
  setActive(active: boolean) {
    if (this.stop.signal.aborted || this.active === active) return;
    this.active = active;
    if (!active) void this.flushView();
    this.connection?.abort();
    this.wake?.();
  }
  /** Revalidate authorization and history through a fresh subscription; never overlap receipt loops. */
  reconnect() {
    if (!this.stop.signal.aborted && this.active) this.connection?.abort();
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
      const connection = new AbortController();
      this.connection = connection;
      try {
        await client.run(AbortSignal.any([signal, connection.signal]));
      } finally {
        this.connection = undefined;
      }
    }
  }
  private task: Promise<void> = Promise.resolve();
  get view(): import("./paged-activity.js").PagedActivityView | undefined {
    return undefined;
  }
  state = initialState();
  time = 0;
  follow = true;
  status = "connecting";
  error = "";
  private constructor(
    readonly title: string,
    readonly streamId: string,
    readonly credential: string,
    private readonly changed: () => void,
  ) {}
  get received() {
    return this.events.length;
  }
  get duration() {
    return this.events.at(-1)?.timelineMs ?? 0;
  }
  static async open(
    streamId: string,
    credential: string,
    signal: AbortSignal,
    changed: () => void,
    origin = location.origin,
    options: { cache?: boolean; platform?: CachePlatform } = {},
  ) {
    const metadata = (
      await openRecordingHistory({
        serverOrigin: origin,
        streamId,
        ...(credential ? { credential } : {}),
        signal,
      })
    ).metadata;
    signal.throwIfAborted();
    const session = new BrowserSession(
      metadata.title,
      streamId,
      credential,
      changed,
    );
    const platform = options.platform ?? browserCachePlatform();
    if (options.cache !== false && platform) {
      try {
        const binding = {
          serverOrigin: origin,
          streamId,
          revision: metadata.revision,
        };
        session.cache = await BrowserHistoryCache.open(
          binding,
          platform,
          signal,
        );
        let events: StoredEvent[];
        try {
          events = await session.cache.read(Number.MAX_SAFE_INTEGER, signal);
        } catch (error) {
          if (error instanceof CacheAheadError || signal.aborted) throw error;
          await session.cache.clear(signal);
          session.cache = await BrowserHistoryCache.open(
            binding,
            platform,
            signal,
          );
          events = [];
        }
        if (events.length > metadata.serverSeq) {
          const current = (
            await openRecordingHistory({
              serverOrigin: origin,
              streamId,
              ...(credential ? { credential } : {}),
              signal,
            })
          ).metadata;
          if (
            current.revision !== metadata.revision ||
            current.serverSeq < events.length
          )
            throw new CacheAheadError(
              "Saved history differs from this server. Clear saved histories explicitly to reload.",
            );
        }
        session.accept(events);
        const saved = session.cache.loadView();
        if (saved) {
          const lastTime = saved.serverSeq
            ? events[saved.serverSeq - 1]?.timelineMs
            : 0;
          const nextTime = events[saved.serverSeq]?.timelineMs;
          if (
            lastTime !== undefined &&
            saved.timelineMs >= lastTime &&
            saved.timelineMs <= session.duration &&
            (nextTime === undefined || saved.timelineMs <= nextTime)
          ) {
            session.speed = saved.speed;
            session.playing = saved.mode === "playing";
            if (saved.mode !== "follow") {
              session.state = initialState();
              for (let index = 0; index < saved.serverSeq; index++)
                session.state = apply(session.state, events[index]!);
              session.time = saved.timelineMs;
              session.follow = false;
            }
          }
        }
        session.restoredEvents = events.length;
        session.cacheStatus = "saved";
      } catch (error) {
        session.disableCache();
        if (error instanceof CacheAheadError || signal.aborted) throw error;
      }
    }
    if (signal.aborted) {
      session.cache?.close();
      signal.throwIfAborted();
    }
    session.restoring = false;
    const client = new SubscriberClient({
      serverOrigin: origin,
      cursor: {
        streamId,
        revision: metadata.revision,
        serverSeq: session.received,
      },
      ...(credential ? { credential } : {}),
      onStatus: (status) => {
        session.status =
          status === "stopped" &&
          !session.stop.signal.aborted &&
          !signal.aborted
            ? session.active
              ? "reconnecting"
              : "suspended"
            : status;
        changed();
      },
      commit: async (events) => {
        let time = session.duration;
        for (const event of events) {
          if (event.timelineMs < time)
            throw new Error("Recording timeline moved backwards");
          time = event.timelineMs;
        }
        if (session.cache && session.cacheWritable) {
          try {
            if (
              !(await session.cache.append(
                events,
                AbortSignal.any([signal, session.stop.signal]),
              ))
            )
              session.disableCache();
          } catch {
            session.disableCache();
          }
        }
        session.accept(events);
      },
    });
    session.task = session
      .receive(client, AbortSignal.any([signal, session.stop.signal]))
      .catch((error: unknown) => {
        session.status = "error";
        session.error =
          error instanceof Error
            ? error.message
            : "Unable to receive recording";
        changed();
      })
      .finally(async () => {
        await session.flushView();
        session.cache?.close();
        if (!session.error) {
          session.status = "stopped";
          changed();
        }
      });
    return session;
  }
  private accept(events: readonly StoredEvent[]) {
    let sequence = this.received,
      time = this.duration;
    const added = events.reduce((size, event) => {
      if (event.serverSeq !== ++sequence || event.timelineMs < time)
        throw new Error("Recording history is not ordered");
      time = event.timelineMs;
      return size + new TextEncoder().encode(JSON.stringify(event)).length;
    }, 0);
    if (this.bytes + added > 64 * 1024 * 1024)
      throw new Error(
        "This browser viewer has reached its 64 MiB recording limit.",
      );
    for (const event of events) {
      for (const { key } of activityMentions(event)) {
        if (!this.objectOrder.has(key))
          this.objectOrder.set(key, event.serverSeq);
      }
    }
    for (const event of events) this.events.push(event);
    this.bytes += added;
    if (this.follow) {
      try {
        this.move(this.duration, true, false);
      } catch (error) {
        this.follow = false;
        this.error = error instanceof Error ? error.message : "Playback failed";
        this.changed();
      }
    } else this.changed();
    this.scheduleView();
  }
  seek(time: number, follow = false) {
    this.move(time, follow, true);
  }
  advance(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new RangeError("Invalid playback elapsed time");
    if (this.playing)
      this.move(this.time + elapsedMs * this.speed, false, false);
  }
  private move(time: number, follow: boolean, immediate: boolean) {
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError("Invalid playback position");
    const target = Math.min(time, this.duration);
    let state = target < this.time ? initialState() : this.state;
    while (state.appliedSeq < this.events.length) {
      const event = this.events[state.appliedSeq]!;
      if (event.timelineMs > target) break;
      state = apply(state, event);
    }
    if (this.state === state && this.time === target && this.follow === follow)
      return;
    this.state = state;
    this.time = target;
    this.follow = follow;
    if (follow) this.playing = false;
    this.changed();
    this.scheduleView(immediate);
  }
  close() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.stop.abort();
    return this.task;
  }
}
