import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RecordingStore } from "../../packages/server/src/store.js";
import { startServer } from "../../packages/server/src/http.js";
import { requestOnlineBackup } from "../../packages/client/src/backup.js";
import type {
  RecordingSession,
  Lease,
} from "../../packages/server/src/session.js";
import type { SnapshotScheduleOptions } from "../../packages/server/src/snapshot-scheduler.js";
import type { ContentPins } from "../../packages/storage/src/index.js";
import type {
  PublishedEvent,
  SnapshotDescriptor,
} from "../../packages/protocol/src/index.js";

const owner = "a".repeat(64);
const writeSecret = "b".repeat(64);
/** Manual control: no automatic build or collection unless a test asks for it. */
const manual: SnapshotScheduleOptions = {
  collect: false,
  pollMs: 60_000,
  intervalMs: 60_000,
  batchEvents: 1_000_000,
  timeoutMs: 60_000,
};
const directory = (name: string) =>
  mkdtemp(join(tmpdir(), `agentlive-${name}-`));
const cleanup = (root: string) => rm(root, { recursive: true, force: true });
function event(
  streamId: string,
  producerSeq: number,
  content: PublishedEvent["content"],
): PublishedEvent {
  return {
    protocolVersion: 1,
    streamId,
    producerEpoch: "e",
    producerSeq,
    observedAt: new Date().toISOString(),
    clockSegmentId: "clock",
    elapsedMs: producerSeq,
    fidelity: "delta",
    source: { agent: "synthetic", sessionId: "collection" },
    content,
  };
}
const produced = new Map<string, number>();
/** Append `count` sizeable message events so every generation stores real pages. */
async function write(session: RecordingSession, lease: Lease, count: number) {
  const id = session.info.id;
  let seq = produced.get(id) ?? 0;
  for (let index = 0; index < count; index += 10) {
    const batch: PublishedEvent[] = [];
    for (let step = 0; step < 10 && index + step < count; step++) {
      const next = ++seq;
      batch.push(
        event(
          id,
          next,
          next % 5 === 1
            ? {
                kind: "message.started",
                payload: {
                  messageId: `m${Math.ceil(next / 5)}`,
                  role: "assistant",
                },
              }
            : {
                kind: "message.text.append",
                payload: {
                  messageId: `m${Math.ceil(next / 5)}`,
                  text: `${next}:`.padEnd(2048, "x"),
                },
              },
        ),
      );
    }
    await session.append(lease, batch);
    produced.set(id, seq);
  }
}
async function recording(options: SnapshotScheduleOptions = manual) {
  const root = await directory("server-collection");
  const store = await RecordingStore.open(join(root, "server"), {
    snapshots: options,
  });
  const session = await store.create({
    ownerId: "local",
    requestId: "collection",
    requestedAt: new Date().toISOString(),
    publisherId: "p",
    producerEpoch: "e",
    writeSecret,
    visibility: "private",
    title: "Collection fixture",
  });
  const { lease } = await session.resume(writeSecret, {
    publisherId: "p",
    producerEpoch: "e",
    attempt: 1,
    revision: session.info.revision,
  });
  return { root, store, session, lease };
}
/** The in-process read/export pins of a recording's snapshot store. */
const pinsOf = (session: RecordingSession): ContentPins =>
  (session as unknown as { snapshots: { pins: ContentPins } }).snapshots.pins;
const manifest = (session: RecordingSession, descriptor: SnapshotDescriptor) =>
  session.readSnapshotContent(
    descriptor.ref,
    0,
    Math.min(descriptor.ref.units, 65536),
  );

