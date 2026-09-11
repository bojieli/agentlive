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
    reads = 0;
    expect(await index.rank(reduced, name(1024))).toBe(1023);
    expect(reads).toBeLessThanOrEqual(4);
    expect(await index.rank(root, name(1024))).toBe(1024);
    expect(await index.rank(reduced, name(551))).toBeUndefined();
    expect(await index.rank(root, "key-99999")).toBeUndefined();
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

it("traces validated branches and opaque values with callback isolation and cancellation", async () => {
  const { store } = await setup();
  try {
    const value = await store.put("opaque payload");
    const writer = new ContentIndex(store);
    const root = (await writer.build(
      Array.from(
        { length: 70 },
        (_, index) =>
          [String(index).padStart(3, "0"), value] as [string, typeof value],
      ),
    ))!;
    const reads: string[] = [];
    const index = new ContentIndex({
      put: () => {
        throw new Error("Trace must not write");
      },
      read: (ref, offset, length, signal) => {
        reads.push(ref.hash);
        return store.read(ref, offset, length, signal);
      },
    });
    const keys: string[] = [];
    const traced = await index.trace(root, async (item) => {
      if (item.kind === "value") keys.push(item.key);
      item.ref.hash = "0".repeat(64);
    });
    expect(traced.values).toBe(70);
    expect(traced.nodes).toBeGreaterThan(1);
    expect(keys).toEqual(
      Array.from({ length: 70 }, (_, index) => String(index).padStart(3, "0")),
    );
    expect(reads).not.toContain(value.hash);
    expect(reads).toHaveLength(traced.nodes);
    const abort = new AbortController();
    let calls = 0;
    await expect(
      index.trace(
        root,
        async () => {
          calls++;
          abort.abort(new Error("stop trace"));
        },
        abort.signal,
      ),
    ).rejects.toThrow("stop trace");
    expect(calls).toBe(1);
    await expect(
      index.trace({ ...root, count: root.count + 1 }, async () => {}),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    await expect(
      index.trace(root, async () => {
        throw new Error("mark failed");
      }),
    ).rejects.toThrow("mark failed");
    expect(
      await index.trace(null, async () => {
        throw new Error("unexpected");
      }),
    ).toEqual({ nodes: 0, values: 0 });
    // A reused subtree is neither loaded nor visited, but still counted.
    reads.length = 0;
    const skipped = new Set<string>();
    const partial = await index.trace(
      root,
      async (item) => {
        if (item.kind === "node")
          expect(skipped.has(item.ref.hash)).toBe(false);
      },
      undefined,
      (ref) => {
        if (ref.hash === root.ref.hash || skipped.size) return false;
        skipped.add(ref.hash);
        return true;
      },
    );
    expect(partial.values).toBe(70);
    expect(partial.nodes).toBe(traced.nodes - 1);
    expect(reads).not.toContain([...skipped][0]);
    reads.length = 0;
    expect(
      await index.trace(
        root,
        async () => {},
        undefined,
        () => true,
      ),
    ).toEqual({ nodes: 0, values: 70 });
    expect(reads).toHaveLength(0);
  } finally {
    await store.close();
  }
});

it("fast content-reference parsing matches the schema decision and output", async () => {
  const { parseContentReference, snapshotContentReferenceSchema } =
    await import("../../packages/protocol/src/index.js");
  const hash = "ab".repeat(32);
  const cases: unknown[] = [
    { hash, byteSize: 1, units: 0 },
    { hash, byteSize: 1048576, units: 67108864 },
    { units: 5, byteSize: 9, hash },
    { hash, byteSize: 0, units: 0 },
    { hash, byteSize: 1048577, units: 0 },
    { hash, byteSize: 1, units: -1 },
    { hash, byteSize: 1, units: 67108865 },
    { hash, byteSize: 1.5, units: 0 },
    { hash, byteSize: Number.NaN, units: 0 },
    { hash, byteSize: 1, units: Infinity },
    { hash, byteSize: "1", units: 0 },
    { hash: hash.toUpperCase(), byteSize: 1, units: 0 },
    { hash: hash.slice(1), byteSize: 1, units: 0 },
    { hash: `${hash}\n`, byteSize: 1, units: 0 },
    { hash, byteSize: 1 },
    { hash, byteSize: 1, units: 0, extra: true },
    { hash, byteSize: 1, units: undefined },
    Object.assign(Object.create(null), { hash, byteSize: 1, units: 0 }),
    Object.assign(Object.create({ units: 0 }), { hash, byteSize: 1 }),
    Object.defineProperty({ hash, byteSize: 1, extra: 0 }, "units", {
      value: 0,
    }),
    Object.defineProperty({ hash, byteSize: 1, units: 0 }, "hidden", {
      value: 1,
    }),
    [hash, 1, 0],
    null,
    undefined,
    "reference",
    7,
  ];
  for (const value of cases) {
    const expected = snapshotContentReferenceSchema.safeParse(value);
    const actual = parseContentReference(value);
    expect(actual).toEqual(expected.success ? expected.data : undefined);
    if (actual) expect(actual).not.toBe(value);
  }
});
