import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import {
  PagedReducer,
  initialPagedState,
} from "../../packages/playback/src/index.js";
import { openRecordingHistory } from "../../packages/client/src/index.js";
import { BrowserSession } from "../../apps/web/src/session.js";
import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/dist/index.js";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import { ProtocolError } from "../../packages/protocol/dist/index.js";
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
    const open = async (
      resumeView?: NonNullable<BrowserPagedSession["recoveryPresentation"]>,
    ) => {
      const result = await BrowserPagedSession.open(
        stream.info.id,
        "b".repeat(64),
        stop.signal,
        () => {},
        server.url,
        { platform, ...(resumeView ? { resumeView } : {}) },
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
    const opening = vi.spyOn(BrowserPagedState, "open");
    try {
      opening.mockRejectedValueOnce(
        new ProtocolError("stale_lease", "generation changed during open"),
      );
      viewer = await open();
      expect(opening).toHaveBeenCalledTimes(2);
    } finally {
      opening.mockRestore();
    }

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
    {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = BrowserPagedState.prototype.retainedView;
      let discarded: Awaited<ReturnType<typeof original>> | undefined;
      const acquisition = vi
        .spyOn(BrowserPagedState.prototype, "retainedView")
        .mockImplementationOnce(async function (...args) {
          discarded = await original.apply(this, args);
          entered();
          await gate;
          return discarded;
        });
      try {
        const following = viewer.seek(viewer.duration, true);
        await started;
        const paused = viewer.seek(selected);
        release();
        await Promise.all([following, paused]);
        expect(viewer.follow).toBe(false);
        expect(viewer.time).toBe(selected);
        await expect(
          discarded!.rows(0, 1, AbortSignal.timeout(5000)),
        ).rejects.toThrow("closed");
        expect(await text()).toBe("before");
      } finally {
        release();
        acquisition.mockRestore();
      }
    }
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
    const retiredView = viewer.view;
    await viewer.seek(0);
    await expect(
      retiredView.rows(0, 1, AbortSignal.timeout(5000)),
    ).rejects.toThrow("closed");
    expect(viewer.view.rowCount).toBe(0);
    await viewer.seek(selected);
    expect(await text()).toBe("before");
    viewer.setSpeed(4);
    viewer.setDisclosure("message:m", true);
    viewer.setTextPage("message:m/text", 2);
    const attachmentChoice = {
      artifactId: "artifact",
      version: 1,
      hash: "c".repeat(64),
      filename: "note.txt",
      mediaType: "text/plain",
      byteSize: 5,
    };
    viewer.setAttachmentChoice(attachmentChoice);
    await viewer.close();
    viewer = await open();
    expect(viewer.restoredEvents).toBe(prefix + 1);
    expect(viewer.follow).toBe(false);
    expect(viewer.time).toBe(selected);
    expect(viewer.speed).toBe(4);
    expect(viewer.expandedDisclosures).toEqual(["message:m"]);
    expect(viewer.textPages).toContainEqual(["message:m/text", 2]);
    expect(viewer.selectedAttachment).toEqual(attachmentChoice);
    expect(await text()).toBe("before");
    await viewer.seek(viewer.duration, true);
    expect(await text()).toBe("before after");
    expect(viewer.error).toBe("");
    await viewer.close();
    await stream.buildSnapshot(prefix, stop.signal);
    await stream.buildSnapshot(prefix + 1, stop.signal);
    platform.indexedDB = new IDBFactory();
    const requested: URL[] = [];
    const fetcher = globalThis.fetch;
    const observed = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        requested.push(
          new URL(input instanceof Request ? input.url : String(input)),
        );
        return fetcher(input, init);
      });
    try {
      viewer = await open();
      expect(viewer.snapshotEvents).toBe(prefix + 1);
      expect(viewer.restoredEvents).toBe(0);
      expect(viewer.received).toBe(prefix + 1);
      requested.length = 0;
      await viewer.seek(selected);
    } finally {
      observed.mockRestore();
    }
    expect(
      requested.some((url) => url.pathname.endsWith("/snapshot-leases")),
    ).toBe(true);
    const ranges = requested.filter((url) => url.pathname.endsWith("/events"));
    expect(ranges.length).toBeGreaterThan(0);
    expect(
      ranges.every(
        (url) => Number(url.searchParams.get("afterServerSeq")) >= prefix,
      ),
    ).toBe(true);
    expect(viewer.view.sequence).toBe(prefix);
    expect(await text()).toBe("before");
    expect(viewer.received).toBe(prefix + 1);
    await viewer.close();
    const metadata = await BrowserContentStore.open(
      platform.indexedDB,
      {
        serverOrigin: server.url,
        streamId: stream.info.id,
        revision: stream.info.revision,
      },
      stop.signal,
    );
    try {
      const leases = await metadata.loadSnapshotLeases(stop.signal);
      expect(leases.length).toBeGreaterThan(0);
      for (const lease of leases)
        await stream.releaseSnapshotLease(lease.token, stop.signal);
    } finally {
      await metadata.close();
    }
    viewer = await open();
    expect(viewer.follow).toBe(false);
    expect(viewer.view.sequence).toBe(prefix);
    expect(await text()).toBe("before");
    await viewer.seek(viewer.duration, true);
    // Reduce a live suffix before any card has fetched the imported object's pages.
    await append({ kind: "message.completed", payload: { messageId: "m" } });
    await expect.poll(() => viewer!.received).toBe(prefix + 2);
    await expect.poll(() => viewer!.view.sequence).toBe(prefix + 2);
    expect(await text()).toBe("before after");
    expect(viewer.error).toBe("");
    await viewer.seek(selected);
    viewer.setSpeed(3);
    viewer.setIdleCap(250);
    const frozenSequence = viewer.view.sequence;
    const frozenTime = viewer.time;
    const invalidator = await BrowserContentStore.open(
      platform.indexedDB,
      {
        serverOrigin: server.url,
        streamId: stream.info.id,
        revision: stream.info.revision,
      },
      stop.signal,
    );
    try {
      await invalidator.invalidateSnapshotRoots(
        await invalidator.loadCheckpoint(stop.signal),
        await invalidator.loadSnapshotLeases(stop.signal),
        stop.signal,
      );
    } finally {
      await invalidator.close();
    }
    await append({
      kind: "message.started",
      payload: { messageId: "new", role: "assistant" },
    });
    await expect.poll(() => viewer!.recoveryPresentation).toBeDefined();
    const resume = viewer.recoveryPresentation!;
    expect(resume.serverSeq).toBe(frozenSequence);
    expect(resume.timelineMs).toBe(frozenTime);
    await viewer.close();
    viewer = await open(resume);
    expect(viewer.view.sequence).toBe(frozenSequence);
    expect(viewer.time).toBe(frozenTime);
    expect(viewer.speed).toBe(3);
    expect(viewer.idleCapMs).toBe(250);
    expect(viewer.follow).toBe(false);
    await expect.poll(() => viewer!.received).toBe(prefix + 3);
    expect(viewer.error).toBe("");
    await viewer.close();
    const failedOpen = vi.spyOn(BrowserPagedState, "open");
    try {
      failedOpen.mockRejectedValue(
        new ProtocolError("stale_lease", "repeated generation change"),
      );
      await expect(open()).rejects.toThrow("repeated generation change");
      expect(failedOpen).toHaveBeenCalledTimes(2);
      for (const code of [
        "forbidden",
        "corrupt_storage",
        "event_conflict",
      ] as const) {
        failedOpen.mockClear();
        failedOpen.mockRejectedValue(new ProtocolError(code, "do not retry"));
        await expect(open()).rejects.toThrow("do not retry");
        expect(failedOpen).toHaveBeenCalledTimes(1);
      }
    } finally {
      failedOpen.mockRestore();
    }
  } finally {
    await viewer?.close();
    stop.abort();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