it("reclaims superseded generations while the head, a live lease and a pinned read stay exactly readable", async () => {
  const { root, store, session } = await recording();
  try {
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 2,
      revision: session.info.revision,
    });
    const generations: SnapshotDescriptor[] = [];
    for (let step = 0; step < 5; step++) {
      await write(session, lease, 10);
      generations.push(await session.buildSnapshot(session.info.serverSeq));
    }
    const grown = session.snapshotStoredBytes;
    expect(grown).toBeGreaterThan(0);
    const head = generations[generations.length - 1]!;
    const leased = await session.selectSnapshotLeased(
      generations[1]!.serverSeq,
    );
    expect(leased?.snapshot.serverSeq).toBe(generations[1]!.serverSeq);
    const pinned = generations[2]!;
    const pin = pinsOf(session).pin([pinned.ref]);
    const before = {
      head: await manifest(session, head),
      leased: await session.readSnapshotContent(
        leased!.snapshot.ref,
        0,
        Math.min(leased!.snapshot.ref.units, 65536),
        undefined,
        leased!.token,
      ),
      activity: await session.readSnapshotContent(
        leased!.snapshot.activity!,
        0,
        Math.min(leased!.snapshot.activity!.units, 65536),
        undefined,
        leased!.token,
      ),
      pinned: await manifest(session, pinned),
    };

    const result = await session.collectSnapshots();
    expect(result.skipped).toBe(false);
    expect(result.retainedRoots).toBe(2);
    expect(result.prunedDescriptors).toBe(3);
    expect(result.removedBlobs).toBeGreaterThan(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    const shrunk = session.snapshotStoredBytes;
    expect(shrunk).toBe(grown - result.reclaimedBytes);
    expect(shrunk).toBeLessThan(grown);

    // The head still opens through selection, which verifies its paired boundary.
    expect(await session.selectSnapshot(head.serverSeq)).toEqual(head);
    expect(await manifest(session, head)).toBe(before.head);
    // A viewer holding a lease reads its snapshot byte for byte across the pass.
    expect(
      await session.readSnapshotContent(
        leased!.snapshot.ref,
        0,
        Math.min(leased!.snapshot.ref.units, 65536),
        undefined,
        leased!.token,
      ),
    ).toBe(before.leased);
    expect(
      await session.readSnapshotContent(
        leased!.snapshot.activity!,
        0,
        Math.min(leased!.snapshot.activity!.units, 65536),
        undefined,
        leased!.token,
      ),
    ).toBe(before.activity);
    // The pinned root survives even though its catalog descriptor was pruned.
    expect(await manifest(session, pinned)).toBe(before.pinned);
    expect(await session.selectSnapshot(pinned.serverSeq)).toEqual(
      generations[1]!,
    );

    pin.release();
    await session.releaseSnapshotLease(leased!.token);
    const second = await session.collectSnapshots();
    expect(second.retainedRoots).toBe(1);
    expect(second.prunedDescriptors).toBe(1);
    expect(second.reclaimedBytes).toBeGreaterThan(0);
    expect(session.snapshotStoredBytes).toBeLessThan(shrunk);
    await expect(manifest(session, pinned)).rejects.toThrow();
    await expect(manifest(session, generations[1]!)).rejects.toThrow();
    // The retained head is untouched by both passes.
    expect(await manifest(session, head)).toBe(before.head);
    expect(await session.selectSnapshot(head.serverSeq)).toEqual(head);

    store.release(session);
    await store.close();
    // A reopened store reads the retained head from disk.
    const reopened = await RecordingStore.open(join(store.directory), {
      snapshots: manual,
    });
    try {
      const again = await reopened.get(session.info.id);
      expect(await again.selectSnapshot(head.serverSeq)).toEqual(head);
      expect(await manifest(again, head)).toBe(before.head);
      reopened.release(again);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close().catch(() => {});
    await cleanup(root);
  }
}, 120_000);

it("shrinks a recording that accumulated many snapshot generations", async () => {
  const { root, store, session, lease } = await recording();
  try {
    const generations: SnapshotDescriptor[] = [];
    for (let step = 0; step < 12; step++) {
      await write(session, lease, 10);
      generations.push(await session.buildSnapshot(session.info.serverSeq));
    }
    const before = session.snapshotStoredBytes;
    const head = generations[generations.length - 1]!;
    const text = await manifest(session, head);
    const result = await session.collectSnapshots();
    expect(result.prunedDescriptors).toBe(generations.length - 1);
    // Most of an accumulated catalog's encoded content is superseded, not shared.
    expect(result.reclaimedBytes).toBeGreaterThan(before / 2);
    expect(session.snapshotStoredBytes).toBe(before - result.reclaimedBytes);
    expect(await manifest(session, head)).toBe(text);
    expect(await session.selectSnapshot(head.serverSeq)).toEqual(head);
  } finally {
    await store.close().catch(() => {});
    await cleanup(root);
  }
}, 120_000);

