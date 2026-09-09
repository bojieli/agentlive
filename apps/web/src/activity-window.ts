import type { ActivityRow } from "./activity.js";
import type { PagedActivityView } from "./paged-activity.js";

/** Fetch only pages intersecting the mounted viewport (and its retained focused row). */
export async function loadActivityWindow(
  view: Pick<PagedActivityView, "rowCount" | "rows">,
  offsets: readonly number[],
  signal: AbortSignal,
): Promise<Map<number, ActivityRow>> {
  const selected = new Map<number, ActivityRow>();
  for (const offset of new Set(offsets)) {
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % 32 !== 0 ||
      offset >= view.rowCount
    )
      throw new RangeError("Invalid activity window offset");
    const page = await view.rows(offset, 32, signal);
    signal.throwIfAborted();
    if (page.length !== Math.min(32, view.rowCount - offset))
      throw new Error("Activity window contains a missing row range");
    page.forEach((row, index) => selected.set(offset + index, row));
  }
  signal.throwIfAborted();
  return selected;
}
