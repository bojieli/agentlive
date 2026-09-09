import { it, expect } from "vitest";
import {
  retainSeekCheckpoint,
  MAX_SEEK_CHECKPOINTS,
} from "../../apps/web/src/checkpoint-catalog.js";
import type { BrowserCheckpoint } from "../../apps/web/src/content-store.js";
const checkpoint = (
  serverSeq: number,
  timelineMs: number,
): BrowserCheckpoint => ({
  format: "agentlive.paged-state",
  serverSeq,
  timelineMs,
  ref: { hash: "a".repeat(64), byteSize: 1, units: 1 },
  activity: { hash: "b".repeat(64), byteSize: 1, units: 1 },
});
it("bounds historical landmarks while preserving the first and latest selected boundary", () => {
  let entries: BrowserCheckpoint[] = [];
  for (let index = 1; index <= 10000; index++)
    entries = retainSeekCheckpoint(entries, checkpoint(index, index * 10000));
  expect(entries).toHaveLength(MAX_SEEK_CHECKPOINTS);
  expect(entries[0]!.serverSeq).toBe(1);
  expect(entries.at(-1)!.serverSeq).toBe(10000);
  expect(entries.map((entry) => entry.serverSeq)).toEqual(
    entries.map((entry) => entry.serverSeq).sort((a, b) => a - b),
  );
  // Old landmarks survive; trimming does not simply retain the final 128 events.
  expect(
    entries.filter((entry) => entry.serverSeq < 5000).length,
  ).toBeGreaterThan(10);
});
it("schedules landmarks by either sequence distance or elapsed timeline", () => {
  const first = checkpoint(1, 0);
  expect(retainSeekCheckpoint([first], checkpoint(1024, 9999))).toEqual([
    first,
  ]);
  expect(retainSeekCheckpoint([first], checkpoint(1025, 0))).toHaveLength(2);
  expect(retainSeekCheckpoint([first], checkpoint(2, 10000))).toHaveLength(2);
});
it("keeps a newly requested older seek point when compacting a full catalog", () => {
  let entries: BrowserCheckpoint[] = [];
  for (let index = 1; index <= 128; index++)
    entries = retainSeekCheckpoint(
      entries,
      checkpoint(index * 10000, index * 10000),
    );
  const selected = checkpoint(45000, 45000);
  const retained = retainSeekCheckpoint(entries, selected, true);
  expect(retained).toHaveLength(128);
  expect(retained).toContain(selected);
  expect(retained[0]).toEqual(entries[0]);
  expect(retained.at(-1)).toEqual(entries.at(-1));
  expect(new Set(retained.map((entry) => entry.serverSeq)).size).toBe(128);
});