it("serializes a pass with concurrent publication and lease acquisition without losing either root", async () => {
  const { root, store, session } = await recording();
  try {
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 2,
      revision: session.info.revision,
    });
    const generations: SnapshotDescriptor[] = [];
    for (let step = 0; step < 4; step++) {
      await write(session, lease, 10);
      generations.push(await session.buildSnapshot(session.info.serverSeq));
    }
    await write(session, lease, 10);
    const target = session.info.serverSeq;
    const older = generations[0]!.serverSeq;

    // Publication, lease acquisition and collection are admitted in the same instant.
    const [built, acquired, collected] = await Promise.all([
      session.buildSnapshot(target),
      session.selectSnapshotLeased(older),
      session.collectSnapshots(),
    ]);
    expect(collected.skipped).toBe(false);
    expect(built.serverSeq).toBe(target);
    // The published root is retained: it is either the head the pass froze or newer.
    expect(await session.selectSnapshot(target)).toEqual(built);
    expect((await manifest(session, built)).length).toBeGreaterThan(0);
    // The acquired lease keeps its own root readable whichever order was chosen.
    expect(acquired).not.toBeNull();
    expect(
      await session.readSnapshotContent(
        acquired!.snapshot.ref,
        0,
        Math.min(acquired!.snapshot.ref.units, 65536),
        undefined,
        acquired!.token,
      ),
    ).toContain("appliedSeq");
    // A second pass now sees both roots and still keeps them.
    const second = await session.collectSnapshots();
    expect(second.skipped).toBe(false);
    expect(await session.selectSnapshot(target)).toEqual(built);
    expect(
      (
        await session.readSnapshotContent(
          acquired!.snapshot.ref,
          0,
          Math.min(acquired!.snapshot.ref.units, 65536),
          undefined,
          acquired!.token,
        )
      ).length,
    ).toBeGreaterThan(0);
  } finally {
    await store.close().catch(() => {});
    await cleanup(root);
  }
}, 120_000);

it("deletes nothing when a pass is cancelled or its trace fails", async () => {
  const { root, store, session } = await recording();
  try {
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 2,
      revision: session.info.revision,
    });
    const generations: SnapshotDescriptor[] = [];
    for (let step = 0; step < 3; step++) {
      await write(session, lease, 10);
      generations.push(await session.buildSnapshot(session.info.serverSeq));
    }
    const before = session.snapshotStoredBytes;
    const texts = [];
    for (const descriptor of generations)
      texts.push(await manifest(session, descriptor));

    await expect(
      session.collectSnapshots(AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect(session.snapshotStoredBytes).toBe(before);

    // A lease whose durable roots cannot be opened fails the pass before any sweep.
    const ledger = join(
      store.directory,
      "sessions",
      session.info.id,
      "snapshots",
      "leases.json",
    );
    await writeFile(
      ledger,
      JSON.stringify({
        version: 1,
        streamId: session.info.id,
        revision: session.info.revision,
        observedAt: Date.now(),
        leases: [
          {
            token: "c".repeat(64),
            expiresAt: Date.now() + 600_000,
            snapshot: {
              ...generations[0]!,
              ref: { ...generations[0]!.ref, hash: "d".repeat(64) },
            },
          },
        ],
      }),
    );
    await expect(session.collectSnapshots()).rejects.toThrow();
    expect(session.snapshotStoredBytes).toBe(before);
    for (const [index, descriptor] of generations.entries())
      expect(await manifest(session, descriptor)).toBe(texts[index]);
    expect(await session.selectSnapshot(generations[0]!.serverSeq)).toEqual(
      generations[0]!,
    );

    // With the broken lease gone the pass succeeds and reclaims the intermediates.
    await rm(ledger);
    const result = await session.collectSnapshots();
    expect(result.skipped).toBe(false);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(session.snapshotStoredBytes).toBeLessThan(before);
  } finally {
    await store.close().catch(() => {});
    await cleanup(root);
  }
}, 120_000);

