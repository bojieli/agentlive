import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  rm,
  readdir,
  writeFile,
  readFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BlobStore,
  type BlobLimits,
} from "../../packages/storage/src/index.js";
const roots: string[] = [];
const stores: BlobStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const descriptor = (bytes: Uint8Array) => ({
  hash: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.byteLength,
});
async function* source(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
}
async function setup(limits: Partial<BlobLimits> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentlive-blob-test-"));
  roots.push(root);
  const store = await BlobStore.open(join(root, "attachments"), limits);
  stores.push(store);
  return store;
}
it("streams, hashes and durably installs immutable bytes; repeated uploads deduplicate", async () => {
  const store = await setup();
  const bytes = Buffer.from("synthetic image bytes 雨🌧️");
  const expected = descriptor(bytes);
  await store.install(await store.stage(expected, source(bytes)));
  await store.install(await store.stage(expected, source(bytes)));
  expect(await readFile(join(store.directory, expected.hash))).toEqual(bytes);
  expect(store.usage.storedBytes).toBe(bytes.length);
  expect(store.usage.reservedBytes).toBe(0);
  await store.verify(expected);
  expect(await readdir(join(store.directory, ".uploads"))).toEqual([]);
});
it("rejects short, overlong and hash-mismatched uploads without leaving complete files or reservations", async () => {
  const store = await setup();
  const bytes = Buffer.from("expected");
  const expected = descriptor(bytes);
  await expect(
    store.stage(expected, source(bytes.subarray(0, 3))),
  ).rejects.toMatchObject({ code: "event_conflict" });
  await expect(
    store.stage(expected, source(Buffer.from("too many bytes"))),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    store.stage({ ...expected, hash: "f".repeat(64) }, source(bytes)),
  ).rejects.toMatchObject({ code: "event_conflict" });
  expect(store.usage).toEqual({
    storedBytes: 0,
    reservedBytes: 0,
    activeUploads: 0,
  });
  expect(await readdir(store.directory)).toEqual([".uploads"]);
  expect(await readdir(join(store.directory, ".uploads"))).toEqual([]);
});
it("reserves quota for in-progress uploads and reclaims it after discard", async () => {
  const store = await setup({ maxTotalBytes: 10 });
  const bytes = Buffer.from("123456");
  const expected = descriptor(bytes);
  const stage = await store.stage(expected, source(bytes));
  await expect(store.stage(expected, source(bytes))).rejects.toMatchObject({
    code: "retry_later",
  });
  await store.discard(stage);
  expect(store.usage.reservedBytes).toBe(0);
  await store.install(await store.stage(expected, source(bytes)));
  expect(store.usage.storedBytes).toBe(6);
});
it("aborts a stalled source on shutdown before releasing its staging ownership", async () => {
  const store = await setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          started();
          return new Promise(() => {});
        },
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
  const result = store
    .stage(descriptor(Buffer.from("x")), input)
    .catch((error) => error);
  await ready;
  await store.close();
  expect(await result).toBeInstanceOf(Error);
  expect(store.usage.activeUploads).toBe(0);
  expect(await readdir(join(store.directory, ".uploads"))).toEqual([]);
});
it("cleans abandoned temporary uploads on reopen and detects corrupt immutable bytes", async () => {
  const store = await setup();
  const bytes = Buffer.from("original");
  const expected = descriptor(bytes);
  await store.install(await store.stage(expected, source(bytes)));
  await store.close();
  await writeFile(join(store.directory, ".uploads", "abandoned"), "partial");
  const reopened = await BlobStore.open(store.directory);
  stores.push(reopened);
  expect(await readdir(join(store.directory, ".uploads"))).toEqual([]);
  await writeFile(join(store.directory, expected.hash), "tampered");
  await expect(reopened.verify(expected)).rejects.toMatchObject({
    code: "corrupt_storage",
  });
});
it("collects expired unreferenced blobs and preserves all pinned hashes", async () => {
  const store = await setup();
  const old = Buffer.from("old");
  const kept = Buffer.from("kept");
  for (const bytes of [old, kept]) {
    const expected = descriptor(bytes);
    await store.install(await store.stage(expected, source(bytes)));
    await utimes(
      join(store.directory, expected.hash),
      new Date(0),
      new Date(0),
    );
  }
  expect(
    await store.collect(new Set([descriptor(kept).hash]), Date.now() - 1000),
  ).toBe(1);
  await store.verify(descriptor(kept));
  await expect(store.verify(descriptor(old))).rejects.toMatchObject({
    code: "precondition_failed",
  });
  expect(store.usage.storedBytes).toBe(4);
});
