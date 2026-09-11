import { it, expect } from "vitest";
import {
  retainSeekCheckpoint,
  thinSeekCheckpoints,
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
it("thins by seek coverage per measured cost and keeps endpoints and unmeasured landmarks", () => {
  // Widely spaced expensive history, then dense cheap recent landmarks.
  const entries = [
    ...Array.from({ length: 16 }, (_, index) =>
      checkpoint(index * 10000 + 1, 0),
    ),
    ...Array.from({ length: 48 }, (_, index) => checkpoint(160001 + index, 0)),
  ];
  const cost = (entry: BrowserCheckpoint) =>
    entry.serverSeq > 160000 ? 0.1 : 1;
  const light = thinSeekCheckpoints(entries, cost, 2);
  expect(light).toHaveLength(44);
  expect(light.slice(0, 16)).toEqual(entries.slice(0, 16));
  expect(light.at(-1)).toBe(entries.at(-1));
  const heavy = thinSeekCheckpoints(entries, cost, 8);
  // Removal stops as soon as the dropped measured cost covers the excess.
  const dropped = entries
    .filter((entry) => !heavy.includes(entry))
    .reduce((sum, entry) => sum + cost(entry), 0);
  expect(dropped).toBeGreaterThanOrEqual(8);
  expect(dropped).toBeLessThan(9);
  expect(heavy[0]).toBe(entries[0]);
  expect(heavy.at(-1)).toBe(entries.at(-1));
  const gaps = heavy
    .slice(1)
    .map((entry, index) => entry.serverSeq - heavy[index]!.serverSeq);
  // Coverage stays even: no two adjacent spread landmarks were dropped.
  expect(Math.max(...gaps)).toBeLessThanOrEqual(20047);
  const unmeasured = thinSeekCheckpoints(
    entries,
    (entry) => (entry.serverSeq % 20000 === 1 ? undefined : cost(entry)),
    1000,
  );
  expect(unmeasured.map((entry) => entry.serverSeq)).toEqual([
    1, 20001, 40001, 60001, 80001, 100001, 120001, 140001, 160001, 160048,
  ]);
  expect(thinSeekCheckpoints(entries, cost, 0)).toEqual(entries);
  expect(thinSeekCheckpoints([], cost, 1)).toEqual([]);
});
