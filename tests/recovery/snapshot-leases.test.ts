import { TextStore } from "../../packages/storage/dist/index.js";
import { it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotLeases } from "../../packages/server/src/snapshot-leases.js";
import { RecordingSnapshots } from "../../packages/server/src/snapshots.js";
import type { SnapshotDescriptor } from "../../packages/protocol/src/index.js";
const binding = { streamId: "stream", revision: "revision" };
const snapshot: SnapshotDescriptor = {
  format: "agentlive.paged-state",
  serverSeq: 1,
  timelineMs: 0,
  ref: { hash: "a".repeat(64), byteSize: 10, units: 1 },
  activity: { hash: "b".repeat(64), byteSize: 10, units: 1 },
};
it("durably retains copied paired roots, bounds admission, renews and releases across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlive-leases-"));
  let now = 100;
  try {
    let leases = new SnapshotLeases(dir, binding, () => now, 1, 100);
    const input = structuredClone(snapshot);
    const first = await leases.acquire(input);
    input.ref.hash = "c".repeat(64);
    first.snapshot.ref.hash = "d".repeat(64);
    await expect(leases.acquire(snapshot)).rejects.toMatchObject({
      code: "retry_later",
    });
    leases = new SnapshotLeases(dir, binding, () => now, 1, 100);
    expect((await leases.retained())[0]!.snapshot).toEqual(snapshot);
    now = 150;
    expect((await leases.renew(first.token)).expiresAt).toBe(250);
    now = 249;
    expect(await leases.retained()).toHaveLength(1);
    await leases.release(first.token);
    await leases.release(first.token);
    expect(await leases.retained()).toEqual([]);
    await expect(leases.renew(first.token)).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect((await leases.acquire(snapshot)).token).not.toBe(first.token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("expires at the exact boundary and cannot resurrect swept roots after a clock rollback and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlive-lease-clock-"));
  let now = 100;
  try {
    let leases = new SnapshotLeases(dir, binding, () => now, 1, 100);
    const first = await leases.acquire(snapshot);
    expect((await leases.validate(first.token)).token).toBe(first.token);
    now = 200;
    await expect(leases.validate(first.token)).rejects.toMatchObject({
      code: "stale_lease",
    });
    await expect(leases.renew(first.token)).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect(await leases.retained()).toEqual([]);
    now = 50;
    leases = new SnapshotLeases(dir, binding, () => now, 1, 100);
    await expect(leases.renew(first.token)).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect((await leases.acquire(snapshot)).expiresAt).toBe(300);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects corrupt or differently bound ledgers and cancelled mutations without losing existing roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlive-lease-corrupt-"));
  try {
    const leases = new SnapshotLeases(dir, binding);
    const first = await leases.acquire(snapshot);
    const path = join(dir, "leases.json"),
      saved = await readFile(path);
    const aborted = AbortSignal.abort(new Error("cancelled"));
    await expect(leases.release(first.token, aborted)).rejects.toThrow(
      "cancelled",
    );
    await expect(leases.renew(first.token, aborted)).rejects.toThrow(
      "cancelled",
    );
    await expect(leases.acquire(snapshot, aborted)).rejects.toThrow(
      "cancelled",
    );
    expect(await readFile(path)).toEqual(saved);
    await expect(
      new SnapshotLeases(dir, { ...binding, revision: "changed" }).retained(),
    ).rejects.toMatchObject({ code: "revision_changed" });
    const ledger = JSON.parse(saved.toString());
    ledger.leases.push(ledger.leases[0]);
    await writeFile(path, JSON.stringify(ledger));
    await expect(leases.retained()).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await writeFile(path, "broken");
    await expect(leases.acquire(snapshot)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("serializes durable selection behind publication and renews the selected roots after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlive-leased-selection-"));
  let snapshots = new RecordingSnapshots(dir, binding);
  try {
    const building = snapshots.build(0, async function* () {});
    const selecting = snapshots.selectLeased(0);
    const built = await building,
      lease = await selecting;
    expect(lease!.snapshot).toEqual(built);
    await snapshots.close();
    snapshots = new RecordingSnapshots(dir, binding);
    expect((await snapshots.renewLease(lease!.token)).snapshot).toEqual(built);
    await snapshots.releaseLease(lease!.token);
    await expect(snapshots.renewLease(lease!.token)).rejects.toMatchObject({
      code: "stale_lease",
    });
  } finally {
    await snapshots.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("holds lease release behind an accepted blob read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlive-lease-read-race-"));
  const snapshots = new RecordingSnapshots(dir, binding);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await snapshots.build(0, async function* () {});
    const lease = (await snapshots.selectLeased(0))!;
    const original = TextStore.prototype.readBlob;
    spy = vi
      .spyOn(TextStore.prototype, "readBlob")
      .mockImplementation(async function (this: TextStore, ref, signal) {
        entered();
        await gate;
        return original.call(this, ref, signal);
      });
    const reading = snapshots.readBlob(
      lease.snapshot.ref,
      undefined,
      lease.token,
    );
    await ready;
    let released = false;
    const releasing = snapshots.releaseLease(lease.token).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);
    resume();
    expect((await reading).length).toBe(lease.snapshot.ref.byteSize);
    await releasing;
    await expect(
      snapshots.readBlob(lease.snapshot.ref, undefined, lease.token),
    ).rejects.toMatchObject({ code: "stale_lease" });
  } finally {
    resume?.();
    spy?.mockRestore();
    await snapshots.close();
    await rm(dir, { recursive: true, force: true });
  }
});
