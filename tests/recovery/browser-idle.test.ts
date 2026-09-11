import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/dist/index.js";
import { BrowserPagedSession } from "../../apps/web/src/paged-session.js";
import { BrowserSession } from "../../apps/web/src/session.js";
import type { EventContent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
it.each([false, true])(
  "compresses browser gaps with speed, ties, pause, seek and saved preference (paged=%s)",
  async (paged) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-browser-idle-"));
    const secret = "c".repeat(64);
    const server = await startServer({
      directory,
      ownerSecret: secret,
      port: 0,
    });
    const abort = new AbortController();
    const platform = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
    let viewer: BrowserSession | BrowserPagedSession | undefined;
    try {
      const recording = await server.store.create({
        ownerId: "local",
        requestId: "idle",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: secret,
        title: "Idle",
        visibility: "private",
      });
      const { lease } = await recording.resume(secret, {
        publisherId: "pub",
        producerEpoch: "epoch",
        attempt: 1,
        revision: recording.info.revision,
      });
      let producerSeq = 0;
      const append = (elapsedMs: number, content: EventContent) =>
        recording.append(lease, [
          {
            protocolVersion: 1,
            streamId: recording.info.id,
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
      await append(0, {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      });
      await append(10000, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "one" },
      });
      await append(10000, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "two" },
      });
      await append(20000, {
        kind: "message.completed",
        payload: { messageId: "m" },
      });
      const open = () =>
        (paged ? BrowserPagedSession : BrowserSession).open(
          recording.info.id,
          secret,
          abort.signal,
          () => {},
          server.url,
          { platform },
        );
      viewer = await open();
      await expect.poll(() => viewer!.received).toBe(5);
      await viewer.step(-1);
      await viewer.step(-1);
      await viewer.step(-1);
      expect(viewer.state.appliedSeq).toBe(2);
      const base = viewer.time;
      viewer.setIdleCap(1000);
      viewer.setSpeed(2);
      viewer.setPlaying(true);
      viewer.advance(250);
      await expect.poll(() => viewer!.time).toBe(base + 500);
      expect(viewer.state.appliedSeq).toBe(2);
      viewer.setPlaying(false);
      viewer.advance(5000);
      expect(viewer.time).toBe(base + 500);
      // Reload halfway through a capped gap must preserve the remaining wait.
      await viewer.close();
      viewer = await open();
      expect(viewer.time).toBe(base + 500);
      viewer.setPlaying(true);
      viewer.advance(250);
      await expect.poll(() => viewer!.state.appliedSeq).toBe(4);
      expect(viewer.time).toBe(base + 10000);
      await viewer.step(-1);
      expect(viewer.state.appliedSeq).toBe(3);
      viewer.setIdleCap(0);
      viewer.setPlaying(true);
      viewer.advance(1);
      await expect.poll(() => viewer!.state.appliedSeq).toBe(5);
      expect(viewer.received).toBe(5);
      viewer.setPlaying(false);
      await viewer.seek(base + 5000);
      viewer.setIdleCap(1000);
      viewer.setPlaying(true);
      viewer.advance(500);
      await expect.poll(() => viewer!.state.appliedSeq).toBe(4);
      viewer.setPlaying(false);
      viewer.setIdleCap(5000);
      await viewer.close();
      viewer = await open();
      expect(viewer.idleCapMs).toBe(5000);
      expect(viewer.speed).toBe(2);
      expect(viewer.state.appliedSeq).toBe(4);
      // Cancelling a paged lookahead must not move a paused or newly sought view later.
      await viewer.seek(base);
      viewer.setPlaying(true);
      viewer.advance(500);
      viewer.setPlaying(false);
      await viewer.seek(base + 2000);
      expect(viewer.time).toBe(base + 2000);
      expect(viewer.state.appliedSeq).toBe(2);
      viewer.setIdleCap(undefined);
      await viewer.close();
      viewer = await open();
      expect(viewer.idleCapMs).toBeUndefined();
      expect(() => viewer!.setIdleCap(-1)).toThrow();
      expect(() => viewer!.setIdleCap(Infinity)).toThrow();
      expect(viewer.error).toBe("");
    } finally {
      await viewer?.close();
      abort.abort();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
