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
