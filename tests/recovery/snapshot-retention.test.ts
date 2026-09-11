import { it, expect, vi } from "vitest";
import { SnapshotRetention } from "../../packages/client/src/snapshot-retention.js";
const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
const lease = {
  token: "b".repeat(64),
  expiresAt: 100000,
  snapshot: {
    format: "agentlive.paged-state" as const,
    serverSeq: 1,
    timelineMs: 0,
    ref,
    activity: ref,
  },
};
it("renews and persists before reads, renews in the background, and releases after close", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  const client = {
    renewLease: vi.fn(async () => {
      order.push("renew");
      return { ...lease, expiresAt: 200000 };
    }),
    readBlob: vi.fn(async () => {
      order.push("read");
      return new Uint8Array(10);
    }),
    releaseLease: vi.fn(async () => {
      order.push("release");
    }),
  };
  let retention: SnapshotRetention | undefined;
  try {
    retention = await SnapshotRetention.open(
      client,
      lease,
      async (saved) => {
        order.push("persist");
        saved.token = "c".repeat(64);
      },
      new AbortController().signal,
    );
    await retention.readBlob(ref, new AbortController().signal);
    expect(order).toEqual(["renew", "persist", "read"]);
    expect(client.readBlob.mock.calls[0]).toHaveLength(3);
    expect(retention.provenance.token).toBe(lease.token);
    await vi.advanceTimersByTimeAsync(60000);
    expect(order.slice(-2)).toEqual(["renew", "persist"]);
    await retention.release(new AbortController().signal);
    await expect(
      retention.readBlob(ref, new AbortController().signal),
    ).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(120000);
    expect(client.renewLease).toHaveBeenCalledTimes(2);
  } finally {
    retention?.close();
    vi.useRealTimers();
  }
});
it("stops remote reads if renewal or provenance persistence fails", async () => {
  vi.useFakeTimers();
  const stale = new Error("expired");
  const client = {
    renewLease: vi.fn(async () => lease),
    readBlob: vi.fn(async () => new Uint8Array()),
    releaseLease: vi.fn(async () => {}),
  };
  let retention: SnapshotRetention | undefined;
  try {
    retention = await SnapshotRetention.open(
      client,
      lease,
      async () => {},
      new AbortController().signal,
    );
    client.renewLease.mockRejectedValueOnce(stale);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(
      retention.readBlob(ref, new AbortController().signal),
    ).rejects.toThrow("expired");
    expect(client.readBlob).not.toHaveBeenCalled();
    await expect(
      SnapshotRetention.open(
        client,
        lease,
        async () => {
          throw new Error("disk full");
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("disk full");
  } finally {
    retention?.close();
    vi.useRealTimers();
  }
});

it("cancels stalled opening persistence and observes late completion without publishing it", async () => {
  const stop = new AbortController();
  let finish!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let savedSignal!: AbortSignal;
  const client = {
    renewLease: vi.fn(async () => lease),
    readBlob: vi.fn(async () => new Uint8Array()),
    releaseLease: vi.fn(async () => {}),
  };
  const opening = SnapshotRetention.open(
    client,
    lease,
    async (_lease, signal) => {
      savedSignal = signal;
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    stop.signal,
  );
  const rejected = expect(opening).rejects.toThrow("closed");
  await ready;
  stop.abort();
  await rejected;
  expect(savedSignal.aborted).toBe(true);
  finish();
  await Promise.resolve();
  expect(client.readBlob).not.toHaveBeenCalled();
});
it("times out ignored renewal cancellation and releases without waiting for a stalled persistence callback", async () => {
  vi.useFakeTimers();
  let retention: SnapshotRetention | undefined;
  const client = {
    renewLease: vi.fn(async () => lease),
    readBlob: vi.fn(async () => new Uint8Array()),
    releaseLease: vi.fn(async () => {}),
  };
  try {
    client.renewLease.mockImplementationOnce(() => new Promise(() => {}));
    const timed = expect(
      SnapshotRetention.open(
        client,
        lease,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "retry_later" });
    await vi.advanceTimersByTimeAsync(30000);
    await timed;
    let persistCount = 0,
      stalledSignal!: AbortSignal;
    retention = await SnapshotRetention.open(
      client,
      lease,
      async (_lease, signal) => {
        if (++persistCount > 1) {
          stalledSignal = signal;
          await new Promise(() => {});
        }
      },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(60000);
    await retention.release(new AbortController().signal);
    expect(stalledSignal.aborted).toBe(true);
    expect(client.releaseLease).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    retention?.close();
    vi.useRealTimers();
  }
});

it("retries a transient background renewal on the next read but never retries uncertain persistence", async () => {
  vi.useFakeTimers();
  const client = {
    renewLease: vi.fn(async () => lease),
    readBlob: vi.fn(async () => new Uint8Array([7])),
    releaseLease: vi.fn(async () => {}),
  };
  const persist = vi.fn(async () => {});
  let retention: SnapshotRetention | undefined;
  try {
    retention = await SnapshotRetention.open(
      client,
      lease,
      persist,
      new AbortController().signal,
    );
    client.renewLease.mockRejectedValueOnce(new TypeError("network offline"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.readBlob).not.toHaveBeenCalled();
    expect(await retention.readBlob(ref, new AbortController().signal)).toEqual(
      new Uint8Array([7]),
    );
    expect(client.renewLease).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledTimes(2);
    persist.mockRejectedValueOnce(new TypeError("uncertain persistence"));
    await vi.advanceTimersByTimeAsync(60000);
    const count = client.renewLease.mock.calls.length;
    await expect(
      retention.readBlob(ref, new AbortController().signal),
    ).rejects.toThrow("uncertain persistence");
    await vi.advanceTimersByTimeAsync(120000);
    expect(client.renewLease).toHaveBeenCalledTimes(count);
    expect(client.readBlob).toHaveBeenCalledTimes(1);
  } finally {
    retention?.close();
    vi.useRealTimers();
  }
});
