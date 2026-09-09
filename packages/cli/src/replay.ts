import { openRecordingHistory } from "@agentlive/client";
import {
  PlaybackPacer,
  initialState,
  apply,
  renderTerminalEvent,
  renderTerminalPending,
} from "@agentlive/playback";
import { originOf } from "@agentlive/client/transport";
export async function replayRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  signal: AbortSignal;
  speed?: number;
  interactive?: boolean;
}) {
  const pacer =
    options.speed !== undefined || options.interactive
      ? new PlaybackPacer(options.speed ?? 1)
      : undefined;
  if (options.interactive && !process.stdin.isTTY)
    throw new Error("Interactive replay requires a terminal");
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  const origin = originOf(options.serverOrigin);
  const history = await openRecordingHistory({
    ...options,
    serverOrigin: origin,
    signal,
  });
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  const onInput = (input: Buffer) => {
    for (const key of input.toString("utf8")) {
      if (key === "q" || key === "\u0003")
        local.abort(new DOMException("Replay stopped", "AbortError"));
      else if (key === " ") pacer!.setPaused(!pacer!.paused);
      else if (key === "+" || key === "=")
        pacer!.setSpeed(Math.min(1024, pacer!.speed * 2));
      else if (key === "-")
        pacer!.setSpeed(Math.max(1 / 1024, pacer!.speed / 2));
    }
  };
  if (options.interactive) {
    process.stderr.write(
      "Replay controls: space pause/resume, +/- speed, q quit\n",
    );
    process.stdin.setRawMode(true);
    process.stdin.on("data", onInput);
    process.stdin.resume();
  }
  try {
    let started = false;
    let state = initialState(),
      bytes = 0;
    for await (const event of history.events) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > 64 * 1024 * 1024)
        throw new Error(
          "Terminal reference replay exceeds its 64 MiB event budget; paged state replay is not yet available",
        );
      signal.throwIfAborted();
      if (pacer) {
        if (!started) {
          pacer.reset(event.timelineMs);
          started = true;
        }
        await pacer.waitUntil(event.timelineMs, signal);
      }
      const previous = state;
      state = apply(state, event);
      const text = renderTerminalEvent(
        event,
        state,
        origin,
        options.streamId,
        previous,
      );
      if (text)
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(text, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
    }
    for (const text of renderTerminalPending(state))
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    return history.metadata;
  } catch (error) {
    if (
      local.signal.aborted &&
      !options.signal.aborted &&
      error === local.signal.reason
    )
      return history.metadata;
    throw error;
  } finally {
    if (options.interactive) {
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) {
        process.stdin.pause();
      }
    }
  }
}
