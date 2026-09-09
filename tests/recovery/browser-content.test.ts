import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  PagedReducer,
  initialPagedState,
  initialState,
  apply,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
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
