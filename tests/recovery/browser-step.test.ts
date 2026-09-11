import { expect, it, vi } from "vitest";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import { ProtocolError } from "../../packages/protocol/dist/index.js";
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
it.each([false, true, "memory"] as const)(
  "steps exact tied prefixes with independent receipt and saved reopen (paged=%s)",
  async (paged) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-browser-step-"));
    const server = await startServer({
      directory,
      ownerSecret: "b".repeat(64),
      port: 0,
    });
    const abort = new AbortController();
    let viewer: BrowserSession | BrowserPagedSession | undefined;
    const platform = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
    if (paged === "memory")
      platform.indexedDB.open = () => {
        throw new Error("Memory playback must not open IndexedDB");
      };
    try {
      const session = await server.store.create({
        ownerId: "local",
        requestId: "step",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "a".repeat(64),
        title: "Step",
        visibility: "private",
      });
      const { lease } = await session.resume("a".repeat(64), {
        publisherId: "pub",
        producerEpoch: "epoch",
        attempt: 1,
        revision: session.info.revision,
      });
      let sequence = 0;
      const append = (content: EventContent) =>
        session.append(lease, [
          {
            protocolVersion: 1,
            streamId: session.info.id,
            producerEpoch: "epoch",
            producerSeq: ++sequence,
            observedAt: new Date().toISOString(),
            clockSegmentId: "clock",
            elapsedMs: 0,
            fidelity: "delta",
            source: { agent: "synthetic", sessionId: "native" },
            content,
          },
        ]);
      await append({
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      });
      await append({
        kind: "message.text.append",
        payload: { messageId: "m", text: "one" },
      });
      await append({
        kind: "message.text.append",
        payload: { messageId: "m", text: "two" },
      });
      const open = () =>
        (paged ? BrowserPagedSession : BrowserSession).open(
          session.info.id,
          "b".repeat(64),
          abort.signal,
          () => {},
          server.url,
          { platform, ...(paged === "memory" ? { cache: false } : {}) },
        );
      viewer = await open();
      const text = async () => {
        if (!viewer!.view) return viewer!.state.messages.get("m")?.text;
        const row = (await viewer!.view.rows(0, 1, abort.signal))[0];
        if (!row) return undefined;
        const source = (await viewer!.view.load(row, abort.signal))!.texts
          .text!;
        return source.read(0, source.units, abort.signal);
      };
      await expect.poll(() => viewer!.received).toBe(4);
      await viewer.step(-1);
      expect(viewer.state.appliedSeq).toBe(3);
      expect(await text()).toBe("one");
      expect(viewer.playing).toBe(false);
      expect(viewer.follow).toBe(false);
      const time = viewer.time;
      await viewer.close();
      viewer = await open();
      if (paged === "memory") {
        expect(viewer).toBeInstanceOf(BrowserPagedSession);
        expect(viewer.cacheStatus).toBe("memory");
        await expect.poll(() => viewer!.received).toBe(4);
        await viewer.seek(viewer.duration, true);
        expect(await text()).toBe("onetwo");
        await viewer.step(-1);
        viewer.setSpeed(4);
        viewer.setIdleCap(200);
        const selection = vi
          .spyOn(BrowserPagedState.prototype, "select")
          .mockRejectedValueOnce(
            new ProtocolError("stale_lease", "expired memory snapshot"),
          );
        try {
          await viewer.seek(time);
        } finally {
          selection.mockRestore();
        }
        const recovery = (viewer as BrowserPagedSession).recoveryPresentation!;
        expect(recovery.serverSeq).toBe(3);
        expect(recovery.mode).toBe("paused");
        await viewer.close();
        viewer = await BrowserPagedSession.open(
          session.info.id,
          "b".repeat(64),
          abort.signal,
          () => {},
          server.url,
          {
            platform,
            cache: false,
            resumeView: recovery,
          },
        );
        expect(viewer.received).toBe(4);
        expect(viewer.cacheStatus).toBe("memory");
        expect(viewer.follow).toBe(false);
        expect(viewer.speed).toBe(4);
        expect(viewer.idleCapMs).toBe(200);
      }
      expect(viewer.state.appliedSeq).toBe(3);
      expect(viewer.time).toBe(time);
      expect(await text()).toBe("one");
      await viewer.step(-1);
      expect(viewer.state.appliedSeq).toBe(2);
      expect(await text()).toBe("");
      await viewer.step(1);
      expect(viewer.state.appliedSeq).toBe(3);
      expect(viewer.time).toBe(time);
      await append({ kind: "message.completed", payload: { messageId: "m" } });
      await expect.poll(() => viewer!.received).toBe(5);
      expect(viewer.state.appliedSeq).toBe(3);
      await viewer.step(1);
      expect(viewer.state.appliedSeq).toBe(4);
      expect(await text()).toBe("onetwo");
      await viewer.step(1);
      await viewer.step(1);
      expect(viewer.state.appliedSeq).toBe(5);
      for (let index = 0; index < 6; index++) await viewer.step(-1);
      expect(viewer.state.appliedSeq).toBe(0);
      expect(viewer.time).toBe(0);
      expect(viewer.received).toBe(5);
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
