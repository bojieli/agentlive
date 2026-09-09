import { it, expect } from "vitest";
import {
  readTextPage,
  sourcePageContaining,
  findSourceText,
  type TextSource,
} from "../../apps/web/src/text-source.js";
import { textPage, pageContaining } from "../../apps/web/src/text-page.js";
const signal = () => AbortSignal.timeout(10000);
function input(text: string, reads: Array<[number, number]> = []): TextSource {
  return {
    key: "text",
    units: text.length,
    read: async (offset, length) => {
      reads.push([offset, length]);
      return text.slice(offset, offset + length);
    },
  };
}
it("matches memory paging at surrogate boundaries using bounded ranges", async () => {
  for (const text of [
    "",
    "x".repeat(16383) + "🦊" + "y".repeat(16383) + "🦊\ud800",
    "🦊".repeat(20000),
  ]) {
    const reads: Array<[number, number]> = [],
      source = input(text, reads);
    for (let page = 0; page < 5; page++)
      expect(await readTextPage(source, page, signal())).toEqual(
        textPage(text, page),
      );
    for (const offset of [
      0,
      Math.min(text.length, 16383),
      Math.min(text.length, 16384),
      text.length,
    ])
      expect(await sourcePageContaining(source, offset, signal())).toBe(
        pageContaining(text, offset),
      );
    expect(reads.every(([, length]) => length <= 16386)).toBe(true);
  }
});
it("finds literal matches across chunks without hydrating the full text", async () => {
  const text = "x".repeat(16383) + "[needle]🦊" + "y".repeat(40000),
    reads: Array<[number, number]> = [];
  const source = input(text, reads);
  expect(await findSourceText(source, "[needle]", signal())).toBe(
    text.indexOf("[needle]"),
  );
  expect(await findSourceText(source, "absent", signal())).toBe(-1);
  expect(reads.every(([, length]) => length <= 16384 + 255)).toBe(true);
});
it("rejects partial reads and cancels an uncooperative source", async () => {
  await expect(
    readTextPage(
      { key: "short", units: 10, read: async () => "short" },
      0,
      signal(),
    ),
  ).rejects.toThrow("invalid range");
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const stop = new AbortController(),
    task = readTextPage(
      {
        key: "stalled",
        units: 10,
        read: async () => {
          start();
          return new Promise(() => {});
        },
      },
      0,
      stop.signal,
    );
  await started;
  stop.abort(new Error("cancelled"));
  await expect(task).rejects.toThrow("cancelled");
});
it("yields during large unmatched scans so cancellation is observed", async () => {
  const stop = new AbortController();
  let reads = 0;
  const source: TextSource = {
    key: "large",
    units: 67108864,
    read: async (_offset, length) => {
      reads++;
      return "x".repeat(length);
    },
  };
  const task = findSourceText(source, "absent", stop.signal);
  setTimeout(() => stop.abort(new Error("cancel scan")), 0);
  await expect(task).rejects.toThrow("cancel scan");
  expect(reads).toBeLessThan(10);
});
