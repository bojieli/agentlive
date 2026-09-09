import { expect, it } from "vitest";
import { searchActivity } from "../../apps/web/src/activity-search.js";
import { activityRows } from "../../apps/web/src/activity.js";
import { initialState } from "../../packages/playback/src/index.js";
function fixture(texts: string[]) {
  const state = initialState();
  texts.forEach((text, index) =>
    state.messages.set(String(index), {
      id: String(index),
      role: "assistant",
      text,
      completed: true,
    }),
  );
  const rows = activityRows(state, (key) => Number(key.split("/")[1]));
  return { state, rows };
}
it("finds Unicode literal text across scanning chunks without interpreting regex or HTML", async () => {
  const { state, rows } = fixture([
    "x".repeat(16383) + "🦊[a.*]<script>" + "y".repeat(30000),
  ]);
  const page = await searchActivity(
    state,
    rows,
    "🦊[a.*]<script>",
    new AbortController().signal,
  );
  expect(page.matches).toHaveLength(1);
  expect(page.matches[0]!.excerpt).toContain("🦊[a.*]<script>");
  expect(page.matches[0]!.excerpt.length).toBeLessThan(500);
  expect(
    (await searchActivity(state, rows, "🦊[A.*]", new AbortController().signal))
      .matches,
  ).toEqual([]);
});
it("paginates matching objects without duplicates and excludes hidden objects", async () => {
  const { state } = fixture(Array.from({ length: 120 }, () => "needle"));
  state.messages.get("3")!.visible = false;
  const rows = activityRows(state, (key) => Number(key.split("/")[1]));
  let next = 0;
  const keys: string[] = [];
  do {
    const result = await searchActivity(
      state,
      rows,
      "needle",
      new AbortController().signal,
      next,
    );
    expect(result.matches.length).toBeLessThanOrEqual(50);
    keys.push(...result.matches.map((match) => match.key));
    if (result.nextIndex === null) break;
    next = result.nextIndex;
  } while (true);
  expect(keys).toHaveLength(119);
  expect(new Set(keys).size).toBe(119);
  expect(keys).not.toContain("messages/3");
});
it("yields to cancellation while scanning a large unmatched output", async () => {
  const { state, rows } = fixture(["a".repeat(4 * 1024 * 1024)]);
  const abort = new AbortController();
  const work = searchActivity(state, rows, "missing", abort.signal);
  setTimeout(() => abort.abort(new Error("cancelled")), 0);
  await expect(work).rejects.toThrow("cancelled");
});
it("rejects invalid searches and pre-cancelled work", async () => {
  const { state, rows } = fixture(["text"]);
  for (const query of ["", "x".repeat(257)])
    await expect(
      searchActivity(state, rows, query, new AbortController().signal),
    ).rejects.toThrow("1–256");
  await expect(
    searchActivity(state, rows, "text", new AbortController().signal, NaN),
  ).rejects.toThrow("continuation");
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(
    searchActivity(state, rows, "text", abort.signal),
  ).rejects.toThrow("cancelled");
});

it("keeps supplementary Unicode characters whole at excerpt boundaries", async () => {
  const { state, rows } = fixture([
    "prefix🦊" + "a".repeat(79) + "needle" + "b".repeat(119) + "🦊suffix",
  ]);
  const page = await searchActivity(
    state,
    rows,
    "needle",
    new AbortController().signal,
  );
  const excerpt = page.matches[0]!.excerpt;
  expect(excerpt.isWellFormed()).toBe(true);
  expect(excerpt.match(/🦊/gu)).toHaveLength(2);
});
