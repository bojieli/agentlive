import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportRecording } from "../../packages/cli/src/export.js";
import { replayRecording } from "../../packages/cli/src/replay.js";
import { startServer } from "../../packages/server/dist/index.js";
import { PlaybackPacer } from "../../packages/playback/dist/index.js";
import type { EventContent } from "../../packages/protocol/dist/index.js";

it.each(["remote", "archive"])(
  "repositions %s replay across tied events, interrupts timed waits and retains its fixed end boundary",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-replay-seek-"));
    const secret = "a".repeat(64);
    const server = await startServer({
      directory,
      ownerSecret: secret,
      port: 0,
    });
    const abort = new AbortController();
    let done: Promise<unknown> | undefined;
    const positions: { serverSeq: number; timelineMs: number }[] = [];
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      text: string,
      callback?: (error?: Error) => void,
    ) => {
      output += text;
      callback?.();
      return true;
    }) as any);
    try {
      const stream = await server.store.create({
        ownerId: "local",
        requestId: "replay",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: secret,
        title: "Replay",
        visibility: "private",
      });
      const { lease } = await stream.resume(secret, {
        publisherId: "pub",
        producerEpoch: "epoch",
        attempt: 1,
        revision: stream.info.revision,
      });
      let producerSeq = 0;
      const append = async (content: EventContent, elapsedMs: number) => {
        await stream.append(lease, [
          {
            protocolVersion: 1,
            streamId: stream.info.id,
            producerEpoch: "epoch",
            producerSeq: ++producerSeq,
            observedAt: new Date().toISOString(),
            clockSegmentId: "clock",
            elapsedMs,
            fidelity: "delta",
            source: { agent: "synthetic", sessionId: "native" },
            content,
          },
        ]);
      };
      await append(
        {
          kind: "message.started",
          payload: { messageId: "m", role: "assistant" },
        },
        0,
      );
      await append(
        {
          kind: "message.text.append",
          payload: { messageId: "m", text: "first" },
        },
        0,
      );
      const tiedEnd = stream.boundary.sequence;
      await append(
        {
          kind: "message.text.append",
          payload: { messageId: "m", text: " later" },
        },
        60000,
      );
      const boundary = stream.boundary.sequence;
      const events = [];
      for await (const event of stream.history(0, boundary)) events.push(event);
      const time = events.find(
        (event) => event.serverSeq === tiedEnd,
      )!.timelineMs;
      const archivePath =
        mode === "archive" ? join(directory, "recording.agentlive") : undefined;
      if (archivePath)
        await exportRecording({
          serverOrigin: server.url,
          streamId: stream.info.id,
          credential: secret,
          output: archivePath,
          signal: abort.signal,
        });
      const controller = new PlaybackPacer();
      controller.setPaused(true);
      done = replayRecording({
        archivePath,
        serverOrigin: archivePath ? "http://127.0.0.1:1" : server.url,
        streamId: stream.info.id,
        credential: secret,
        signal: abort.signal,
        presentation: controller,
        onPositioned: (position) => {
          positions.push(position);
        },
      });
      // Attach rejection handling immediately, including if a subsequent assertion fails.
      let replayFailure: unknown;
      const result = done.catch((error) => {
        replayFailure = error;
        return error;
      });
      const currentPosition = () => {
        if (replayFailure !== undefined) throw replayFailure;
        return positions.at(-1);
      };
      controller.seek(time);
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(tiedEnd);
      controller.stepBackward();
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(tiedEnd - 1);
      expect(controller.paused).toBe(true);
      controller.step();
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(tiedEnd);
      controller.setPaused(false);
      const beforeRewind = positions.length;
      controller.seek(0);
      await expect
        .poll(
          () => {
            currentPosition();
            // Playback remains running: zero may be followed by the first event
            // before the polling timer runs. Verify the new seek notification.
            return positions
              .slice(beforeRewind)
              .some((position) => position.timelineMs === 0);
          },
          { timeout: 10000 },
        )
        .toBe(true);
      controller.setPaused(true);
      controller.seek(Number.MAX_SAFE_INTEGER);
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(boundary);
      expect(output).toContain("first later");
      await append(
        {
          kind: "message.text.append",
          payload: { messageId: "m", text: " outside" },
        },
        61000,
      );
      controller.stepBackward();
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(boundary - 1);
      controller.seek(Number.MAX_SAFE_INTEGER);
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(boundary);
      expect(output).not.toContain("outside");
      controller.stepBackward();
      controller.stepBackward();
      controller.stepBackward();
      controller.stepBackward();
      await expect
        .poll(() => currentPosition()?.serverSeq, { timeout: 10000 })
        .toBe(0);
      abort.abort(new Error("finished"));
      expect(await result).toBe(abort.signal.reason);
    } finally {
      abort.abort();
      await done?.catch(() => {});
      write.mockRestore();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
