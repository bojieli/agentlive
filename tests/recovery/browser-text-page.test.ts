import { expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  textPage,
  pageContaining,
  TEXT_PAGE_SIZE,
} from "../../apps/web/src/text-page.js";
import { PagedText } from "../../apps/web/src/paged-text.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
it("reassembles every text unit exactly once without splitting surrogate pairs", () => {
  const text =
    "a".repeat(TEXT_PAGE_SIZE - 1) +
    "🦊" +
    "b".repeat(TEXT_PAGE_SIZE - 2) +
    "🦊" +
    "tail";
  const pages = Array.from({ length: textPage(text, 0).count }, (_, index) =>
    textPage(text, index),
  );
  expect(pages.map((page) => page.text).join("")).toBe(text);
  for (const page of pages) {
    expect(page.text.isWellFormed()).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(TEXT_PAGE_SIZE + 1);
    if (page.text.length)
      expect(pageContaining(text, page.start)).toBe(page.page);
  }
  expect(pageContaining(text, TEXT_PAGE_SIZE - 1)).toBe(1);
  expect(pageContaining(text, TEXT_PAGE_SIZE)).toBe(1);
});
it("clamps retained pages after a seek and rejects invalid positions", () => {
  expect(textPage("short", 100)).toMatchObject({
    page: 0,
    count: 1,
    text: "short",
  });
  expect(textPage("", 0)).toMatchObject({ page: 0, count: 1, text: "" });
  for (const page of [-1, NaN, Infinity, 1.5])
    expect(() => textPage("text", page)).toThrow("page");
  expect(() => pageContaining("text", 5)).toThrow("offset");
});
it("bounds production text markup while preserving navigation to the rest", () => {
  const text = "<script>" + "a".repeat(1024 * 1024) + "END_MARKER";
  const html = renderToStaticMarkup(
    createElement(PagedText, {
      text,
      choice: "tool/output",
      group: "tool",
      label: "Tool output",
    }),
  );
  expect(html.length).toBeLessThan(18000);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("page 1 of");
  expect(html).toContain("Next");
  expect(html).not.toContain("END_MARKER");
  const last = textPage(text, Number.MAX_SAFE_INTEGER);
  expect(last.text).toContain("END_MARKER");
});
