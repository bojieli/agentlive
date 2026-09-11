import type { BrowserCheckpoint } from "./content-store.js";
export const MAX_SEEK_CHECKPOINTS = 128;
/** Keep time/sequence landmarks; compact the densest interior interval when full. */
export function retainSeekCheckpoint(
  current: readonly BrowserCheckpoint[],
  next: BrowserCheckpoint,
  force = false,
): BrowserCheckpoint[] {
  const last = current.at(-1);
  if (
    !force &&
    last &&
    next.serverSeq - last.serverSeq < 1024 &&
    next.timelineMs - last.timelineMs < 10000
  )
    return [...current];
  const catalog = [
    ...current.filter((entry) => entry.serverSeq !== next.serverSeq),
    next,
  ].sort((a, b) => a.serverSeq - b.serverSeq);
  while (catalog.length > MAX_SEEK_CHECKPOINTS) {
    let remove = 1,
      span = Infinity;
    for (let index = 1; index < catalog.length - 1; index++) {
      if (catalog[index]!.serverSeq === next.serverSeq) continue;
      const width =
        catalog[index + 1]!.serverSeq - catalog[index - 1]!.serverSeq;
      if (width < span) {
        span = width;
        remove = index;
      }
    }
    catalog.splice(remove, 1);
  }
  return catalog;
}
/** Thin a catalog under storage pressure. A seek replays from the nearest
 * earlier landmark, so for uniformly chosen targets the mean replay distance is
 * proportional to the sum of squared gaps. Dropping a landmark between gaps a
 * and b adds 2ab to that sum; repeatedly drop the interior landmark with the
 * smallest a·b per unit of measured storage cost until the removed cost
 * reaches `excess`. Endpoints and landmarks with no positive measured cost are
 * kept. Costs share the unit of `excess`. */
export function thinSeekCheckpoints(
  current: readonly BrowserCheckpoint[],
  cost: (checkpoint: BrowserCheckpoint) => number | undefined,
  excess: number,
): BrowserCheckpoint[] {
  const catalog = [...current];
  for (let removed = 0; removed < excess;) {
    let remove = -1,
      score = Infinity,
      saved = 0;
    for (let index = 1; index < catalog.length - 1; index++) {
      const price = cost(catalog[index]!) ?? 0;
      if (!(price > 0)) continue;
      const loss =
        (catalog[index]!.serverSeq - catalog[index - 1]!.serverSeq) *
        (catalog[index + 1]!.serverSeq - catalog[index]!.serverSeq);
      if (loss / price < score) {
        score = loss / price;
        remove = index;
        saved = price;
      }
    }
    if (remove < 0) break;
    catalog.splice(remove, 1);
    removed += saved;
  }
  return catalog;
}
