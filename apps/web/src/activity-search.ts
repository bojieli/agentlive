import type { RecordingState } from "@agentlive/playback";
import type { ActivityRow } from "./activity.js";
export interface ActivityMatch {
  key: string;
  index: number;
  excerpt: string;
}
export interface ActivitySearchPage {
  matches: ActivityMatch[];
  nextIndex: number | null;
}
function* fields(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (typeof value === "number" || typeof value === "boolean")
    yield String(value);
  else if (value instanceof Map) {
    for (const item of value.values()) yield* fields(item);
  } else if (Array.isArray(value)) {
    for (const item of value) yield* fields(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* fields(item);
  }
}
/** Literal search of one frozen presentation, independent of mounted DOM rows. */
export async function searchActivity(
  state: RecordingState,
  rows: readonly ActivityRow[],
  query: string,
  signal: AbortSignal,
  startIndex = 0,
): Promise<ActivitySearchPage> {
  if (!query.length || query.length > 256)
    throw new RangeError("Search requires 1–256 characters");
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    startIndex > rows.length
  )
    throw new RangeError("Invalid search continuation");
  const matches: ActivityMatch[] = [];
  let budget = 0;
  const checkpoint = async () => {
    signal.throwIfAborted();
    if (budget >= 65536) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      budget = 0;
      signal.throwIfAborted();
    }
  };
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]!;
    const value =
      row.kind === "gaps"
        ? state.gaps[Number(row.id)]
        : state[row.kind].get(row.id);
    let excerpt: string | undefined;
    for (const text of fields(value)) {
      budget += 1;
      await checkpoint();
      for (let offset = 0; offset < text.length; offset += 16384) {
        await checkpoint();
        const chunk = text.slice(offset, offset + 16384 + query.length - 1);
        const found = chunk.indexOf(query);
        budget += chunk.length;
        if (found >= 0) {
          const position = offset + found;
          let start = Math.max(0, position - 80);
          let end = Math.min(text.length, position + query.length + 120);
          const splitsPair = (boundary: number) =>
            boundary > 0 &&
            boundary < text.length &&
            text.charCodeAt(boundary - 1) >= 0xd800 &&
            text.charCodeAt(boundary - 1) <= 0xdbff &&
            text.charCodeAt(boundary) >= 0xdc00 &&
            text.charCodeAt(boundary) <= 0xdfff;
          if (splitsPair(start)) start--;
          if (splitsPair(end)) end++;
          excerpt = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
          break;
        }
      }
      if (excerpt !== undefined) break;
    }
    budget += 256;
    await checkpoint();
    if (excerpt === undefined) continue;
    if (matches.length === 50) return { matches, nextIndex: index };
    matches.push({ key: row.key, index, excerpt });
  }
  signal.throwIfAborted();
  return { matches, nextIndex: null };
}
