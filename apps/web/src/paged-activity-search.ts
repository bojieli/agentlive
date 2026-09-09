import type { PagedActivityView } from "./paged-activity.js";
import { searchActivity, type ActivitySearchPage } from "./activity-search.js";
import {
  findSourceText,
  readSourceRange,
  type TextSource,
} from "./text-source.js";

async function excerpt(source: TextSource, query: string, signal: AbortSignal) {
  const found = await findSourceText(source, query, signal);
  if (found < 0) return undefined;
  const start = Math.max(0, found - 81),
    end = Math.min(source.units, found + query.length + 121);
  const text = await readSourceRange(source, start, end - start, signal);
  signal.throwIfAborted();
  if (text.length !== end - start)
    throw new Error("Invalid search excerpt range");
  let from = start > 0 ? 1 : 0,
    through = end < source.units ? text.length - 1 : text.length;
  const split = (at: number) =>
    at > 0 &&
    at < text.length &&
    text.charCodeAt(at - 1) >= 0xd800 &&
    text.charCodeAt(at - 1) <= 0xdbff &&
    text.charCodeAt(at) >= 0xdc00 &&
    text.charCodeAt(at) <= 0xdfff;
  if (split(from)) from--;
  if (split(through)) through++;
  return `${start + from > 0 ? "…" : ""}${text.slice(from, through)}${start + through < source.units ? "…" : ""}`;
}
/** Search a frozen index with at most 32 row identities and one card projection retained. */
export async function searchPagedActivity(
  view: PagedActivityView,
  query: string,
  signal: AbortSignal,
  startIndex = 0,
): Promise<ActivitySearchPage> {
  if (!query.length || query.length > 256)
    throw new RangeError("Search requires 1–256 characters");
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    startIndex > view.rowCount
  )
    throw new RangeError("Invalid search continuation");
  const matches: ActivitySearchPage["matches"] = [];
  for (let offset = startIndex; offset < view.rowCount; offset += 32) {
    signal.throwIfAborted();
    const rows = await view.rows(offset, 32, signal);
    if (!rows.length)
      throw new Error("Activity search encountered a missing row range");
    for (const [relative, row] of rows.entries()) {
      let found: string | undefined;
      for (let versionOffset = 0; ; versionOffset += 32) {
        signal.throwIfAborted();
        const card = await view.load(row, signal, versionOffset);
        if (!card)
          throw new Error(
            "Activity search encountered a missing indexed object",
          );
        // Search only the selected object's metadata, not its related objects.
        if (card.gap) card.state.gaps.push(card.gap);
        const metadata = await searchActivity(
          card.state,
          [card.gap ? { ...row, id: "0" } : row],
          query,
          signal,
        );
        found = metadata.matches[0]?.excerpt;
        if (found === undefined)
          for (const source of Object.values(card.texts)) {
            found = await excerpt(source, query, signal);
            if (found !== undefined) break;
          }
        if (
          found !== undefined ||
          !card.versions ||
          versionOffset + 32 >= card.versions.total
        )
          break;
      }
      signal.throwIfAborted();
      if (found !== undefined) {
        const index = offset + relative;
        if (matches.length === 50) return { matches, nextIndex: index };
        matches.push({ key: row.key, index, excerpt: found });
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return { matches, nextIndex: null };
}
