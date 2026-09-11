import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  ActivityIndex,
  initialActivityIndex,
  PagedReducer,
  initialPagedState,
  initialState,
  apply,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBObjectStore } = require("fake-indexeddb");
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
it("shares exact filesystem references through Unicode append and browser reopen", async () => {
  const factory = new IDBFactory(),
    directory = await mkdtemp(join(tmpdir(), "agentlive-browser-content-"));
  const disk = await TextStore.open(directory);
  let browser = await BrowserContentStore.open(factory, binding, signal());
  try {
    const prefix = "x".repeat(16383) + "🦊\ud800",
      suffix = "y".repeat(20000) + "🦊";
    const base = await browser.put(prefix);
    expect(base).toEqual(await disk.put(prefix));
    const appended = await browser.append(base, suffix);
    expect(appended).toEqual(await disk.put(prefix + suffix));
    expect(await browser.trace(appended, signal())).toEqual(
      await disk.trace(appended, signal()),
    );
    const cancelled = new AbortController();
    cancelled.abort(new Error("trace cancelled"));
    await expect(browser.trace(appended, cancelled.signal)).rejects.toThrow(
      "trace cancelled",
    );
    await browser.close();
    browser = await BrowserContentStore.open(factory, binding, signal());
    expect(await browser.read(appended, 16383, 7)).toBe(
      (prefix + suffix).slice(16383, 16390),
    );
    expect(await browser.append(appended, "")).toEqual(appended);
    expect(await browser.read(base, 16383, 3)).toBe(prefix.slice(16383));
    const foreign = await BrowserContentStore.open(
      factory,
      { ...binding, revision: "other" },
      signal(),
    );
    try {
      await expect(foreign.read(base, 0, 1)).rejects.toMatchObject({
        code: "corrupt_storage",
      });
    } finally {
      await foreign.close();
    }
  } finally {
    await browser.close();
    await disk.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves paged reducer state and continues a pending replacement after reopening", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  const contents = [
    { kind: "message.started", payload: { messageId: "m", role: "assistant" } },
    {
      kind: "text.replacement.started",
      payload: { replacementId: "r", target: "message", targetId: "m" },
    },
    {
      kind: "text.replacement.chunk",
      payload: { replacementId: "r", index: 0, text: "replacement" },
    },
    {
      kind: "text.replacement.completed",
      payload: { replacementId: "r", parts: 1 },
    },
  ];
  try {
    let reducer = new PagedReducer(store),
      state = initialPagedState(),
      reference = initialState();
    for (let i = 0; i < contents.length; i++) {
      const event = {
        protocolVersion: 1,
        serverSeq: i + 1,
        timelineMs: i,
        receivedAt: "2026-09-10T00:00:00Z",
        origin: { type: "server", operationId: `event-${i}` },
        content: contents[i],
      } as StoredEvent;
      state = await reducer.apply(state, event);
      reference = apply(reference, event);
      if (i === 2) {
        const root = await reducer.checkpoint(state, binding);
        await store.close();
        store = await BrowserContentStore.open(factory, binding, signal());
        reducer = new PagedReducer(store);
        state = await reducer.open(root, binding);
      }
    }
    expect(await reducer.materialize(state)).toStrictEqual(reference);
  } finally {
    await store.close();
  }
});
it("enforces shared quota atomically and drains cancelled input on close", async () => {
  const factory = new IDBFactory(),
    a = await BrowserContentStore.open(factory, binding, signal(), 1000),
    b = await BrowserContentStore.open(factory, binding, signal(), 1000);
  try {
    const outcomes = await Promise.allSettled([
      a.put("a".repeat(600)),
      b.put("b".repeat(600)),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const result = outcomes.find(
      (item) => item.status === "fulfilled",
    ) as PromiseFulfilledResult<any>;
    expect((await a.read(result.value, 0, 1)).length).toBe(1);
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = a.put({
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            started();
            return new Promise(() => {});
          },
          return: () => new Promise(() => {}),
        };
      },
    });
    const rejection = expect(waiting).rejects.toThrow("closing");
    await reading;
    await a.close();
    await rejection;
    await expect(a.put("closed")).rejects.toThrow("closing");
  } finally {
    await a.close();
    await b.close();
  }
});

