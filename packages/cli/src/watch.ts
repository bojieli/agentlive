import {
  openRecordingHistory,
  SubscriberClient,
  type SubscriberStatus,
} from "@agentlive/client";
import { SubscriberCache } from "@agentlive/storage";
import {
  initialState,
  apply,
  renderTerminalEvent,
  renderTerminalSnapshot,
  PlaybackPacer,
} from "@agentlive/playback";
import { originOf } from "@agentlive/client/transport";

/** A blocked presentation sink must not hold the cache lock after cancellation. */
async function interruptible(work: Promise<void>, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export async function watchRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  cacheRoot: string;
  signal: AbortSignal;
  write?: (text: string, signal: AbortSignal) => Promise<void>;
  onStatus?: (status: SubscriberStatus) => void;
  onReceipt?: (serverSeq: number) => void;
  onPresented?: (serverSeq: number) => void;
  interactive?: boolean;
  speed?: number;
  fromMs?: number;
  resumeView?: boolean;
  restartView?: boolean;
  /** Optional playback controller; changes never control network receipt. */
  presentation?: PlaybackPacer;
}) {
  if (
    options.fromMs !== undefined &&
    (!Number.isFinite(options.fromMs) || options.fromMs < 0)
  )
    throw new RangeError(
      "Watch start must be a nonnegative finite timeline position",
    );
  if (options.resumeView && options.restartView)
    throw new Error("Choose resume-view or restart-view, not both");
  const rememberPosition = options.resumeView || options.restartView;
  if (options.interactive && !process.stdin.isTTY)
    throw new Error("Interactive watch requires a terminal");
  const presentation =
    options.presentation ??
    (options.interactive || options.speed !== undefined || rememberPosition
      ? new PlaybackPacer(options.speed ?? 1)
      : undefined);
  if (options.speed !== undefined) presentation!.setSpeed(options.speed);
  presentation?.setImmediate(options.speed === undefined);
  const origin = originOf(options.serverOrigin);
  let seekMetadata:
    Awaited<ReturnType<typeof openRecordingHistory>>["metadata"] | undefined;
  let openedCache: SubscriberCache | undefined;
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const write =
    options.write ??
    ((text: string) =>
      new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) =>
          error ? reject(error) : resolve(),
        ),
      ));
  let state = initialState();
  let bytes = 0;
  let failure: unknown;
  let failed = false;
  const count = (event: unknown) => {
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (bytes > 64 * 1024 * 1024)
      throw new Error(
        "Terminal reference watch exceeds its 64 MiB event budget; paged state is not yet available",
      );
  };
  const present = async (cache: SubscriberCache) => {
    if (options.restartView) await cache.savePresentation(0);
    let saved =
      options.fromMs === undefined && rememberPosition
        ? await cache.loadPresentation()
        : 0;
    let positionedAt: number | undefined;
    if (options.fromMs !== undefined) {
      const through = seekMetadata!.serverSeq;
      while (cache.cursor.serverSeq < through)
        await cache.waitForEvents(cache.cursor.serverSeq, signal);
      let lastTime = 0;
      if (through)
        for await (const event of cache.events(through - 1, through))
          lastTime = event.timelineMs;
      positionedAt = Math.min(options.fromMs, lastTime);
      saved = await cache.sequenceAt(positionedAt, through);
    }
    if (saved || positionedAt !== undefined) {
      for await (const event of cache.events(0, saved)) {
        signal.throwIfAborted();
        count(event);
        state = apply(state, event);
      }
      for (const text of renderTerminalSnapshot(
        state,
        origin,
        options.streamId,
        positionedAt ?? state.timelineMs,
      )) {
        signal.throwIfAborted();
        await interruptible(write(text, signal), signal);
      }
      if (rememberPosition) await cache.savePresentation(saved);
    }
    let anchored = saved > 0 || positionedAt !== undefined;
    if (anchored) presentation?.reset(positionedAt ?? state.timelineMs);
    for (;;) {
      signal.throwIfAborted();
      const through = cache.cursor.serverSeq;
      for await (const event of cache.events(state.appliedSeq, through)) {
        signal.throwIfAborted();
        if (!anchored) {
          presentation?.reset(event.timelineMs);
          anchored = true;
        }
        await presentation?.waitUntil(event.timelineMs, signal);
        count(event);
        const previous = state;
        state = apply(state, event);
        const text = renderTerminalEvent(
          event,
          state,
          origin,
          options.streamId,
          previous,
        );
        if (text) {
          await interruptible(write(text, signal), signal);
          if (rememberPosition) await cache.savePresentation(state.appliedSeq);
        }
        options.onPresented?.(state.appliedSeq);
      }
      if (rememberPosition) await cache.savePresentation(state.appliedSeq);
      await cache.waitForEvents(state.appliedSeq, signal);
    }
  };
  const createClient = (cache: SubscriberCache) =>
    new SubscriberClient({
      serverOrigin: origin,
      cursor: cache.cursor,
      ...(options.credential ? { credential: options.credential } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      commit: async (events, cursor) => {
        await cache.commit(events, cursor);
        options.onReceipt?.(cursor.serverSeq);
      },
    });
  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (!signal.aborted) {
        failed = true;
        failure = error;
        stop.abort(error);
      }
    }
  };
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  let controlsChanged = false;
  let unsubscribePlayback: (() => void) | undefined;
  const onInput = (input: Buffer) => {
    controlsChanged = true;
    for (const key of input.toString("utf8")) {
      if (key === "q" || key === "\u0003") stop.abort();
      else if (key === " ") presentation!.setPaused(!presentation!.paused);
      else if (key === "l") {
        presentation!.setImmediate(true);
        presentation!.setPaused(false);
      } else if (key === "+" || key === "=" || key === "-") {
        if (presentation!.immediate) presentation!.reset(state.timelineMs);
        presentation!.setImmediate(false);
        presentation!.setSpeed(
          key === "-"
            ? Math.max(1 / 1024, presentation!.speed / 2)
            : Math.min(1024, presentation!.speed * 2),
        );
      }
    }
  };
  try {
    if (options.interactive) {
      process.stderr.write(
        "Watch controls: space pause/resume, +/- recorded-time speed, l live catch-up, q quit (receipt continues independently)\n",
      );
      process.stdin.setRawMode(true);
      process.stdin.on("data", onInput);
      process.stdin.resume();
    }
    if (options.fromMs !== undefined)
      seekMetadata = (
        await openRecordingHistory({ ...options, serverOrigin: origin, signal })
      ).metadata;
    const cache = await SubscriberCache.open(options.cacheRoot, {
      serverOrigin: origin,
      streamId: options.streamId,
      initialize: async () =>
        seekMetadata ??
        (
          await openRecordingHistory({
            ...options,
            serverOrigin: origin,
            signal,
          })
        ).metadata,
    });
    openedCache = cache;
    if (
      seekMetadata &&
      (seekMetadata.revision !== cache.binding.revision ||
        seekMetadata.serverSeq < cache.cursor.serverSeq)
    )
      throw new Error(
        "Seek history differs from the retained cache; explicit reconciliation is required",
      );
    signal.throwIfAborted();
    if (rememberPosition && presentation) {
      const saved = options.restartView
        ? undefined
        : await cache.loadPlayback();
      if (saved && !options.presentation && !controlsChanged) {
        if (options.speed === undefined) {
          presentation.setSpeed(saved.speed);
          presentation.setImmediate(saved.immediate);
        }
        presentation.setPaused(options.interactive ? saved.paused : false);
      }
      const persist = () =>
        cache.savePlayback({
          speed: presentation.speed,
          paused: presentation.paused,
          immediate: presentation.immediate,
        });
      unsubscribePlayback = presentation.onChange(() => {
        void run(persist);
      });
      await persist();
    }
    const client = createClient(cache);
    await Promise.all([
      run(() => present(cache)),
      run(() => client.run(signal)),
    ]);
    if (failed) throw failure;
  } catch (error) {
    if (!signal.aborted || failed) throw error;
  } finally {
    stop.abort();
    unsubscribePlayback?.();
    if (options.interactive) {
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
    }
    await openedCache?.close();
  }
}
