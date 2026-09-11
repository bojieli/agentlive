import { TerminalKeys } from "./terminal-keys.js";
import {
  ProtocolError,
  type StoredEvent,
  type SnapshotLease,
} from "@agentlive/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore, openArchive, type OpenArchive } from "@agentlive/storage";
import {
  openRecordingHistory,
  RecordingSnapshotClient,
  SnapshotRetention,
} from "@agentlive/client";
import {
  PlaybackPacer,
  initialPagedState,
  PagedReducer,
  PagedTerminalRenderer,
} from "@agentlive/playback";
import { originOf } from "@agentlive/client/transport";
export async function replayRecording(options: {
  serverOrigin: string;
  streamId: string;
  credential?: string;
  signal: AbortSignal;
  speed?: number;
  idleCapMs?: number | null;
  fromMs?: number;
  interactive?: boolean;
  archivePath?: string;
  presentation?: PlaybackPacer;
  onPositioned?: (position: { serverSeq: number; timelineMs: number }) => void;
}) {
  if (
    options.fromMs !== undefined &&
    (!Number.isFinite(options.fromMs) || options.fromMs < 0)
  )
    throw new RangeError(
      "Replay start must be a nonnegative finite timeline position",
    );
  const write = (text: string) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      process.stdout.write(text, (error) => {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      });
    });
  const pacer =
    options.presentation ??
    (options.speed !== undefined ||
    options.interactive ||
    options.idleCapMs !== undefined
      ? new PlaybackPacer(options.speed ?? 1)
      : undefined);
  pacer?.setIdleCap(options.idleCapMs ?? undefined);
  if (options.interactive && !process.stdin.isTTY)
    throw new Error("Interactive replay requires a terminal");
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  const origin = originOf(options.serverOrigin);
  let content: TextStore | undefined;
  let snapshots: RecordingSnapshotClient | undefined;
  let retention: SnapshotRetention | undefined;
  let acquiredLease: SnapshotLease | undefined;
  let directory: string | undefined;
  let archive: OpenArchive | undefined;
  let metadata:
    Awaited<ReturnType<typeof openRecordingHistory>>["metadata"] | undefined;
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  const terminalKeys = new TerminalKeys();
  let viewedSequence = 0,
    viewedTime = 0;
  let pending: { sequence: number } | { timelineMs: number } | undefined;
  let navigation = new AbortController();
  const unsubscribeSeek = pacer?.onSeek((timelineMs) => {
    pending = { timelineMs };
    navigation.abort(new Error("Replay position changed"));
  });
  const unsubscribeBackward = pacer?.onStepBackward(() => {
    pending = {
      sequence: Math.max(
        0,
        (pending && "sequence" in pending ? pending.sequence : viewedSequence) -
          1,
      ),
    };
    navigation.abort(new Error("Replay position changed"));
  });
  const onInput = (input: Buffer) => {
    for (const key of terminalKeys.feed(input.toString("utf8"))) {
      if (key === "q" || key === "\u0003")
        local.abort(new DOMException("Replay stopped", "AbortError"));
      else if (key === " ") pacer!.setPaused(!pacer!.paused);
      else if (key === "." || key === "right") pacer!.step();
      else if (key === "," || key === "left") pacer!.stepBackward();
      else if (key === "[" || key === "]" || key === "0") {
        pacer!.setPaused(true);
        pacer!.seek(
          key === "0"
            ? 0
            : Math.max(
                0,
                (pending && "timelineMs" in pending
                  ? pending.timelineMs
                  : viewedTime) + (key === "[" ? -30000 : 30000),
              ),
        );
      } else if (key === "+" || key === "=")
        pacer!.setSpeed(Math.min(1024, pacer!.speed * 2));
      else if (key === "-")
        pacer!.setSpeed(Math.max(1 / 1024, pacer!.speed / 2));
    }
  };
  try {
    if (options.interactive) {
      process.stderr.write(
        "Replay controls: space pause/resume, ./Right Arrow next event, ,/Left Arrow previous event, [/] seek 30s, 0 beginning, +/- speed, q quit\n",
      );
      process.stdin.setRawMode(true);
      process.stdin.on("data", onInput);
      process.stdin.resume();
    }
    archive = options.archivePath
      ? await openArchive(options.archivePath, signal)
      : undefined;
    const archiveRange = async function* (
      range: {
        afterServerSeq?: number;
        throughServerSeq?: number;
        signal?: AbortSignal;
      } = {},
    ) {
      const after = range.afterServerSeq ?? 0,
        through =
          range.throughServerSeq ??
          archive!.manifest.recording.throughServerSeq;
      if (
        !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(through) ||
        after < 0 ||
        after > through ||
        through > archive!.manifest.recording.throughServerSeq
      )
        throw new RangeError("Archive range exceeds boundary");
      const active = range.signal
        ? AbortSignal.any([signal, range.signal])
        : signal;
      for await (const event of archive!.events(active)) {
        if (event.serverSeq > through) break;
        if (event.serverSeq > after) yield event;
      }
    };
    const history = archive
      ? {
          metadata: {
            revision: archive.manifest.recording.revision,
            serverSeq: archive.manifest.recording.throughServerSeq,
            title: archive.manifest.recording.title,
            lifecycle: archive.manifest.recording.lifecycle,
          },
          range: archiveRange,
        }
      : await openRecordingHistory({
          ...options,
          serverOrigin: origin,
          signal,
        });
    metadata = history.metadata;
    let started = false;
    let snapshotShown = false;
    if (!archive)
      snapshots = new RecordingSnapshotClient({
        serverOrigin: origin,
        streamId: options.streamId,
        revision: metadata.revision,
        ...(options.credential ? { credential: options.credential } : {}),
      });
    directory = await mkdtemp(join(tmpdir(), "agentlive-replay-"));
    content = await TextStore.open(directory, undefined, (ref, active) => {
      if (!retention)
        throw new Error("Replay content has no retained snapshot");
      return retention.readBlob(ref, active);
    });
    const reducer = new PagedReducer(content);
    const renderer = new PagedTerminalRenderer(
      reducer,
      content,
      origin,
      options.streamId,
      archive ? (hash) => `Archive entry: attachments/${hash}` : undefined,
    );
    let state = initialPagedState();
    const stale = (error: unknown) =>
      error instanceof ProtocolError && error.code === "stale_lease";
    const rebuild = async (through: number, time?: number) => {
      retention?.close();
      let rebuilt = initialPagedState();
      let batch: StoredEvent[] = [],
        bytes = 2;
      const flush = async () => {
        if (batch.length)
          rebuilt = await reducer.applyBatch(rebuilt, batch, signal);
        batch = [];
        bytes = 2;
      };
      for await (const event of history.range({
        afterServerSeq: 0,
        throughServerSeq: through,
      })) {
        signal.throwIfAborted();
        if (time !== undefined && event.timelineMs > time) break;
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (batch.length && (batch.length === 256 || bytes + size > 1048576))
          await flush();
        batch.push(event);
        bytes += size;
      }
      await flush();
      if (time === undefined && rebuilt.appliedSeq !== through)
        throw new ProtocolError(
          "sequence_gap",
          "Replay reconstruction is incomplete",
        );
      return rebuilt;
    };
    const applyBatch = async (events: StoredEvent[]) => {
      try {
        state = await reducer.applyBatch(state, events, signal);
      } catch (error) {
        if (!stale(error)) throw error;
        state = await rebuild(state.appliedSeq);
        state = await reducer.applyBatch(state, events, signal);
      }
    };
    async function* recoverRender(
      output: AsyncIterable<string>,
      time?: number,
    ) {
      // Input can arrive while stdout is still draining this snapshot. Bind
      // navigation to its accepted prefix before exposing the first bytes.
      viewedSequence = state.appliedSeq;
      viewedTime = time ?? state.timelineMs;
      try {
        yield* output;
      } catch (error) {
        if (!stale(error)) throw error;
        state = await rebuild(state.appliedSeq);
        // Partial output cannot be retracted. Separate the replacement snapshot.
        yield "\n";
        yield* renderer.snapshot(state, signal, time);
      }
    }
    if (options.fromMs !== undefined && snapshots) {
      const selected = await snapshots.acquireLease(
        metadata.serverSeq,
        signal,
        options.fromMs,
      );
      if (selected) {
        acquiredLease = selected;
        // Replay content is private temporary state removed on exit; no cached
        // provenance survives this process. The lease lasts through rendering.
        try {
          retention = await SnapshotRetention.open(
            snapshots,
            selected,
            async () => {},
            signal,
          );
          state = await reducer.open(
            selected.snapshot.ref,
            { streamId: options.streamId, revision: metadata.revision },
            signal,
          );
        } catch (error) {
          if (!stale(error)) throw error;
          state = await rebuild(selected.snapshot.serverSeq);
        }
      }
    }
    let prefix: import("@agentlive/protocol").StoredEvent[] = [],
      prefixBytes = 2;
    const flushPrefix = async () => {
      if (prefix.length) await applyBatch(prefix);
      prefix = [];
      prefixBytes = 2;
    };
    let fromMs = options.fromMs;
    const reportPosition = (time = state.timelineMs) => {
      viewedSequence = state.appliedSeq;
      viewedTime = time;
      options.onPositioned?.({
        serverSeq: viewedSequence,
        timelineMs: viewedTime,
      });
    };
    for (;;) {
      signal.throwIfAborted();
      if (pending) {
        const requested = pending;
        pending = undefined;
        navigation = new AbortController();
        prefix = [];
        prefixBytes = 2;
        fromMs = undefined;
        state = await rebuild(
          "sequence" in requested ? requested.sequence : metadata.serverSeq,
          "timelineMs" in requested ? requested.timelineMs : undefined,
        );
        const time =
          "timelineMs" in requested && state.appliedSeq < metadata.serverSeq
            ? requested.timelineMs
            : state.timelineMs;
        for await (const text of recoverRender(
          renderer.snapshot(state, signal, time),
          time,
        ))
          await write(text);
        pacer?.reset(time);
        started = snapshotShown = true;
        reportPosition(time);
        if (pending) continue;
      }
      try {
        for await (const event of history.range({
          afterServerSeq: state.appliedSeq,
          signal: navigation.signal,
        })) {
          signal.throwIfAborted();
          navigation.signal.throwIfAborted();
          if (fromMs !== undefined && event.timelineMs <= fromMs) {
            const size = Buffer.byteLength(JSON.stringify(event)) + 1;
            if (
              prefix.length &&
              (prefix.length === 256 || prefixBytes + size > 1048576)
            )
              await flushPrefix();
            prefix.push(event);
            prefixBytes += size;
            continue;
          }
          await flushPrefix();
          if (fromMs !== undefined && !snapshotShown) {
            for await (const text of recoverRender(
              renderer.snapshot(state, signal, fromMs),
              fromMs,
            ))
              await write(text);
            snapshotShown = true;
            pacer?.reset(fromMs);
            started = true;
          }
          let admission: "step" | "play" | undefined;
          if (pacer) {
            if (!started) {
              pacer.reset(event.timelineMs);
              started = true;
            }
            admission = await pacer.waitUntil(
              event.timelineMs,
              AbortSignal.any([signal, navigation.signal]),
            );
          }
          navigation.signal.throwIfAborted();
          const previous = state;
          await applyBatch([event]);
          for await (const text of recoverRender(
            admission === "step"
              ? renderer.snapshot(state, signal)
              : renderer.event(event, state, signal, previous),
          ))
            await write(text);
          reportPosition();
        }
        await flushPrefix();
        if (fromMs !== undefined && !snapshotShown) {
          for await (const text of recoverRender(
            renderer.snapshot(state, signal),
          ))
            await write(text);
        } else {
          for await (const text of recoverRender(
            renderer.pending(state, signal),
          ))
            await write(text);
        }
        reportPosition();
        if (!options.interactive && !options.presentation) break;
        pacer!.setPaused(true);
        // Keep the fixed recording available for inspection after its last event.
        const active = AbortSignal.any([signal, navigation.signal]);
        await new Promise<never>((_resolve, reject) => {
          if (active.aborted) reject(active.reason);
          else
            active.addEventListener("abort", () => reject(active.reason), {
              once: true,
            });
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error !== navigation.signal.reason || !navigation.signal.aborted)
          throw error;
      }
    }
    return history.metadata;
  } catch (error) {
    if (
      local.signal.aborted &&
      !options.signal.aborted &&
      error === local.signal.reason
    )
      return metadata;
    throw error;
  } finally {
    unsubscribeSeek?.();
    unsubscribeBackward?.();
    if (options.interactive) {
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) {
        process.stdin.pause();
      }
    }
    try {
      await content?.close();
    } finally {
      if (retention) {
        // Expiry is the fallback if the server is unreachable during cleanup.
        await retention.release(AbortSignal.timeout(2000)).catch(() => {});
      } else if (acquiredLease && snapshots) {
        await snapshots
          .releaseLease(acquiredLease, AbortSignal.timeout(2000))
          .catch(() => {});
      }
      snapshots?.close();
      await archive?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