it("never deadlocks with the exclusive write barrier of an online backup", async () => {
  const root = await directory("collection-backup");
  const server = await startServer({
    directory: join(root, "state", "server"),
    ownerSecret: owner,
    port: 0,
    snapshots: manual,
  });
  try {
    const store = server.store;
    const session = await store.create({
      ownerId: "local",
      requestId: "collection-backup",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret,
      visibility: "private",
      title: "Collection and backup",
    });
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 1,
      revision: session.info.revision,
    });
    for (let step = 0; step < 4; step++) {
      await write(session, lease, 10);
      await session.buildSnapshot(session.info.serverSeq);
    }
    const head = (await session.selectSnapshot(session.info.serverSeq))!;
    const text = await manifest(session, head);

    // A pass in flight yields the barrier instead of making the backup wait for it.
    const pass = session.collectSnapshots().then(
      () => "collected",
      (error: Error) => `refused: ${error.message}`,
    );
    const backup = await requestOnlineBackup({
      serverOrigin: server.url,
      credential: owner,
      output: join(root, "backup"),
      signal: AbortSignal.timeout(60_000),
    });
    expect(backup.files).toBeGreaterThan(0);
    expect(await pass).toMatch(/^(collected|refused: )/);
    // A pass requested while the barrier is pending is refused, not queued behind it.
    const during = store.barrier.exclusive(async () => {
      await expect(session.collectSnapshots()).rejects.toMatchObject({
        code: "retry_later",
      });
      return "exclusive";
    }, AbortSignal.timeout(30_000));
    expect(await during).toBe("exclusive");
    // Collection still works, and the head is intact.
    const after = await session.collectSnapshots();
    expect(after.skipped).toBe(false);
    expect(await manifest(session, head)).toBe(text);
    store.release(session);
  } finally {
    await server.close().catch(() => {});
    await cleanup(root);
  }
}, 120_000);

