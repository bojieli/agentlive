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
async function runWatchRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  cacheRoot: string;
  signal: AbortSignal;
  cancellation?: AbortController;
  write?: (text: string, signal: AbortSignal) => Promise<void>;
  onStatus?: (status: SubscriberStatus) => void;
  onReceipt?: (serverSeq: number) => void;
  onPresented?: (serverSeq: number) => void;
  onPositioned?: (position: { serverSeq: number; timelineMs: number }) => void;
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
  const stop = options.cancellation ?? new AbortController();
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
  let viewedTime = 0;
  let pendingSeek:
    { timelineMs: number; through: number | undefined } | undefined;
  let seekWake = new AbortController();
  const unsubscribeSeek = presentation?.onSeek((timelineMs) => {
    pendingSeek = { timelineMs, through: openedCache?.cursor.serverSeq };
    seekWake.abort(new Error("Viewer position changed"));
  });
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
    const resumed =
      options.fromMs === undefined && rememberPosition
        ? await cache.loadPresentationPosition()
        : undefined;
    let saved = resumed?.serverSeq ?? 0;
    let positionedAt =
      resumed && (resumed.serverSeq > 0 || resumed.timelineMs > 0)
        ? resumed.timelineMs
        : undefined;
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
    const showPosition = async (saved: number, positionedAt?: number) => {
      if (positionedAt !== undefined) viewedTime = positionedAt;
      state = initialState();
      bytes = 0;
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
      if (rememberPosition)
        await cache.savePresentation(saved, positionedAt ?? state.timelineMs);
      viewedTime = positionedAt ?? state.timelineMs;
      presentation?.reset(viewedTime);
      options.onPositioned?.({ serverSeq: saved, timelineMs: viewedTime });
    };
    if (saved || positionedAt !== undefined)
      await showPosition(saved, positionedAt);
    let anchored = saved > 0 || positionedAt !== undefined;
    if (anchored) presentation?.reset(positionedAt ?? state.timelineMs);
    for (;;) {
      signal.throwIfAborted();
      if (pendingSeek) {
        const requested = pendingSeek;
        pendingSeek = undefined;
        seekWake = new AbortController();
        const through = requested.through ?? cache.cursor.serverSeq;
        let lastTime = 0;
        if (through)
          for await (const event of cache.events(through - 1, through))
            lastTime = event.timelineMs;
        const position = Math.min(requested.timelineMs, lastTime);
        const sequence = await cache.sequenceAt(position, through);
        await showPosition(sequence, position);
        anchored = true;
        continue;
      }
      const navigation = AbortSignal.any([signal, seekWake.signal]);
      try {
        const through = cache.cursor.serverSeq;
        for await (const event of cache.events(state.appliedSeq, through)) {
          navigation.throwIfAborted();
          if (!anchored) {
            presentation?.reset(event.timelineMs);
            anchored = true;
          }
          await presentation?.waitUntil(event.timelineMs, navigation);
          navigation.throwIfAborted();
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
            // Finish an accepted output write before showing a replacement snapshot.
            await interruptible(write(text, signal), signal);
            if (rememberPosition)
              await cache.savePresentation(state.appliedSeq);
          }
          viewedTime = state.timelineMs;
          options.onPresented?.(state.appliedSeq);
        }
        if (rememberPosition)
          await cache.savePresentation(state.appliedSeq, viewedTime);
        if (pendingSeek) continue;
        await cache.waitForEvents(state.appliedSeq, navigation);
      } catch (error) {
        if (signal.aborted || !pendingSeek || error !== navigation.reason)
          throw error;
      }
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
      else if (key === "[" || key === "]" || key === "0") {
        presentation!.setPaused(true);
        presentation!.seek(
          key === "0"
            ? 0
            : Math.max(
                0,
                (pendingSeek?.timelineMs ?? viewedTime) +
                  (key === "[" ? -30_000 : 30_000),
              ),
        );
      } else if (key === "l") {
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
  let terminalInstalled = false;
  const restoreTerminal = () => {
    if (terminalInstalled) {
      terminalInstalled = false;
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
    }
  };
  signal.addEventListener("abort", restoreTerminal, { once: true });
  try {
    signal.throwIfAborted();
    if (options.interactive) {
      process.stderr.write(
        "Watch controls: space pause/resume, +/- speed, [/] seek 30s, 0 beginning, l live catch-up, q quit (receipt continues independently)\n",
      );
      terminalInstalled = true;
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
    unsubscribeSeek?.();
    signal.removeEventListener("abort", restoreTerminal);
    restoreTerminal();
    await openedCache?.close();
  }
}

/** Cancellation stopped waiting; accepted cache work still owns its files. */
export class CancellationTimeoutError extends Error {
  readonly code = "cancellation_timeout";
  constructor(
    readonly timeoutMs: number,
    /** Actual completion, including cleanup failures after the deadline. */
    readonly whenDrained: Promise<void>,
  ) {
    super(
      `Watch cancellation exceeded ${timeoutMs}ms; cache ownership is retained until cleanup finishes`,
    );
    this.name = "CancellationTimeoutError";
  }
}

export function watchRecording(
  options: Omit<Parameters<typeof runWatchRecording>[0], "cancellation"> & {
    /** Maximum wait after cancellation, including accepted writes and cleanup. */
    cancellationTimeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.cancellationTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    return Promise.reject(
      new RangeError(
        "cancellationTimeoutMs must be an integer from 1 to 2147483647",
      ),
    );
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  // Internal quit and failure cancellation must start the same deadline.
  const work = runWatchRecording({ ...options, signal, cancellation: stop });
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) return;
      timer = setTimeout(
        () => reject(new CancellationTimeoutError(timeoutMs, work)),
        timeoutMs,
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    // Keep observing work after expiry; never unlock or close files underneath it.
    work.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
