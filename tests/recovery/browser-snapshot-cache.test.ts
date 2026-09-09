import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { BrowserSnapshotCache } from "../../apps/web/src/snapshot-cache.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
const signal = () => AbortSignal.timeout(10000);
it("persists exact UTF-16 ranges across reopen and rejects corrupted cached content", async () => {
  const factory = new IDBFactory();
  let cache = await BrowserSnapshotCache.open(factory, signal());
  const text = "a🦊\ud800";
  try {
    await cache.write("key", text, signal());
    cache.close();
    cache = await BrowserSnapshotCache.open(factory, signal());
    expect(await cache.read("key", signal())).toBe(text);
    expect(await cache.read("other-revision", signal())).toBeUndefined();
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = factory.open("agentlive-snapshot-ranges-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("ranges", "readwrite");
      const store = tx.objectStore("ranges"),
        req = store.get("key");
      req.onsuccess = () => store.put({ ...req.result, text: "changed" });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    expect(await cache.read("key", signal())).toBeUndefined();
    await cache.write("key", text, signal());
    expect(await cache.read("key", signal())).toBe(text);
  } finally {
    cache.close();
  }
});
it("bounds retained ranges and rejects oversized input and operations after close", async () => {
  const cache = await BrowserSnapshotCache.open(new IDBFactory(), signal());
  try {
    for (let i = 0; i < 260; i++)
      await cache.write(`key-${i.toString().padStart(3, "0")}`, "x", signal());
    expect(await cache.read("key-000", signal())).toBeUndefined();
    expect(await cache.read("key-259", signal())).toBe("x");
    await expect(
      cache.write("large", "x".repeat(65537), signal()),
    ).rejects.toThrow("limit");
    const stop = new AbortController();
    stop.abort(new Error("cancelled"));
    await expect(cache.write("cancelled", "x", stop.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(await cache.read("cancelled", signal())).toBeUndefined();
  } finally {
    cache.close();
  }
  await expect(cache.read("key-259", signal())).rejects.toThrow("closed");
});

it("clears saved ranges across open handles", async () => {
  const factory = new IDBFactory(),
    cache = await BrowserSnapshotCache.open(factory, signal());
  try {
    await cache.write("key", "text", signal());
    await BrowserSnapshotCache.clear(factory, signal());
    expect(await cache.read("key", signal())).toBeUndefined();
  } finally {
    cache.close();
  }
});
