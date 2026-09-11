import { expect, it, vi } from "vitest";
import { MemorySnapshotRetention } from "../../apps/web/src/memory-retention.js";
import {
  ProtocolError,
  type SnapshotLease,
} from "../../packages/protocol/src/index.js";
const signal = () => AbortSignal.timeout(10000);
const ref = { hash: "a".repeat(64), byteSize: 10, units: 1 };
const lease = (token: string, sequence = 1): SnapshotLease => ({
  token: token.repeat(64),
  expiresAt: 100000,
  snapshot: {
    format: "agentlive.paged-state",
    serverSeq: sequence,
    timelineMs: sequence,
    ref,
    activity: ref,
  },
});
function client() {
  return {
    acquireLease: vi.fn(async () => lease("b")),
    renewLease: vi.fn(async (current: SnapshotLease) => ({
      ...current,
      expiresAt: current.expiresAt + 1000,
    })),
    releaseLease: vi.fn(async (_lease: SnapshotLease) => {}),
    readBlob: vi.fn(async () => new Uint8Array(10)),
  };
}
it("retains a visit import union, deduplicates roots and releases on close", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  try {
    await expect(retention.readBlob(ref, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    await retention.select(1, signal());
    api.acquireLease.mockResolvedValueOnce(lease("c"));
    await retention.select(1, signal());
    expect(api.releaseLease).toHaveBeenCalledWith(
      lease("c"),
      expect.any(AbortSignal),
    );
    api.acquireLease.mockResolvedValueOnce(lease("d", 2));
    await retention.select(2, signal());
    await expect(retention.readBlob(ref, signal())).resolves.toHaveLength(10);
    expect(api.renewLease).toHaveBeenCalledTimes(2);
    await retention.close();
    const released = api.releaseLease.mock.calls.map(([item]) => item.token);
    expect(released.sort()).toEqual(
      ["b", "c", "d"].map((value) => value.repeat(64)),
    );
    await expect(retention.select(2, signal())).rejects.toThrow("closing");
    await retention.close();
    expect(api.releaseLease).toHaveBeenCalledTimes(3);
  } finally {
    await retention.close();
  }
});
it("releases a failed acquisition and does not permit remote reads without provenance", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  api.renewLease.mockRejectedValueOnce(
    new ProtocolError("forbidden", "denied"),
  );
  try {
    await expect(retention.select(1, signal())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(api.releaseLease).toHaveBeenCalledTimes(1);
    await expect(retention.readBlob(ref, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect(api.readBlob).not.toHaveBeenCalled();
    await retention.select(1, signal());
  } finally {
    await retention.close();
  }
});
it("bounds admissions and releases an acquisition returned after close", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  let resolve!: (value: SnapshotLease) => void, entered!: () => void;
  const gate = new Promise<SnapshotLease>((done) => {
    resolve = done;
  });
  const started = new Promise<void>((done) => {
    entered = done;
  });
  api.acquireLease.mockImplementationOnce(async () => {
    entered();
    return gate;
  });
  const pending = retention.select(1, signal());
  const work = Array.from({ length: 15 }, () => retention.select(1, signal()));
  const settled = Promise.allSettled([pending, ...work]);
  await started;
  await expect(retention.select(1, signal())).rejects.toMatchObject({
    code: "retry_later",
  });
  await retention.close();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
  resolve(lease("b"));
  await expect.poll(() => api.releaseLease.mock.calls.length).toBe(1);
  expect(api.renewLease).not.toHaveBeenCalled();
});
it("keeps retained roots when the server reuses their token inconsistently", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  try {
    await retention.select(1, signal());
    api.acquireLease.mockResolvedValueOnce(lease("b", 2));
    await expect(retention.select(2, signal())).rejects.toMatchObject({
      code: "event_conflict",
    });
    expect(api.releaseLease).not.toHaveBeenCalled();
    expect(await retention.readBlob(ref, signal())).toHaveLength(10);
  } finally {
    await retention.close();
  }
});

it("requires the full import union to renew before transferring a remote blob", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  try {
    await retention.select(1, signal());
    api.acquireLease.mockResolvedValueOnce(lease("c", 2));
    await retention.select(2, signal());
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now + 61000);
    api.renewLease.mockImplementation(async (current) => {
      if (current.token === "c".repeat(64))
        throw new ProtocolError("stale_lease", "expired import");
      return { ...current, expiresAt: current.expiresAt + 1000 };
    });
    try {
      await expect(retention.readBlob(ref, signal())).rejects.toMatchObject({
        code: "stale_lease",
      });
      expect(api.readBlob).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  } finally {
    await retention.close();
  }
});

it("falls back to history at the import cap without evicting derivative roots", async () => {
  const api = client(),
    retention = new MemorySnapshotRetention(api);
  let count = 0;
  api.acquireLease.mockImplementation(async () => {
    const next = lease("b", ++count);
    next.token = count.toString(16).padStart(64, "0");
    return next;
  });
  try {
    for (let sequence = 1; sequence <= 128; sequence++)
      await retention.select(sequence, signal());
    expect(await retention.select(129, signal())).toBeNull();
    expect(api.acquireLease).toHaveBeenCalledTimes(128);
    expect(api.releaseLease).not.toHaveBeenCalled();
    await retention.close();
    expect(api.releaseLease).toHaveBeenCalledTimes(128);
  } finally {
    await retention.close();
  }
});
