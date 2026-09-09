import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  BrowserHistoryCache,
  CacheAheadError,
  clearSavedHistories,
} from "../../apps/web/src/history-cache.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require("fake-indexeddb");
const platform = () => ({
  indexedDB: new IDBFactory() as IDBFactory,
  keyRange: IDBKeyRange as typeof globalThis.IDBKeyRange,
});
const signal = () => AbortSignal.timeout(10000);
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "session",
  revision: "revision",
};
const event = (sequence: number): StoredEvent => ({
  protocolVersion: 1,
  serverSeq: sequence,
  timelineMs: sequence,
  receivedAt: "2026-09-09T00:00:00Z",
  origin: { type: "server", operationId: `op${sequence}` },
  content: {
    kind: "message.started",
    payload: { messageId: `message${sequence}`, role: "assistant" },
  },
});
async function mutate(factory: IDBFactory, run: (tx: IDBTransaction) => void) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("agentlive-history-v1");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["headers", "batches"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      run(tx);
    });
  } finally {
    db.close();
  }
}
it("restores a checked prefix and isolates origin, session and revision", async () => {
  const env = platform();
  let cache = await BrowserHistoryCache.open(binding, env, signal());
  expect(await cache.read(2, signal())).toEqual([]);
  expect(await cache.append([event(1), event(2)], signal())).toBe(true);
  cache.close();
  cache = await BrowserHistoryCache.open(binding, env, signal());
  expect(await cache.read(2, signal())).toEqual([event(1), event(2)]);
  await expect(cache.read(1, signal())).rejects.toBeInstanceOf(CacheAheadError);
  cache.close();
  for (const other of [
    { ...binding, serverOrigin: "http://localhost:7332" },
    { ...binding, streamId: "other" },
    { ...binding, revision: "other" },
  ]) {
    const isolated = await BrowserHistoryCache.open(other, env, signal());
    expect(await isolated.read(100, signal())).toEqual([]);
    isolated.close();
  }
});
it("fences a racing tab and a writer whose cache was explicitly cleared", async () => {
  const env = platform();
  const first = await BrowserHistoryCache.open(binding, env, signal()),
    second = await BrowserHistoryCache.open(binding, env, signal());
  const writes = await Promise.all([
    first.append([event(1)], signal()),
    second.append([event(1)], signal()),
  ]);
  expect([...writes].sort()).toEqual([false, true]);
  const reader = await BrowserHistoryCache.open(binding, env, signal());
  expect(await reader.read(1, signal())).toEqual([event(1)]);
  await reader.clear(signal());
  expect(
    await (writes[0] ? first : second)
      .append([event(1)], signal())
      .catch(() => false),
  ).toBe(false);
  first.close();
  second.close();
  const empty = await BrowserHistoryCache.open(binding, env, signal());
  expect(await empty.read(1, signal())).toEqual([]);
  empty.close();
});
it("rolls back both the batch and cursor if a write fails", async () => {
  const env = platform();
  const cache = await BrowserHistoryCache.open(binding, env, signal());
  await cache.append([event(1)], signal());
  const original = IDBObjectStore.prototype.put;
  const fault = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (value: any) {
      if (this.name === "headers" && value.sequence === 2)
        throw new DOMException("Quota exhausted", "QuotaExceededError");
      return original.call(this, value);
    });
  try {
    await expect(cache.append([event(2)], signal())).rejects.toThrow(
      "Quota exhausted",
    );
  } finally {
    fault.mockRestore();
    cache.close();
  }
  const reopened = await BrowserHistoryCache.open(binding, env, signal());
  expect(await reopened.read(2, signal())).toEqual([event(1)]);
  reopened.close();
});
it("rejects corrupted batches without returning their cursor", async () => {
  const env = platform();
  const cache = await BrowserHistoryCache.open(binding, env, signal());
  await cache.append([event(1)], signal());
  cache.close();
  await mutate(env.indexedDB, (tx) => {
    const request = tx.objectStore("batches").openCursor();
    request.onsuccess = () => {
      const cursor = request.result!;
      cursor.update({
        ...cursor.value,
        lines: cursor.value.lines.replace("assistant", "system"),
      });
    };
  });
  const reopened = await BrowserHistoryCache.open(binding, env, signal());
  await expect(reopened.read(1, signal())).rejects.toThrow("hash chain");
  await reopened.clear(signal());
});
it("evicts old recordings at the eight-recording limit and disables their old writers", async () => {
  const env = platform(),
    caches = [];
  for (let index = 0; index < 9; index++) {
    const cache = await BrowserHistoryCache.open(
      { ...binding, streamId: `session${index}` },
      env,
      signal(),
    );
    await cache.append([event(1)], signal());
    caches.push(cache);
  }
  expect(await caches[0]!.append([event(2)], signal())).toBe(false);
  let count = 0;
  await mutate(env.indexedDB, (tx) => {
    const request = tx.objectStore("headers").count();
    request.onsuccess = () => {
      count = request.result;
    };
  });
  expect(count).toBe(8);
  for (const cache of caches) cache.close();
});
it("clears saved histories with open connections and prevents old handles from writing", async () => {
  const env = platform(),
    cache = await BrowserHistoryCache.open(binding, env, signal());
  await cache.append([event(1)], signal());
  await clearSavedHistories(env, signal());
  await expect(cache.append([event(2)], signal())).rejects.toThrow();
  cache.close();
  const empty = await BrowserHistoryCache.open(binding, env, signal());
  expect(await empty.read(1, signal())).toEqual([]);
  empty.close();
});

