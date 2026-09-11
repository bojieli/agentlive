import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { BrowserSnapshotRetention } from "../../apps/web/src/snapshot-retention.js";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import type { SnapshotLease } from "../../packages/protocol/src/index.js";
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
const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
const lease: SnapshotLease = {
  token: "b".repeat(64),
  expiresAt: 100000,
  snapshot: {
    format: "agentlive.paged-state",
    serverSeq: 1,
    timelineMs: 0,
    ref,
    activity: ref,
  },
};
it("adopts another tab's imports before reading and fences reads after shared invalidation", async () => {
  const factory = new IDBFactory();
  const order: string[] = [];
  const client = {
    acquireLease: vi.fn(async () => lease),
    renewLease: vi.fn(async (current: SnapshotLease) => {
      order.push(`renew:${current.token}`);
      return { ...current, expiresAt: current.expiresAt + 1000 };
    }),
    releaseLease: vi.fn(async () => {}),
    readBlob: vi.fn(async () => {
      order.push("read");
      return new Uint8Array(10);
    }),
  };
  const first = (
    await BrowserSnapshotRetention.open(factory, binding, client, signal())
  ).retention;
  const second = (
    await BrowserSnapshotRetention.open(factory, binding, client, signal())
  ).retention;
  const metadata = await BrowserContentStore.open(factory, binding, signal());
  try {
    await second.select(1, signal());
    order.length = 0;
    await Promise.all([
      first.readBlob(ref, signal()),
      first.readBlob(ref, signal()),
    ]);
    expect(order).toEqual([`renew:${lease.token}`, "read", "read"]);
    expect((await metadata.loadSnapshotLeases(signal()))[0]!.expiresAt).toBe(
      102000,
    );
    await metadata.invalidateSnapshotRoots(
      null,
      await metadata.loadSnapshotLeases(signal()),
      signal(),
    );
    client.readBlob.mockClear();
    await expect(first.readBlob(ref, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    await expect(first.select(1, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect(client.readBlob).not.toHaveBeenCalled();
    expect(await metadata.loadSnapshotLeases(signal())).toEqual([]);
  } finally {
    await first.close();
    await second.close();
    await metadata.close();
  }
});
it("does not read a dependency when renewal of another tab's import fails", async () => {
  const factory = new IDBFactory();
  const client = {
    acquireLease: vi.fn(async () => lease),
    renewLease: vi.fn(async (current: SnapshotLease) => current),
    releaseLease: vi.fn(async () => {}),
    readBlob: vi.fn(async () => new Uint8Array(10)),
  };
  const first = (
    await BrowserSnapshotRetention.open(factory, binding, client, signal())
  ).retention;
  const second = (
    await BrowserSnapshotRetention.open(factory, binding, client, signal())
  ).retention;
  try {
    await second.select(1, signal());
    client.renewLease.mockRejectedValueOnce(new TypeError("network offline"));
    await expect(first.readBlob(ref, signal())).rejects.toThrow(
      "network offline",
    );
    expect(client.readBlob).not.toHaveBeenCalled();
    await first.readBlob(ref, signal());
    expect(client.readBlob).toHaveBeenCalledTimes(1);
  } finally {
    await first.close();
    await second.close();
  }
});
