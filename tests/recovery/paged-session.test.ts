import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import {
  PagedReducer,
  initialPagedState,
} from "../../packages/playback/src/index.js";
import { openRecordingHistory } from "../../packages/client/src/index.js";
import { BrowserSession } from "../../apps/web/src/session.js";
import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/dist/index.js";
import { BrowserPagedSession } from "../../apps/web/src/paged-session.js";
import type {
  EventContent,
  PublishedEvent,
} from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
it("runs persisted production receipt independently of seeking, then resumes its saved presentation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-paged-session-"));
  const server = await startServer({
    directory,
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  const stop = new AbortController();
  const platform = { indexedDB: new IDBFactory(), keyRange: IDBKeyRange };
  let viewer: BrowserPagedSession | undefined;
  try {
    const stream = await server.store.create({
      ownerId: "local",
      requestId: "paged",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "a".repeat(64),
      title: "Paged",
      visibility: "private",
    });
    const { lease } = await stream.resume("a".repeat(64), {
      publisherId: "pub",
      producerEpoch: "epoch",
      attempt: 1,
      revision: stream.info.revision,
    });
    let seq = 0;
    const append = async (content: EventContent) => {
      const event: PublishedEvent = {
        protocolVersion: 1,
        streamId: stream.info.id,
        producerEpoch: "epoch",
        producerSeq: ++seq,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock",
        elapsedMs: seq * 1000,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "paged" },
        content,
      };
      await stream.append(lease, [event]);
    };
    await append({
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    });
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: "before" },
    });
    const open = async () => {
      const result = await BrowserPagedSession.open(
        stream.info.id,
        "b".repeat(64),
        stop.signal,
        () => {},
        server.url,
        { platform },
      );
      expect(result).toBeInstanceOf(BrowserPagedSession);
      return result as BrowserPagedSession;
    };
    const legacy = await BrowserSession.open(
      stream.info.id,
      "b".repeat(64),
      stop.signal,
      () => {},
      server.url,
      { platform },
    );
    try {
      await expect.poll(() => legacy.received).toBe(stream.info.serverSeq);
      legacy.seek(legacy.duration);
      legacy.setSpeed(3);
    } finally {
      await legacy.close();
    }
    // Simulate interruption after the first migrated receipt publication, before preferences.
    const partial = await BrowserContentStore.open(
      platform.indexedDB,
      {
        serverOrigin: server.url,
        streamId: stream.info.id,
        revision: stream.info.revision,
      },
      stop.signal,
    );
    try {
      const recorded = await openRecordingHistory({
        serverOrigin: server.url,
        streamId: stream.info.id,
        credential: "b".repeat(64),
        signal: stop.signal,
      });
      const first = (await recorded.range({ throughServerSeq: 1 }).next())
        .value!;
      const reducer = new PagedReducer(partial);
      const root = await reducer.apply(initialPagedState(), first);
      await partial.publishCheckpoint(
        null,
        {
          format: "agentlive.paged-state",
          serverSeq: 1,
          timelineMs: root.timelineMs,
          ref: await reducer.checkpoint(root, {
            streamId: stream.info.id,
            revision: stream.info.revision,
          }),
        },
        stop.signal,
      );
    } finally {
      await partial.close();
    }
    viewer = await open();
    expect(viewer.restoredEvents).toBe(stream.info.serverSeq);
    expect(viewer.speed).toBe(3);
    expect(viewer.follow).toBe(false);
    await expect.poll(() => viewer!.received).toBe(stream.info.serverSeq);
    await expect.poll(() => viewer!.view.sequence).toBe(viewer.received);
    const selected = viewer.time,
      prefix = viewer.received;
    await viewer.seek(selected);
    expect(viewer.state.messages.size).toBe(0); // UI header does not materialize objects.
    const text = async () => {
      const row = (
        await viewer!.view.rows(0, 32, AbortSignal.timeout(5000))
      ).find((row) => row.key === "messages/m")!;
      const card = await viewer!.view.load(row, AbortSignal.timeout(5000));
      const source = card!.texts.text!;
      return source.read(0, source.units, AbortSignal.timeout(5000));
    };
    expect(await text()).toBe("before");
    viewer.setActive(false);
    await expect.poll(() => viewer!.status).toBe("suspended");
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: " after" },
    });
    expect(viewer.received).toBe(prefix);
    viewer.setActive(true);
    await expect.poll(() => viewer!.received).toBe(prefix + 1);
    expect(await text()).toBe("before");
    await viewer.seek(0);
    expect(viewer.view.rowCount).toBe(0);
    await viewer.seek(selected);
    expect(await text()).toBe("before");
    viewer.setSpeed(4);
    await viewer.close();
    viewer = await open();
    expect(viewer.restoredEvents).toBe(prefix + 1);
    expect(viewer.follow).toBe(false);
    expect(viewer.time).toBe(selected);
    expect(viewer.speed).toBe(4);
    expect(await text()).toBe("before");
    await viewer.seek(viewer.duration, true);
    expect(await text()).toBe("before after");
    expect(viewer.error).toBe("");
  } finally {
    await viewer?.close();
    stop.abort();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