it("rejoins from saved receipt, catches up its suffix, and checks access before opening the cache", async () => {
  const { BrowserSession } = await import("../../apps/web/src/session.js");
  const { startServer } = await import("../../packages/server/dist/index.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agentlive-browser-cache-"));
  const server = await startServer({
    directory: root,
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  const env = platform();
  let viewer: InstanceType<typeof BrowserSession> | undefined;
  try {
    const recording = await server.store.create({
      ownerId: "local",
      requestId: "cache",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "a".repeat(64),
      title: "Cache integration",
      visibility: "private",
    });
    const { lease } = await recording.resume("a".repeat(64), {
      publisherId: "pub",
      producerEpoch: "epoch",
      attempt: 1,
      revision: recording.info.revision,
    });
    let sequence = 0;
    const append = async (content: StoredEvent["content"]) =>
      recording.append(lease, [
        {
          protocolVersion: 1,
          streamId: recording.info.id,
          producerEpoch: "epoch",
          producerSeq: ++sequence,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock",
          elapsedMs: sequence,
          fidelity: "delta",
          source: { agent: "synthetic", sessionId: "cache" },
          content,
        },
      ]);
    await append({
      kind: "message.started",
      payload: { messageId: "message", role: "assistant" },
    });
    const open = (credential = "b".repeat(64)) =>
      BrowserSession.open(
        recording.info.id,
        credential,
        signal(),
        () => {},
        server.url,
        { platform: env },
      );
    viewer = await open();
    await expect.poll(() => viewer!.status).toBe("live");
    expect(viewer.cacheStatus).toBe("saved");
    const prefix = viewer.received;
    await viewer.close();
    await append({
      kind: "message.text.append",
      payload: { messageId: "message", text: "Suffix after reload" },
    });
    viewer = await open();
    expect(viewer.restoredEvents).toBe(prefix);
    await expect
      .poll(() => viewer!.state.messages.get("message")?.text)
      .toBe("Suffix after reload");
    await viewer.close();
    const spy = vi.spyOn(env.indexedDB, "open");
    try {
      await expect(open("")).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    await mutate(env.indexedDB, (tx) => {
      const request = tx.objectStore("batches").openCursor();
      request.onsuccess = () => {
        const cursor = request.result!;
        cursor.update({ ...cursor.value, hash: "f".repeat(64) });
      };
    });
    viewer = await open();
    expect(viewer.restoredEvents).toBe(0);
    await expect
      .poll(() => viewer!.state.messages.get("message")?.text)
      .toBe("Suffix after reload");
    expect(viewer.cacheStatus).toBe("saved");
    await viewer.close();
    const savedPrefix = viewer.received;
    for (const rollback of [false, true]) {
      let metadataReads = 0;
      const originalFetch = globalThis.fetch;
      const stale = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const response = await originalFetch(input, init);
          if (
            new URL(String(input)).pathname ===
            `/api/v1/streams/${recording.info.id}`
          ) {
            metadataReads++;
            if (rollback || metadataReads === 1) {
              const metadata = await response.json();
              return new Response(
                JSON.stringify({ ...metadata, serverSeq: savedPrefix - 1 }),
                { status: response.status, headers: response.headers },
              );
            }
          }
          return response;
        });
      try {
        if (rollback)
          await expect(open()).rejects.toBeInstanceOf(CacheAheadError);
        else {
          viewer = await open();
          expect(viewer.restoredEvents).toBe(savedPrefix);
          await viewer.close();
        }
        expect(metadataReads).toBe(2);
      } finally {
        stale.mockRestore();
      }
    }
    const unavailable = {
      ...env,
      indexedDB: {
        open() {
          throw new DOMException("Storage denied", "SecurityError");
        },
      } as unknown as IDBFactory,
    };
    viewer = await BrowserSession.open(
      recording.info.id,
      "b".repeat(64),
      signal(),
      () => {},
      server.url,
      { platform: unavailable },
    );
    expect(viewer.cacheStatus).toBe("memory");
    await expect
      .poll(() => viewer!.state.messages.get("message")?.text)
      .toBe("Suffix after reload");
    server.store.release(recording);
  } finally {
    await viewer?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("evicts complete entries when the catalog's accounted bytes exceed the site budget", async () => {
  const env = platform();
  for (let index = 0; index < 4; index++) {
    const cache = await BrowserHistoryCache.open(
      { ...binding, streamId: `old${index}` },
      env,
      signal(),
    );
    await cache.append([event(1)], signal());
    cache.close();
  }
  // Model four fully occupied entries without allocating 256 MiB in this accounting test.
  await mutate(env.indexedDB, (tx) => {
    const request = tx.objectStore("headers").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.update({ ...cursor.value, bytes: 64 * 1024 * 1024, used: 0 });
        cursor.continue();
      }
    };
  });
  const next = await BrowserHistoryCache.open(
    { ...binding, streamId: "new" },
    env,
    signal(),
  );
  await next.append([event(1)], signal());
  next.close();
  let headers = 0,
    batches = 0,
    bytes = 0;
  await mutate(env.indexedDB, (tx) => {
    const request = tx.objectStore("headers").getAll();
    request.onsuccess = () => {
      headers = request.result.length;
      bytes = request.result.reduce((total, row) => total + row.bytes, 0);
    };
    const count = tx.objectStore("batches").count();
    count.onsuccess = () => {
      batches = count.result;
    };
  });
  expect(headers).toBe(4);
  expect(batches).toBe(4);
  expect(bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
});
