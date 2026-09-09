import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  OrderedContentMap,
  type OrderedMapRoot,
  type ContentReference,
  type OrderedMapKey,
} from "../../packages/playback/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-ordered-map-"));
  roots.push(root);
  return { root, store: await TextStore.open(root) };
}
async function entries(map: OrderedContentMap, root: OrderedMapRoot | null) {
  const result = [];
  for (let i = 0; i < (root?.size ?? 0); i += 32)
    result.push(...(await map.entries(root, i, 32)));
  return result;
}
it("preserves Map order, numeric keys and historical versions across restart", async () => {
  const { root: directory, store } = await setup();
  let current = store;
  try {
    let map = new OrderedContentMap(store),
      root: OrderedMapRoot | null = null;
    const one = await store.put("one"),
      two = await store.put("two");
    const expected = new Map<OrderedMapKey, ContentReference>();
    const keys: OrderedMapKey[] = [
      "last",
      1,
      "1",
      -0,
      "",
      "🦊\ud800",
      "\u0000".repeat(4096),
    ];
    for (let i = 0; i < 70; i++) keys.push(`key-${70 - i}`);
    for (const key of keys) {
      root = await map.set(root, key, one);
      expected.set(key, one);
    }
    const old = root;
    root = await map.set(root, 1, two);
    expected.set(1, two);
    root = await map.set(root, 0, two);
    expected.set(0, two);
    root = await map.delete(root, "last");
    expected.delete("last");
    root = await map.set(root, "last", two);
    expected.set("last", two);
    expect(root!.size).toBe(expected.size);
    expect(await entries(map, root)).toEqual([...expected]);
    expect(await map.get(root, 1)).toEqual(two);
    expect(await map.get(root, "1")).toEqual(one);
    expect(await map.get(old, 1)).toEqual(one);
    const usage = store.usage.storedBytes;
    expect(await map.set(root, "last", two)).toEqual(root);
    expect(await map.delete(root, "missing")).toEqual(root);
    expect(store.usage.storedBytes).toBe(usage);
    await store.close();
    current = await TextStore.open(directory);
    map = new OrderedContentMap(current);
    expect(await entries(map, root)).toEqual([...expected]);
    expect((await map.entries(old, 0, 3)).map(([key]) => key)).toEqual([
      "last",
      1,
      "1",
    ]);
    for (const key of expected.keys()) root = await map.delete(root, key);
    expect(root).toMatchObject({ size: 0, byKey: null, byOrder: null });
    expect(await map.get(root, 1)).toBeUndefined();
    expect(await map.entries(root, 0, 32)).toEqual([]);
    root = await map.set(root, "again", one);
    expect(await entries(map, root)).toEqual([["again", one]]);
  } finally {
    await current.close();
  }
}, 60000);
it("rejects mixed index roots before returning a lookup or range", async () => {
  const { store } = await setup();
  try {
    const map = new OrderedContentMap(store),
      one = await store.put("one"),
      two = await store.put("two");
    const first = await map.set(null, "key", one),
      second = await map.set(first, "key", two);
    const mixed = { ...second, byOrder: first.byOrder };
    await expect(map.get(mixed, "key")).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await expect(map.entries(mixed, 0, 1)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await expect(map.get({ ...first, size: 2 }, "key")).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await expect(
      map.get({ ...first, version: 2 } as never, "key"),
    ).rejects.toMatchObject({ code: "version_unsupported" });
    await expect(map.set(first, "x".repeat(4097), one)).rejects.toThrow("4096");
    await expect(map.set(first, NaN, one)).rejects.toThrow("finite");
  } finally {
    await store.close();
  }
});
it("cancels between index writes without returning a mixed root and permits a deduplicated retry", async () => {
  const { store } = await setup();
  try {
    const map = new OrderedContentMap(store),
      one = await store.put("one"),
      two = await store.put("two");
    const old = await map.set(null, "key", one),
      abort = new AbortController();
    let writes = 0;
    const interrupted = new OrderedContentMap({
      read: (ref, offset, length, signal) =>
        store.read(ref, offset, length, signal),
      put: async (text, signal) => {
        const ref = await store.put(text, signal);
        if (++writes === 2) abort.abort(new Error("interrupted map update"));
        return ref;
      },
    });
    await expect(
      interrupted.set(old, "key", two, abort.signal),
    ).rejects.toThrow("interrupted map update");
    expect(writes).toBe(2);
    expect(await map.get(old, "key")).toEqual(one);
    const retry = await map.set(old, "key", two);
    expect(await map.get(retry, "key")).toEqual(two);
    expect(await entries(map, retry)).toEqual([["key", two]]);
  } finally {
    await store.close();
  }
});
