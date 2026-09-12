import { afterEach, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  PublisherJournal,
  PublisherNetwork,
  recoverPublisher,
  type CaptureInput,
  type JournalRetention,
} from "../../packages/publisher/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { backupServer } from "../../packages/server/src/backup.js";
import { restoreServer } from "../../packages/server/src/restore.js";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {});
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const secret = "a".repeat(64);
/** 6 records per 4 KiB segment, 6 acknowledged segments retained. */
const retention: JournalRetention = {
  segmentBytes: 4096,
  retainAcknowledgedBytes: 24576,
};
function capture(n: number): CaptureInput {
  return {
    sourceKey: `source_${n}`,
    observedAt: "2026-09-10T00:00:00.000Z",
    clockSegmentId: "clock_1",
    elapsedMs: n,
    fidelity: "delta",
    adapterState: { cursor: n },
    content: [
      {
        kind: "message.text.append",
        payload: { messageId: `m${n}`, text: `${n}:${"x".repeat(600)}` },
      },
    ],
  };
}

it("verifies a restored prefix whose local records were pruned, and rejects divergence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-recover-pruned-"));
  roots.push(root);
  const state = join(root, "state"),
    ownerFile = join(state, "owner.json"),
    signal = AbortSignal.timeout(60_000);
  let server = await startServer({
    directory: join(state, "server"),
    ownerSecret: secret,
    port: 0,
  });
  servers.push(server);
  const origin = server.url,
    port = Number(new URL(origin).port);
  await writeFile(ownerFile, JSON.stringify({ version: 1, secret }), {
    mode: 0o600,
  });
  const binding = {
    serverOrigin: origin,
    agent: "synthetic" as const,
    nativeSessionId: "pruned",
  };
  const publisherRoot = join(root, "publisher");
  const journal = await PublisherJournal.open(publisherRoot, binding, {
    retention,
  });
  const directory = journal.directory;
  const network = new PublisherNetwork({
    journal,
    ownerCredential: secret,
    title: "Pruned recovery",
    visibility: "private",
    retryMinMs: 5,
    retryMaxMs: 25,
  });
  const stop = new AbortController();
  const running = network.run(stop.signal).catch(() => {});
  /** Capture through `target` and wait for the server's durable acknowledgement. */
  const publishThrough = async (target: number) => {
    while (journal.capturedThrough < target)
      await journal.capture(capture(journal.capturedThrough + 1));
    await expect
      .poll(() => journal.identity.acknowledgedSeq, { timeout: 30_000 })
      .toBe(target);
  };
  const backups: Record<number, string> = {};
  const snapshot = async (through: number) => {
    await publishThrough(through);
    // backupServer reads a quiesced state directory.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    backups[through] = join(root, `backup-${through}`);
    await backupServer({
      directory: join(state, "server"),
      ownerFile,
      output: backups[through]!,
      signal,
    });
    server = await startServer({
      directory: join(state, "server"),
      ownerSecret: secret,
      port,
    });
    servers.push(server);
  };

  await snapshot(20);
  await snapshot(45);
  await publishThrough(60);
  const compacted = journal.compactedThrough;
  const compactedChain = journal.compactedChain;
  // The interesting window: pruning removed real records, and the 45-event
  // backup still reaches past the compaction boundary.
  expect(compacted).toBeGreaterThan(20);
  expect(compacted).toBeLessThan(45);
  const previousRevision = journal.identity.revision!;
  const streamId = journal.identity.streamId!;
  stop.abort();
  await running;
  await journal.close();
  await server.close();
  servers.splice(servers.indexOf(server), 1);

  /** A private copy of the binding so each case starts from the same journal. */
  let copies = 0;
  const copy = async () => {
    const to = join(root, `copy-${++copies}`, basename(directory));
    await cp(directory, to, { recursive: true });
    return to;
  };
  const restore = async (through: number) => {
    const output = join(root, `restored-${through}-${copies}`);
    await restoreServer({ source: backups[through]!, output, signal });
    const restored = await startServer({
      directory: join(output, "server"),
      ownerSecret: secret,
      port,
    });
    servers.push(restored);
    return restored;
  };

  // 1. A restored prefix that ends inside the pruned region cannot be verified.
  const shortPrefix = await copy();
  let restored = await restore(20);
  await expect(
    recoverPublisher({ directory: shortPrefix, signal }),
  ).rejects.toMatchObject({
    code: "sequence_gap",
    details: { compactedThrough: compacted, restoredThroughProducerSeq: 20 },
  });
  await restored.close();
  servers.splice(servers.indexOf(restored), 1);

  // 2. A prefix that matches the compacted chain and the retained records recovers.
  const good = await copy();
  restored = await restore(45);
  const before = await readFile(join(good, "binding.json"), "utf8");
  const result = await recoverPublisher({ directory: good, signal });
  expect(result).toMatchObject({
    streamId,
    previousRevision,
    previousAcknowledgedSeq: 60,
    acknowledgedSeq: 45,
    pendingEvents: 15,
    chainVerifiedThrough: compacted,
  });
  expect(result.revision).not.toBe(previousRevision);
  const recovered = await PublisherJournal.openExisting(good);
  try {
    expect(recovered.identity.acknowledgedSeq).toBe(45);
    expect(recovered.compactedThrough).toBe(compacted);
    expect(recovered.compactedChain).toBe(compactedChain);
    const suffix = [];
    for await (const event of recovered.pending()) suffix.push(event);
    expect(suffix.map((event) => event.producerSeq)).toEqual(
      Array.from({ length: 15 }, (_, index) => 46 + index),
    );
  } finally {
    await recovered.close();
  }

  // 3. A journal whose compacted chain does not cover the same history is
  //    rejected: pruning still detects divergence inside the pruned prefix.
  const tampered = await copy();
  const manifest = JSON.parse(
    await readFile(join(tampered, "journal.json"), "utf8"),
  );
  manifest.compacted.chain =
    (manifest.compacted.chain[0] === "a" ? "b" : "a") +
    manifest.compacted.chain.slice(1);
  await writeFile(join(tampered, "journal.json"), JSON.stringify(manifest));
  const tamperedBefore = await readFile(join(tampered, "binding.json"), "utf8");
  await expect(
    recoverPublisher({ directory: tampered, signal }),
  ).rejects.toMatchObject({ code: "event_conflict" });
  expect(await readFile(join(tampered, "binding.json"), "utf8")).toBe(
    tamperedBefore,
  );

  // 4. A journal whose pruned prefix captured different history is rejected:
  //    compaction still detects divergence inside the region it removed.
  await restored.close();
  servers.splice(servers.indexOf(restored), 1);
  const divergentRoot = join(root, "divergent");
  let divergent = await PublisherJournal.open(divergentRoot, binding, {
    retention,
  });
  const divergentDirectory = divergent.directory;
  await divergent.close();
  const real = JSON.parse(
    await readFile(join(directory, "binding.json"), "utf8"),
  );
  await writeFile(
    join(divergentDirectory, "binding.json"),
    JSON.stringify({ ...real, acknowledgedSeq: 0 }),
  );
  divergent = await PublisherJournal.open(divergentRoot, binding, {
    retention,
  });
  try {
    for (let n = 1; n <= 60; n++) {
      const original = capture(n);
      await divergent.capture({
        ...original,
        content: [
          {
            kind: "message.text.append",
            payload: { messageId: `m${n}`, text: `${n}:${"y".repeat(600)}` },
          },
        ],
      });
      await divergent.acknowledge(n);
    }
    // Identical record sizes put the compaction boundary in the same place, so
    // the only difference the restored prefix can expose is the hash chain.
    expect(divergent.compactedThrough).toBe(compacted);
    expect(divergent.compactedChain).not.toBe(compactedChain);
  } finally {
    await divergent.close();
  }
  restored = await restore(45);
  const divergentBefore = await readFile(
    join(divergentDirectory, "binding.json"),
    "utf8",
  );
  await expect(
    recoverPublisher({ directory: divergentDirectory, signal }),
  ).rejects.toMatchObject({ code: "event_conflict" });
  expect(await readFile(join(divergentDirectory, "binding.json"), "utf8")).toBe(
    divergentBefore,
  );
}, 120_000);