it("collects automatically on measured growth, and never when the serve option disables it", async () => {
  for (const collect of [false, true]) {
    const { root, store, session, lease } = await recording({
      collect,
      pollMs: 5,
      intervalMs: 5,
      batchEvents: 10,
      timeoutMs: 60_000,
      collectGrowthBytes: 1024,
      collectTimeoutMs: 60_000,
    });
    try {
      await write(session, lease, 60);
      const deadline = Date.now() + 60_000;
      let peak = 0;
      // Let the one scheduler worker build every generation of this recording.
      while (
        (await session.selectSnapshot(session.info.serverSeq))?.serverSeq !==
        session.info.serverSeq
      ) {
        if (Date.now() > deadline)
          throw new Error("Scheduled builds timed out");
        peak = Math.max(peak, session.snapshotStoredBytes);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      peak = Math.max(peak, session.snapshotStoredBytes);
      expect(peak).toBeGreaterThan(0);
      const head = (await session.selectSnapshot(session.info.serverSeq))!;
      const text = await manifest(session, head);
      if (!collect) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(store.snapshotStatus.collections).toBe(0);
        expect(store.snapshotStatus.reclaimedBytes).toBe(0);
        expect(session.snapshotStoredBytes).toBe(peak);
        expect(await manifest(session, head)).toBe(text);
        continue;
      }
      while (store.snapshotStatus.collections === 0) {
        if (Date.now() > deadline)
          throw new Error("Scheduled collection timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = store.snapshotStatus;
      expect(status.collectionFailures).toBe(0);
      expect(status.reclaimedBytes).toBeGreaterThan(0);
      expect(status.lastCollectionMs).toBeGreaterThanOrEqual(0);
      expect(session.snapshotStoredBytes).toBeLessThan(peak);
      // The current head remains exactly readable after automatic reclamation.
      expect(
        (await session.selectSnapshot(head.serverSeq))?.serverSeq,
      ).toBeGreaterThanOrEqual(head.serverSeq);
      expect(await manifest(session, head)).toBe(text);
    } finally {
      await store.close().catch(() => {});
      await cleanup(root);
    }
  }
}, 180_000);

it("leaves a reopenable store whose retained roots still read after SIGKILL during a sweep", async () => {
  const root = await directory("collection-kill");
  const server = join(root, "server");
  const { store, session } = await (async () => {
    const store = await RecordingStore.open(server, { snapshots: manual });
    const session = await store.create({
      ownerId: "local",
      requestId: "collection-kill",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret,
      visibility: "private",
      title: "Collection crash",
    });
    return { store, session };
  })();
  let id: string, headText: string, leaseToken: string;
  let head: SnapshotDescriptor, kept: SnapshotDescriptor, keptText: string;
  try {
    const { lease } = await session.resume(writeSecret, {
      publisherId: "p",
      producerEpoch: "e",
      attempt: 1,
      revision: session.info.revision,
    });
    id = session.info.id;
    const generations: SnapshotDescriptor[] = [];
    for (let step = 0; step < 5; step++) {
      await write(session, lease, 10);
      generations.push(await session.buildSnapshot(session.info.serverSeq));
    }
    head = generations[generations.length - 1]!;
    headText = await manifest(session, head);
    const leased = await session.selectSnapshotLeased(
      generations[1]!.serverSeq,
    );
    kept = leased!.snapshot;
    leaseToken = leased!.token;
    keptText = await manifest(session, kept);
    store.release(session);
  } finally {
    await store.close();
  }

  const script = join(root, "sweep-crash.mjs");
  await writeFile(
    script,
    `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const unlink = fs.unlink;
fs.unlink = async (path) => {
  const result = await unlink(path);
  process.stdout.write('swept\\n');
  await new Promise(() => {});
  return result;
};
syncBuiltinESMExports();
const { RecordingStore } = await import(${JSON.stringify(
      pathToFileURL(join(process.cwd(), "packages/server/dist/store.js")).href,
    )});
const store = await RecordingStore.open(${JSON.stringify(server)}, { snapshots: { collect: false, pollMs: 60000, intervalMs: 60000, batchEvents: 1000000 } });
const session = await store.get(${JSON.stringify(id!)});
await session.collectSnapshots();
process.stdout.write('finished\\n');
`,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child did not sweep: ${errors}`)),
        30_000,
      );
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("swept")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Early child exit: ${errors}`));
      });
    });
    child.kill("SIGKILL");
    expect((await exited)[1]).toBe("SIGKILL");
    // The catalog was pruned to the retained union before any file was removed.
    const catalog = JSON.parse(
      await readFile(
        join(server, "sessions", id!, "snapshots", "catalog.json"),
        "utf8",
      ),
    ) as { entries: SnapshotDescriptor[] };
    expect(catalog.entries.map((entry) => entry.serverSeq)).toEqual([
      kept!.serverSeq,
      head!.serverSeq,
    ]);
    const reopened = await RecordingStore.open(server, { snapshots: manual });
    try {
      const session = await reopened.get(id!);
      expect(await session.selectSnapshot(head!.serverSeq)).toEqual(head!);
      expect(await manifest(session, head!)).toBe(headText!);
      expect(
        await session.readSnapshotContent(
          kept!.ref,
          0,
          Math.min(kept!.ref.units, 65536),
          undefined,
          leaseToken!,
        ),
      ).toBe(keptText!);
      // Collection can retry after the abandoned attempt, and still keeps both roots.
      const retry = await session.collectSnapshots();
      expect(retry.skipped).toBe(false);
      expect(retry.retainedRoots).toBe(2);
      expect(await manifest(session, head!)).toBe(headText!);
      expect(await manifest(session, kept!)).toBe(keptText!);
      reopened.release(session);
    } finally {
      await reopened.close();
    }
  } finally {
    child.kill("SIGKILL");
    await cleanup(root);
  }
}, 120_000);
