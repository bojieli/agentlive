import { expect, it } from "vitest";
import { MemoryContentStore } from "../../apps/web/src/memory-content.js";
const signal = () => AbortSignal.timeout(10000);
it("reclaims unreachable versions while retaining shared Unicode pages and accurate quota", async () => {
  const store = new MemoryContentStore();
  try {
    const first = await store.put("a".repeat(16384) + "🦊old");
    const next = await store.append(first, "new");
    const garbage = await store.put("unreachable");
    const before = store.usage;
    const result = await store.collect(async (mark) => {
      await mark(next);
    }, signal());
    expect(result.removedEntries).toBeGreaterThan(0);
    expect(result.bytes + result.removedBytes).toBe(before.bytes);
    expect(result.entries + result.removedEntries).toBe(before.entries);
    expect(await store.read(next, 16384, 8)).toBe("🦊oldnew");
    await expect(store.read(garbage, 0, 1)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    expect(
      (
        await store.collect(async (mark) => {
          await mark(next);
        }, signal())
      ).removedEntries,
    ).toBe(0);
  } finally {
    await store.close();
  }
});
it("does not sweep on failed marking, cancellation or an intervening deduplicated write", async () => {
  const store = new MemoryContentStore();
  try {
    const keep = await store.put("keep"),
      other = await store.put("other");
    const before = store.usage;
    await expect(
      store.collect(async (mark) => {
        await mark(keep);
        throw new Error("trace failed");
      }, signal()),
    ).rejects.toThrow("trace failed");
    expect(store.usage).toEqual(before);
    const stop = new AbortController();
    await expect(
      store.collect(async (mark) => {
        await mark(keep);
        stop.abort(new Error("cancel sweep"));
      }, stop.signal),
    ).rejects.toThrow("cancel sweep");
    expect(store.usage).toEqual(before);
    await expect(
      store.collect(async (mark) => {
        await mark(keep);
        await store.put("other");
      }, signal()),
    ).rejects.toMatchObject({ code: "retry_later" });
    expect(await store.read(other, 0, 5)).toBe("other");
    expect(store.usage).toEqual(before);
    await expect(
      store.collect(async (mark) => {
        try {
          await mark({ ...keep, hash: "0".repeat(64) });
        } catch {}
      }, signal()),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    expect(store.usage).toEqual(before);
  } finally {
    await store.close();
  }
});
it("rejects overlapping collection and closes a stuck root traversal", async () => {
  const store = new MemoryContentStore();
  await store.put("held");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = store.collect(async () => {
    entered();
    await new Promise<void>(() => {});
  }, signal());
  const rejected = expect(pending).rejects.toThrow("closing");
  await started;
  await expect(store.collect(async () => {}, signal())).rejects.toMatchObject({
    code: "retry_later",
  });
  await store.close();
  await rejected;
  expect(store.usage).toEqual({ bytes: 0, entries: 0 });
});

it("rejects conflicting descriptors even after the same manifest was marked", async () => {
  const store = new MemoryContentStore();
  try {
    const kept = await store.put("kept");
    const garbage = await store.put("candidate");
    const before = store.usage;
    for (const altered of [
      { ...kept, units: kept.units + 1 },
      { ...kept, byteSize: kept.byteSize + 1 },
    ]) {
      await expect(
        store.collect(async (mark) => {
          await mark(kept);
          // Swallowing a bad mark must still poison the complete sweep.
          try {
            await mark(altered);
          } catch {}
        }, signal()),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
      expect(store.usage).toEqual(before);
      expect(await store.read(garbage, 0, garbage.units)).toBe("candidate");
    }
  } finally {
    await store.close();
  }
});

it("refuses incomplete asynchronous marking before any deletion", async () => {
  const store = new MemoryContentStore();
  try {
    const kept = await store.put("kept");
    await store.put("candidate");
    const before = store.usage;
    await expect(
      store.collect(async (mark) => {
        void mark(kept);
      }, signal()),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(store.usage).toEqual(before);
    expect(await store.read(kept, 0, 4)).toBe("kept");
  } finally {
    await store.close();
  }
});
