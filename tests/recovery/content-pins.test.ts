import { it, expect } from "vitest";
import { ContentPins } from "../../packages/storage/src/index.js";
const a = { hash: "a".repeat(64), byteSize: 10, units: 3 };
const b = { hash: "b".repeat(64), byteSize: 20, units: 7 };
it("captures immutable deduplicated roots and excludes admissions and updates throughout a barrier", async () => {
  const pins = new ContentPins(2, 2),
    input = { ...a };
  const first = pins.pin([input]),
    second = pins.pin([a]);
  input.hash = b.hash;
  expect(() => pins.pin([b])).toThrow("capacity");
  await pins.withBarrier(async (roots) => {
    expect(roots).toEqual([{ ref: a, kind: "text" }]);
    expect(Object.isFrozen(roots)).toBe(true);
    expect(Object.isFrozen(roots[0])).toBe(true);
    expect(Object.isFrozen(roots[0]!.ref)).toBe(true);
    first.release();
    first.release();
    expect(roots).toEqual([{ ref: a, kind: "text" }]);
    expect(() => pins.pin([b])).toThrow("barrier");
    expect(() => second.update([b])).toThrow("barrier");
    await expect(pins.withBarrier(async () => {})).rejects.toThrow("barrier");
  });
  second.update([b]);
  expect(() => first.update([a])).toThrow("released");
  await pins.withBarrier(async (roots) => {
    expect(roots).toEqual([{ ref: b, kind: "text" }]);
  });
  second.release();
  expect(pins.size).toBe(0);
});
it("keeps the barrier held after cancellation until accepted work drains, and releases after errors", async () => {
  const pins = new ContentPins();
  pins.pin([a]);
  const abort = new AbortController();
  let finish!: () => void;
  const pending = pins.withBarrier(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    abort.signal,
  );
  const rejected = expect(pending).rejects.toThrow("cancelled");
  abort.abort(new Error("cancelled"));
  expect(() => pins.pin([b])).toThrow("barrier");
  finish();
  await rejected;
  const next = pins.pin([b]);
  next.release();
  await expect(
    pins.withBarrier(async () => {
      throw new Error("mark failed");
    }),
  ).rejects.toThrow("mark failed");
  pins.pin([b]).release();
  let called = false;
  await expect(
    pins.withBarrier(async () => {
      called = true;
    }, abort.signal),
  ).rejects.toThrow("cancelled");
  expect(called).toBe(false);
});
it("rejects malformed and conflicting roots without publishing a partial pin update", async () => {
  const pins = new ContentPins(2, 1),
    pin = pins.pin([a]);
  expect(() => pin.update([a, b])).toThrow("limit");
  expect(() => pin.update([{ ...b, units: -1 }])).toThrow();
  await pins.withBarrier(async (roots) => {
    expect(roots).toEqual([{ ref: a, kind: "text" }]);
  });
  const conflict = pins.pin([{ ...a, byteSize: 11 }]);
  let called = false;
  await expect(
    pins.withBarrier(async () => {
      called = true;
    }),
  ).rejects.toMatchObject({ code: "corrupt_storage" });
  expect(called).toBe(false);
  conflict.release();
  await pins.withBarrier(async () => {});
});

it("preserves text and exact-blob semantics when the same hash has both kinds of pin", async () => {
  const pins = new ContentPins();
  const text = pins.pin([a]);
  const blob = pins.pin([a], "blob");
  await pins.withBarrier(async (roots) => {
    expect(roots).toEqual([
      { ref: a, kind: "text" },
      { ref: a, kind: "blob" },
    ]);
  });
  text.release();
  blob.update([b]);
  await pins.withBarrier(async (roots) => {
    expect(roots).toEqual([{ ref: b, kind: "blob" }]);
  });
  const conflict = pins.pin([{ ...b, units: b.units + 1 }]);
  await expect(pins.withBarrier(async () => {})).rejects.toMatchObject({
    code: "corrupt_storage",
  });
  conflict.release();
  blob.release();
});