it("rejects corrupted persisted bytes and closes open handles when clearing content", async () => {
  const factory = new IDBFactory(),
    store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const ref = await store.put("content");
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = factory.open("agentlive-content-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("blobs", "readwrite"),
          req = tx.objectStore("blobs").openCursor();
        req.onsuccess = () => {
          const row = req.result;
          if (!row) return;
          if (String(row.key).endsWith(ref.hash)) {
            const bytes = row.value as Uint8Array;
            bytes[0] ^= 1;
            row.update(bytes);
          }
          row.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    await expect(store.read(ref, 0, 1)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await expect(store.put("content")).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await BrowserContentStore.clear(factory, signal());
    await expect(store.put("closed")).rejects.toThrow("closing");
    const reopened = await BrowserContentStore.open(factory, binding, signal());
    try {
      expect(await reopened.put("content")).toEqual(ref);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});
it("persists revision-scoped lease provenance with atomic renewal and release fencing", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  const other = await BrowserContentStore.open(
    factory,
    { ...binding, revision: "other" },
    signal(),
  );
  const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
  const lease = {
    token: "b".repeat(64),
    expiresAt: 100,
    snapshot: {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 0,
      ref,
      activity: ref,
    },
  };
  try {
    const input = structuredClone(lease);
    const saving = store.saveSnapshotLease(null, input, signal());
    input.snapshot.ref.hash = "c".repeat(64);
    await saving;
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    expect(await store.loadSnapshotLeases()).toEqual([lease]);
    expect(await other.loadSnapshotLeases()).toEqual([]);
    const renewed = { ...lease, expiresAt: 200 };
    const outcomes = await Promise.allSettled([
      store.saveSnapshotLease(lease, renewed, signal()),
      store.saveSnapshotLease(lease, { ...lease, expiresAt: 300 }, signal()),
    ]);
    expect(outcomes.map((item) => item.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await expect(
      store.saveSnapshotLease(
        renewed,
        null,
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    expect(await store.loadSnapshotLeases()).toEqual([renewed]);
    await store.saveSnapshotLease(renewed, null, signal());
    await expect(
      store.saveSnapshotLease(
        renewed,
        { ...renewed, expiresAt: 400 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await store.loadSnapshotLeases()).toEqual([]);
  } finally {
    await store.close();
    await other.close();
  }
});
it("rejects lease cache overflow without evicting existing reader provenance", async () => {
  const store = await BrowserContentStore.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
  const make = (n: number) => ({
    token: n.toString(16).padStart(64, "0"),
    expiresAt: 100,
    snapshot: {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 0,
      ref,
      activity: ref,
    },
  });
  try {
    for (let n = 0; n < 128; n++)
      await store.saveSnapshotLease(null, make(n), signal());
    await expect(
      store.saveSnapshotLease(null, make(128), signal()),
    ).rejects.toMatchObject({ code: "retry_later" });
    expect(await store.loadSnapshotLeases()).toHaveLength(128);
    await store.saveSnapshotLease(
      make(0),
      { ...make(0), expiresAt: 200 },
      signal(),
    );
    await store.saveSnapshotLease(make(1), null, signal());
    await store.saveSnapshotLease(null, make(128), signal());
    expect(await store.loadSnapshotLeases()).toHaveLength(128);
  } finally {
    await store.close();
  }
});

it("persists renewed lease metadata while an admitted blob loader waits for it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-lease-loader-"));
  const remote = await TextStore.open(directory);
  let browser!: BrowserContentStore;
  const ref = await remote.put("leased content");
  const lease = {
    token: "b".repeat(64),
    expiresAt: 100,
    snapshot: {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref,
      activity: ref,
    },
  };
  let saved = lease,
    renewals = 0;
  browser = await BrowserContentStore.open(
    new IDBFactory(),
    binding,
    signal(),
    undefined,
    async (reference, active) => {
      const next = { ...saved, expiresAt: saved.expiresAt + 100 };
      await browser.saveSnapshotLease(saved, next, active);
      saved = next;
      renewals++;
      return remote.readBlob(reference, active);
    },
  );
  try {
    await browser.saveSnapshotLease(null, lease, signal());
    expect(
      await browser.read(ref, 0, ref.units, AbortSignal.timeout(2000)),
    ).toBe("leased content");
    expect(renewals).toBe(2);
    expect(await browser.loadSnapshotLeases()).toEqual([saved]);
    await browser.close();
    await expect(browser.loadSnapshotLeases()).rejects.toThrow("closing");
  } finally {
    await browser.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("atomically invalidates stale derivative roots while preserving content and selected view", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(store),
      activity = new ActivityIndex(store);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref: await reducer.checkpoint(initialPagedState(), binding),
      activity: await activity.checkpoint(initialActivityIndex(), binding),
    };
    await store.publishCheckpoint(null, head, signal());
    await store.saveSeekCheckpoint(head, signal());
    const view = {
      mode: "paused" as const,
      serverSeq: 0,
      timelineMs: 0,
      speed: 2,
    };
    await store.saveView(view, signal());
    const lease = { token: "b".repeat(64), expiresAt: 100, snapshot: head };
    await store.saveSnapshotLease(null, lease, signal());
    await expect(
      store.invalidateSnapshotRoots(head, [], signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
    expect(await store.loadCheckpoint()).toEqual(head);
    await expect(
      store.invalidateSnapshotRoots(null, [lease], signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await store.invalidateSnapshotRoots(head, [lease], signal());
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    expect(await store.loadCheckpoint()).toBeNull();
    expect(await store.loadCheckpointBefore(0, 0, signal())).toBeNull();
    expect(await store.loadSnapshotLeases()).toEqual([]);
    expect(await store.loadView(signal())).toEqual(view);
    expect(
      (await new PagedReducer(store).open(head.ref, binding)).appliedSeq,
    ).toBe(0);
    await expect(
      store.publishCheckpoint(head, head, signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
  } finally {
    await store.close();
  }
});
it("keeps the reconstruction target durable until the prior receipt is rebuilt", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(store);
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: 1,
      timelineMs: 0,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: "recovery" },
      content: {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
    };
    const state = await reducer.apply(initialPagedState(), event);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 0,
      ref: await reducer.checkpoint(state, binding),
    };
    const stale = await BrowserContentStore.open(factory, binding, signal());
    try {
      await store.publishCheckpoint(null, head, signal());
      await store.invalidateSnapshotRoots(head, [], signal());
      // Even null -> root publication must reject after another connection
      // invalidates the generation. The content itself is still readable.
      await expect(
        stale.publishCheckpoint(null, head, signal()),
      ).rejects.toMatchObject({ code: "stale_lease" });
      await store.publishCheckpoint(null, head, signal());
      // Idempotent publication cannot bypass the generation check either.
      await expect(
        stale.publishCheckpoint(head, head, signal()),
      ).rejects.toMatchObject({ code: "stale_lease" });
      await store.invalidateSnapshotRoots(head, [], signal());
      expect(await store.loadCheckpoint(signal())).toBeNull();
    } finally {
      await stale.close();
    }
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    expect(await store.loadRecoveryThrough(signal())).toBe(1);
    // A second invalidation before rebuilding any root must not erase the
    // original receipt target, including across another reopen.
    await store.invalidateSnapshotRoots(null, [], signal());
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    expect(await store.loadRecoveryThrough(signal())).toBe(1);
    await expect(store.finishRecovery(signal())).rejects.toMatchObject({
      code: "precondition_failed",
    });
    await store.publishCheckpoint(null, head, signal());
    await store.finishRecovery(signal());
    expect(await store.loadRecoveryThrough(signal())).toBe(0);
  } finally {
    await store.close();
  }
});

it("merges out-of-order renewal from separate tabs without shortening or resurrecting a lease", async () => {
  const factory = new IDBFactory();
  const first = await BrowserContentStore.open(factory, binding, signal());
  const second = await BrowserContentStore.open(factory, binding, signal());
  const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
  const lease = {
    token: "b".repeat(64),
    expiresAt: 100,
    snapshot: {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref,
      activity: ref,
    },
  };
  try {
    await first.saveSnapshotLease(null, lease, signal());
    await Promise.all([
      first.renewSnapshotLease({ ...lease, expiresAt: 300 }, signal()),
      second.renewSnapshotLease({ ...lease, expiresAt: 200 }, signal()),
    ]);
    const [saved] = await second.loadSnapshotLeases();
    expect(saved!.expiresAt).toBe(300);
    await expect(
      second.renewSnapshotLease(
        { ...lease, snapshot: { ...lease.snapshot, serverSeq: 1 } },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await first.saveSnapshotLease(saved!, null, signal());
    await expect(
      second.renewSnapshotLease({ ...lease, expiresAt: 400 }, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
    expect(await second.loadSnapshotLeases()).toEqual([]);
  } finally {
    await first.close();
    await second.close();
  }
});

it("rolls back lease renewal when cancelled after the IndexedDB write is issued but before commit", async () => {
  const store = await BrowserContentStore.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
  const lease = {
    token: "b".repeat(64),
    expiresAt: 100,
    snapshot: {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref,
      activity: ref,
    },
  };
  const stop = new AbortController();
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await store.saveSnapshotLease(null, lease, signal());
    const put = IDBObjectStore.prototype.put;
    spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        const request = put.apply(this, args);
        if (typeof args[1] === "string" && args[1].startsWith("leases:"))
          stop.abort(new Error("cancel before commit"));
        return request;
      });
    await expect(
      store.renewSnapshotLease({ ...lease, expiresAt: 200 }, stop.signal),
    ).rejects.toThrow("cancel before commit");
    spy.mockRestore();
    expect(await store.loadSnapshotLeases()).toEqual([lease]);
  } finally {
    spy?.mockRestore();
    await store.close();
  }
});

it("migrates unleased derivatives once and preserves the rebuild target across reopen", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(store);
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: 1,
      timelineMs: 0,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: "migration" },
      content: {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
    };
    const root = await reducer.apply(initialPagedState(), event);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 0,
      ref: await reducer.checkpoint(root, binding),
    };
    await store.publishCheckpoint(null, head, signal());
    const view = {
      mode: "paused" as const,
      serverSeq: 1,
      timelineMs: 0,
      speed: 2,
    };
    await store.saveView(view, signal());
    await store.prepareSnapshotRetention(signal());
    expect(await store.loadCheckpoint()).toBeNull();
    expect(await store.loadRecoveryThrough(signal())).toBe(1);
    expect(await store.loadView(signal())).toEqual(view);
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    await store.prepareSnapshotRetention(signal());
    expect(await store.loadRecoveryThrough(signal())).toBe(1);
    await store.publishCheckpoint(null, head, signal());
    await store.finishRecovery(signal());
    await store.prepareSnapshotRetention(signal());
    expect(await store.loadCheckpoint()).toEqual(head);
    expect(await store.loadRecoveryThrough(signal())).toBe(0);
  } finally {
    await store.close();
  }
});

it("fences stale seek and lease admission after another connection migrates derivative roots", async () => {
  const factory = new IDBFactory();
  const stale = await BrowserContentStore.open(factory, binding, signal());
  const current = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(current);
    const activity = new ActivityIndex(current);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref: await reducer.checkpoint(initialPagedState(), binding),
      activity: await activity.checkpoint(initialActivityIndex(), binding),
    };
    await current.prepareSnapshotRetention(signal());
    await current.publishCheckpoint(null, head, signal());
    await expect(
      stale.saveSeekCheckpoint(head, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await expect(
      stale.saveSnapshotLease(
        null,
        {
          token: "d".repeat(64),
          expiresAt: 100000,
          snapshot: head,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await expect(
      stale.saveView(
        { mode: "paused", serverSeq: 0, timelineMs: 0, speed: 4 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await expect(stale.finishRecovery(signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect(await current.loadSnapshotLeases(signal())).toEqual([]);
    await current.saveSeekCheckpoint(head, signal());
    expect(await current.loadCheckpointBefore(0, 0, signal())).toEqual(head);
  } finally {
    await stale.close();
    await current.close();
  }
});

it("rolls back the generation with an interrupted invalidation transaction", async () => {
  const factory = new IDBFactory();
  const first = await BrowserContentStore.open(factory, binding, signal());
  const second = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(first);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 0,
      timelineMs: 0,
      ref: await reducer.checkpoint(initialPagedState(), binding),
    };
    await first.publishCheckpoint(null, head, signal());
    const stop = new AbortController();
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        const request = put.apply(this, args);
        if (typeof args[1] === "string" && args[1].startsWith("generation:"))
          stop.abort(new Error("interrupt invalidation"));
        return request;
      });
    try {
      await expect(
        first.invalidateSnapshotRoots(head, [], stop.signal),
      ).rejects.toThrow("interrupt invalidation");
    } finally {
      spy.mockRestore();
    }
    expect(await first.loadCheckpoint(signal())).toEqual(head);
    // Neither the invalidating connection nor another open connection becomes
    // stale after an aborted generation write.
    await first.publishCheckpoint(head, head, signal());
    await second.publishCheckpoint(head, head, signal());
    await first.invalidateSnapshotRoots(head, [], signal());
    await expect(
      second.publishCheckpoint(null, head, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
  } finally {
    await first.close();
    await second.close();
  }
});

it("persists bounded disclosure choices, merges tab changes and preserves them through root invalidation", async () => {
  const factory = new IDBFactory();
  let first = await BrowserContentStore.open(factory, binding, signal());
  const second = await BrowserContentStore.open(factory, binding, signal());
  try {
    await Promise.all([
      first.setExpansion("message:a", true, signal()),
      second.setExpansion("message:b", true, signal()),
    ]);
    expect(await first.loadExpansions(signal())).toEqual([
      "message:a",
      "message:b",
    ]);
    await second.setExpansion("message:a", false, signal());
    await first.invalidateSnapshotRoots(null, [], signal());
    expect(await first.loadExpansions(signal())).toEqual(["message:b"]);
    await expect(
      second.setExpansion("stale", true, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
    for (let index = 0; index < 130; index++)
      await first.setExpansion(`row:${index}`, true, signal());
    await first.close();
    first = await BrowserContentStore.open(factory, binding, signal());
    const saved = await first.loadExpansions(signal());
    expect(saved).toHaveLength(128);
    expect(saved[0]).toBe("row:2");
    expect(saved.at(-1)).toBe("row:129");
  } finally {
    await first.close();
    await second.close();
  }
});

it("persists and clears an attachment choice while fencing stale writers", async () => {
  const factory = new IDBFactory();
  let first = await BrowserContentStore.open(factory, binding, signal());
  const second = await BrowserContentStore.open(factory, binding, signal());
  const choice = {
    artifactId: "artifact",
    version: 2,
    hash: "a".repeat(64),
    filename: "note.txt",
    mediaType: "text/plain",
    byteSize: 5,
  };
  try {
    await first.setAttachmentChoice(choice, signal());
    choice.filename = "changed.txt";
    expect((await first.loadAttachmentChoice(signal()))?.filename).toBe(
      "note.txt",
    );
    expect(() =>
      first.setAttachmentChoice({ ...choice, version: -1 }, signal()),
    ).toThrow();
    await first.invalidateSnapshotRoots(null, [], signal());
    await expect(
      second.setAttachmentChoice(undefined, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await first.close();
    first = await BrowserContentStore.open(factory, binding, signal());
    expect((await first.loadAttachmentChoice(signal()))?.version).toBe(2);
    await first.setAttachmentChoice(undefined, signal());
    expect(await first.loadAttachmentChoice(signal())).toBeUndefined();
  } finally {
    await first.close();
    await second.close();
  }
});

it("persists bounded text page choices and fences invalidated writers", async () => {
  const factory = new IDBFactory();
  let first = await BrowserContentStore.open(factory, binding, signal());
  const second = await BrowserContentStore.open(factory, binding, signal());
  try {
    await Promise.all([
      first.setTextPage("m/text", 3, signal()),
      second.setTextPage("tool/output", "latest", signal()),
    ]);
    expect(await first.loadTextPages(signal())).toEqual([
      ["m/text", 3],
      ["tool/output", "latest"],
    ]);
    expect(() => first.setTextPage("m/text", -1, signal())).toThrow();
    await first.invalidateSnapshotRoots(null, [], signal());
    await expect(
      second.setTextPage("m/text", 4, signal()),
    ).rejects.toMatchObject({ code: "stale_lease" });
    expect(await first.loadTextPages(signal())).toHaveLength(2);
    for (let i = 0; i < 130; i++)
      await first.setTextPage(`page:${i}`, i, signal());
    await first.close();
    first = await BrowserContentStore.open(factory, binding, signal());
    const pages = await first.loadTextPages(signal());
    expect(pages).toHaveLength(128);
    expect(pages[0]).toEqual(["page:2", 2]);
    expect(pages.at(-1)).toEqual(["page:129", 129]);
  } finally {
    await first.close();
    await second.close();
  }
});
