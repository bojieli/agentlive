import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  ContentIndex,
  type IndexRoot,
  type SnapshotContent,
} from "../../packages/playback/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-index-"));
  roots.push(root);
  return { root, store: await TextStore.open(root) };
}
it("updates one tree path, preserves historical roots and reopens bounded ordered ranges", async () => {
  const { root: directory, store } = await setup();
  let current = store;
  try {
    let reads = 0,
      writes = 0,
      largest = 0;
    const content: SnapshotContent = {
      put: (text, signal) => {
        writes++;
        return current.put(text, signal);
      },
      read: (ref, offset, length, signal) => {
        reads++;
        largest = Math.max(largest, length);
        return current.read(ref, offset, length, signal);
      },
    };
    let index = new ContentIndex(content),
      root: IndexRoot | null = null;
    const first = await store.put("payload".repeat(5000)),
      second = await store.put("replacement");
    const name = (i: number) => `key-${String(i).padStart(5, "0")}`;
    root = await index.build(
      (function* () {
        for (let i = 0; i < 1100; i++)
          yield [name(i), first] as [string, typeof first];
      })(),
    );
    expect(writes).toBeLessThanOrEqual(40);
    const old = root!;
    reads = 0;
    writes = 0;
    root = await index.set(root, name(551), second);
    expect(reads).toBeLessThanOrEqual(4);
    expect(writes).toBeLessThanOrEqual(4);
    expect(await index.get(old, name(551))).toEqual(first);
    expect(await index.get(root, name(551))).toEqual(second);
    const stable = root;
    writes = 0;
    expect(await index.set(root, name(551), second)).toEqual(stable);
    expect(await index.delete(root, "missing")).toEqual(stable);
    expect(writes).toBe(0);
    await store.close();
    current = await TextStore.open(directory);
    index = new ContentIndex(content);
    reads = 0;
    expect((await index.entries(root, 1023, 3)).map(([key]) => key)).toEqual([
      name(1023),
      name(1024),
      name(1025),
    ]);
    expect(reads).toBeLessThanOrEqual(6);
    expect(largest).toBeLessThanOrEqual(32768);
    expect(await index.get(root, name(551))).toEqual(second);
    expect(await index.get(old, name(551))).toEqual(first);
    const reduced = await index.delete(root, name(551));
    expect(reduced!.count).toBe(1099);
    expect(await index.get(reduced, name(551))).toBeUndefined();
    expect(await index.get(root, name(551))).toEqual(second);
  } finally {
    await current.close();
  }
}, 120000);
it("splits escaped keys by metadata size and deletes every entry without changing old roots", async () => {
  const { store } = await setup();
  try {
    const index = new ContentIndex(store),
      value = await store.put("value");
    const keys = Array.from(
      { length: 80 },
      (_, i) => String(i).padStart(3, "0") + "\u0000".repeat(509),
    );
    let root: IndexRoot | null = null;
    for (const key of keys.toReversed())
      root = await index.set(root, key, value);
    const old = root;
    const bulk = await index.build(keys.map((key) => [key, value]));
    expect((await index.entries(bulk, 7, 32)).map(([key]) => key)).toEqual(
      keys.slice(7, 39),
    );
    await expect(
      index.build([
        ["duplicate", value],
        ["duplicate", value],
      ]),
    ).rejects.toThrow("strictly increasing");
    expect(await index.build([])).toBeNull();
    expect((await index.entries(root, 7, 32)).map(([key]) => key)).toEqual(
      keys.slice(7, 39),
    );
    for (let i = 0; i < keys.length; i++) {
      root = await index.delete(root, keys[i]!);
      expect(root?.count ?? 0).toBe(keys.length - i - 1);
    }
    expect(root).toBeNull();
    expect(await index.get(old, keys[0]!)).toEqual(value);
  } finally {
    await store.close();
  }
}, 60000);
it("rejects corrupt counts, key bounds, unsupported versions, and partial content", async () => {
  const { store } = await setup();
  try {
    const index = new ContentIndex(store),
      value = await store.put("value");
    const root = await index.set(null, "key", value);
    for (const bad of [
      { ...root, count: 2 },
      { ...root, first: "a" },
      { ...root, last: "z" },
    ])
      await expect(index.get(bad, "key")).rejects.toMatchObject({
        code: "corrupt_storage",
      });
    const ref = await store.put(
      JSON.stringify({ version: 2, kind: "leaf", entries: [["key", value]] }),
    );
    await expect(index.get({ ...root, ref }, "key")).rejects.toMatchObject({
      code: "version_unsupported",
    });
    const partial = new ContentIndex({
      put: (text, signal) => store.put(text, signal),
      read: async () => "",
    });
    await expect(partial.get(root, "key")).rejects.toMatchObject({
      code: "corrupt_storage",
    });
  } finally {
    await store.close();
  }
});
it("does not return a changed root after cancellation following a durable write", async () => {
  const { store } = await setup();
  try {
    const base = new ContentIndex(store),
      first = await store.put("first"),
      second = await store.put("second");
    const root = await base.set(null, "key", first),
      abort = new AbortController();
    const interrupted = new ContentIndex({
      read: (ref, offset, length, signal) =>
        store.read(ref, offset, length, signal),
      put: async (text, signal) => {
        const ref = await store.put(text, signal);
        abort.abort(new Error("cancelled after write"));
        return ref;
      },
    });
    await expect(
      interrupted.set(root, "key", second, abort.signal),
    ).rejects.toThrow("cancelled after write");
    expect(await base.get(root, "key")).toEqual(first);
    const retry = await base.set(root, "key", second);
    expect(await base.get(retry, "key")).toEqual(second);
  } finally {
    await store.close();
  }
});
