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
  resumeView?: boolean;
  restartView?: boolean;
  /** Optional presentation gate; its pause state never controls network receipt. */
  presentation?: PlaybackPacer;
}) {
  if (options.resumeView && options.restartView)
    throw new Error("Choose resume-view or restart-view, not both");
  const rememberPosition = options.resumeView || options.restartView;
  if (options.interactive && !process.stdin.isTTY)
    throw new Error("Interactive watch requires a terminal");
  const presentation =
    options.presentation ??
    (options.interactive ? new PlaybackPacer() : undefined);
  const origin = originOf(options.serverOrigin);
  const cache = await SubscriberCache.open(options.cacheRoot, {
    serverOrigin: origin,
    streamId: options.streamId,
    initialize: async () =>
      (await openRecordingHistory({ ...options, serverOrigin: origin }))
        .metadata,
  });
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
  const present = async () => {
    if (options.restartView) await cache.savePresentation(0);
    const saved = rememberPosition ? await cache.loadPresentation() : 0;
    if (saved) {
      for await (const event of cache.events(0, saved)) {
        signal.throwIfAborted();
        count(event);
        state = apply(state, event);
      }
      for (const text of renderTerminalSnapshot(
        state,
        origin,
        options.streamId,
      )) {
        await presentation?.waitUntil(0, signal);
        signal.throwIfAborted();
        await interruptible(write(text, signal), signal);
      }
    }
    for (;;) {
      signal.throwIfAborted();
      const through = cache.cursor.serverSeq;
      for await (const event of cache.events(state.appliedSeq, through)) {
        signal.throwIfAborted();
        await presentation?.waitUntil(0, signal);
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
  const client = new SubscriberClient({
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
  const onInput = (input: Buffer) => {
    for (const key of input.toString("utf8")) {
      if (key === "q" || key === "\u0003") stop.abort();
      else if (key === " ") presentation!.setPaused(!presentation!.paused);
    }
  };
  try {
    if (options.interactive) {
      process.stderr.write(
        "Watch controls: space pause/resume presentation, q quit (receipt continues while paused)\n",
      );
      process.stdin.setRawMode(true);
      process.stdin.on("data", onInput);
      process.stdin.resume();
    }
    await Promise.all([run(present), run(() => client.run(signal))]);
    if (failed) throw failure;
  } finally {
    stop.abort();
    if (options.interactive) {
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
    }
    await cache.close();
  }
}
