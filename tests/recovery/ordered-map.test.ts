import { afterEach, expect, it, vi } from "vitest";
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

it("traces both indexes, validates their pairing and leaves application values opaque", async () => {
  const { store } = await setup();
  try {
    const map = new OrderedContentMap(store);
    const value = await store.put("opaque value");
    let root: OrderedMapRoot | null = null;
    for (const key of ["z", 1, "1", "a"])
      root = await map.set(root, key, value);
    const old = root!;
    root = await map.delete(root, 1);
    const reads: string[] = [];
    const reader = new OrderedContentMap({
      put: () => {
        throw new Error("Tracing must not write");
      },
      read: (ref, offset, length, signal) => {
        reads.push(ref.hash);
        return store.read(ref, offset, length, signal);
      },
    });
    const keys: OrderedMapKey[] = [],
      nodes = new Set<string>(),
      entries = new Set<string>();
    await reader.trace(root, async (item) => {
      if (item.kind === "value") keys.push(item.key);
      else (item.kind === "node" ? nodes : entries).add(item.ref.hash);
      item.ref.hash = "0".repeat(64);
    });
    expect(keys).toEqual(["z", "1", "a"]);
    expect(nodes.size).toBe(2);
    expect(entries.size).toBe(3);
    expect(reads).not.toContain(value.hash);
    const original: OrderedMapKey[] = [];
    await reader.trace(old, async (item) => {
      if (item.kind === "value") original.push(item.key);
    });
    expect(original).toEqual(["z", 1, "1", "a"]);
    // Same-sized indexes from different maps must not be accepted as a retained map.
    const replacement = await map.set(
      root,
      "a",
      await store.put("replacement"),
    );
    await expect(
      reader.trace({ ...root!, byKey: replacement.byKey }, async () => {}),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const abort = new AbortController();
    let calls = 0;
    await expect(
      reader.trace(
        root,
        async () => {
          calls++;
          abort.abort(new Error("cancelled trace"));
        },
        abort.signal,
      ),
    ).rejects.toThrow("cancelled trace");
    expect(calls).toBe(1);
    await expect(
      reader.trace(root, async () => {
        throw new Error("mark failed");
      }),
    ).rejects.toThrow("mark failed");
    await reader.trace(null, async () => {
      throw new Error("unexpected");
    });
  } finally {
    await store.close();
  }
});

it("bounds stalled native digest waits and lets cancellation reject without waiting for crypto", async () => {
  const { store } = await setup();
  const map = new OrderedContentMap(store);
  const value = await store.put("value");
  const root = {
    version: 1 as const,
    size: 0,
    nextOrdinal: 0,
    byKey: null,
    byOrder: null,
  };
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(() => new Promise(() => {}));
  try {
    const stop = new AbortController();
    const pending = map.set(root, "key", value, stop.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled digest");
    await Promise.resolve();
    stop.abort(new Error("cancelled digest"));
    await rejected;
    vi.useFakeTimers();
    const timed = expect(map.set(root, "key", value)).rejects.toMatchObject({
      code: "retry_later",
    });
    await vi.advanceTimersByTimeAsync(30000);
    await timed;
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
    await store.close();
  }
});
