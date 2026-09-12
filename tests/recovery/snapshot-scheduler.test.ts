import { afterEach, expect, it, vi } from "vitest";
import { SnapshotScheduler } from "../../packages/server/src/snapshot-scheduler.js";
import type { RecordingSession } from "../../packages/server/src/session.js";
import type { SnapshotDescriptor } from "../../packages/protocol/src/index.js";
const descriptor = (serverSeq: number): SnapshotDescriptor => ({
  serverSeq,
  timelineMs: serverSeq,
  format: "agentlive.paged-state",
  ref: { hash: "a".repeat(64), byteSize: 1, units: 1 },
  activity: { hash: "b".repeat(64), byteSize: 1, units: 1 },
});
function session(
  sequence: number,
  build?: (through: number, signal: AbortSignal) => Promise<void>,
) {
  let saved: SnapshotDescriptor | null = null;
  const info = {
    serverSeq: sequence,
    lifecycle: "open",
  } as RecordingSession["info"];
  return {
    info,
    selectSnapshot: vi.fn(async () => saved),
    buildSnapshot: vi.fn(async (through: number, signal?: AbortSignal) => {
      await build?.(through, signal!);
      saved = descriptor(through);
      return saved;
    }),
  };
}
afterEach(() => vi.useRealTimers());
it("bounds batches, coalesces new receipt and rotates sessions behind one active build", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const entered: string[] = [];
  const a = session(8, async () => {
    entered.push("a");
    if (!release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const b = session(4, async () => {
    entered.push("b");
  });
  const scheduler = new SnapshotScheduler({
    batchEvents: 3,
    pollMs: 10,
    intervalMs: 100,
  });
  try {
    scheduler.add(a);
    scheduler.add(b);
    await vi.advanceTimersByTimeAsync(10);
    expect(scheduler.status.active).toBe(1);
    a.info.serverSeq = 10;
    await vi.advanceTimersByTimeAsync(500);
    expect(entered).toEqual(["a"]);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(entered).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(a.buildSnapshot.mock.calls.map(([through]) => through)).toEqual([
      3, 6, 9, 10,
    ]);
    expect(b.buildSnapshot.mock.calls.map(([through]) => through)).toEqual([
      3, 4,
    ]);
    expect(scheduler.status.failures).toBe(0);
  } finally {
    release?.();
    await scheduler.close();
  }
});
it("backs off failures, permits other sessions and drains cancellation before removal", async () => {
  vi.useFakeTimers();
  let fail = true;
  const broken = session(5, async () => {
    if (fail) throw new Error("private error body");
  });
  const healthy = session(5);
  const scheduler = new SnapshotScheduler({
    batchEvents: 5,
    pollMs: 10,
    intervalMs: 100,
  });
  try {
    scheduler.add(broken);
    scheduler.add(healthy);
    await vi.advanceTimersByTimeAsync(100);
    expect(broken.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(healthy.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.status.failures).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(broken.buildSnapshot).toHaveBeenCalledTimes(2);
    let cancelled = false;
    const stalled = session(
      5,
      async (_through, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    scheduler.add(stalled);
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.remove(stalled);
    expect(cancelled).toBe(true);
    expect(scheduler.status.active).toBe(0);
    expect(scheduler.status.failures).toBe(1);
  } finally {
    await scheduler.close();
  }
});
it("flushes ended tails promptly and cancels active work on shutdown", async () => {
  vi.useFakeTimers();
  const ended = session(2);
  ended.info.lifecycle = "ended";
  let aborted = false;
  const active = session(
    5,
    async (_through, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const scheduler = new SnapshotScheduler({ batchEvents: 5, pollMs: 10 });
  scheduler.add(ended);
  scheduler.add(active);
  await vi.advanceTimersByTimeAsync(20);
  expect(ended.buildSnapshot).toHaveBeenCalledTimes(1);
  await scheduler.close();
  expect(aborted).toBe(true);
  expect(scheduler.status).toEqual({
    registered: 0,
    active: 0,
    failures: 0,
    collecting: 0,
    collections: 0,
    collectionFailures: 0,
    reclaimedBytes: 0,
    lastCollectionMs: 0,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("reduces timed-out batches so retries can make durable progress", async () => {
  let first = true;
  const slow = session(4, async (_through, signal) => {
    if (!first) return;
    first = false;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const scheduler = new SnapshotScheduler({
    batchEvents: 4,
    pollMs: 5,
    intervalMs: 10,
    timeoutMs: 30,
  });
  try {
    scheduler.add(slow);
    await expect
      .poll(async () => (await slow.selectSnapshot())?.serverSeq, {
        timeout: 2000,
      })
      .toBe(4);
    expect(slow.buildSnapshot.mock.calls.map(([through]) => through)).toEqual([
      4, 2, 4,
    ]);
    expect(scheduler.status.failures).toBe(1);
  } finally {
    await scheduler.close();
  }
});

/** A registered session that also reports snapshot growth and can collect. */
function collecting(
  sequence: number,
  stored: { bytes: number },
  collect: (signal: AbortSignal) => Promise<void> = async () => {},
) {
  const base = session(sequence);
  return {
    info: base.info,
    selectSnapshot: base.selectSnapshot,
    buildSnapshot: base.buildSnapshot,
    get snapshotStoredBytes() {
      return stored.bytes;
    },
    collectSnapshots: vi.fn(async (signal?: AbortSignal) => {
      await collect(signal!);
      return {
        retainedRoots: 1,
        prunedDescriptors: 2,
        removedBlobs: 3,
        reclaimedBytes: 512,
        skipped: false,
      };
    }),
  };
}
it("collects on measured growth only, behind due builds, and never when disabled", async () => {
  vi.useFakeTimers();
  const stored = { bytes: 500 };
  const grown = collecting(0, stored);
  const scheduler = new SnapshotScheduler({
    batchEvents: 5,
    pollMs: 10,
    intervalMs: 100,
    collectGrowthBytes: 1000,
  });
  try {
    scheduler.add(grown);
    await vi.advanceTimersByTimeAsync(300);
    expect(grown.collectSnapshots).not.toHaveBeenCalled();
    stored.bytes = 1500;
    await vi.advanceTimersByTimeAsync(20);
    expect(grown.collectSnapshots).toHaveBeenCalledTimes(1);
    expect(scheduler.status.collections).toBe(1);
    expect(scheduler.status.reclaimedBytes).toBe(512);
    expect(scheduler.status.lastCollectionMs).toBeGreaterThanOrEqual(0);
    // The baseline moved to the measured usage, so elapsed time alone changes nothing.
    await vi.advanceTimersByTimeAsync(500);
    expect(grown.collectSnapshots).toHaveBeenCalledTimes(1);
    // More growth is due again only after the interval.
    stored.bytes = 2600;
    await vi.advanceTimersByTimeAsync(20);
    expect(grown.collectSnapshots).toHaveBeenCalledTimes(2);

    // A due build wins the worker; collection waits for the head to catch up.
    grown.info.serverSeq = 40;
    stored.bytes = 9000;
    await vi.advanceTimersByTimeAsync(20);
    expect(grown.buildSnapshot).toHaveBeenCalled();
    expect(grown.collectSnapshots).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(grown.collectSnapshots).toHaveBeenCalledTimes(3);
    expect(scheduler.status.collectionFailures).toBe(0);
  } finally {
    await scheduler.close();
  }
});
it("counts a failed or cancelled pass and retries it only after the interval", async () => {
  vi.useFakeTimers();
  const stored = { bytes: 0 };
  let fail = true;
  const broken = collecting(0, stored, async () => {
    if (fail) throw new Error("private collection failure");
  });
  const scheduler = new SnapshotScheduler({
    pollMs: 10,
    intervalMs: 100,
    collectGrowthBytes: 1000,
  });
  try {
    scheduler.add(broken);
    stored.bytes = 4000;
    await vi.advanceTimersByTimeAsync(120);
    expect(broken.collectSnapshots).toHaveBeenCalledTimes(1);
    expect(scheduler.status.collectionFailures).toBe(1);
    expect(scheduler.status.collections).toBe(0);
    expect(scheduler.status.reclaimedBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(broken.collectSnapshots).toHaveBeenCalledTimes(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(broken.collectSnapshots).toHaveBeenCalledTimes(2);
    expect(scheduler.status.collections).toBe(1);
    expect(scheduler.status.collectionFailures).toBe(1);
  } finally {
    await scheduler.close();
  }
});
it("never collects when the serve option disables it", async () => {
  vi.useFakeTimers();
  const stored = { bytes: 0 };
  const disabled = collecting(0, stored);
  const scheduler = new SnapshotScheduler({
    collect: false,
    pollMs: 10,
    intervalMs: 10,
    collectGrowthBytes: 1000,
  });
  try {
    scheduler.add(disabled);
    stored.bytes = 1_000_000;
    await vi.advanceTimersByTimeAsync(500);
    expect(disabled.collectSnapshots).not.toHaveBeenCalled();
    expect(scheduler.status.collections).toBe(0);
  } finally {
    await scheduler.close();
  }
});
