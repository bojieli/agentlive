import { afterEach, expect, it } from "vitest";
import { fork } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  LIVE_JOURNAL_RETENTION,
  PublisherJournal,
  publisherJournalBytes,
  type CaptureInput,
  type JournalRetention,
} from "../../packages/publisher/src/index.js";

const roots: string[] = [];
const open: PublisherJournal[] = [];
afterEach(async () => {
  for (const journal of open.splice(0)) await journal.close().catch(() => {});
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "agentlive-journal-segments-"));
  roots.push(path);
  return path;
}
const identity = {
  serverOrigin: "https://example.test",
  agent: "synthetic" as const,
  nativeSessionId: "native_1",
};
/** ~1 KiB of payload per record so byte budgets are reached in a few hundred records. */
function capture(n: number, text = "x".repeat(1024)): CaptureInput {
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
        payload: { messageId: `m${n}`, text: `${n}:${text}` },
      },
    ],
  };
}
const small: JournalRetention = {
  segmentBytes: 4096,
  retainAcknowledgedBytes: 8192,
};
async function opened(
  path: string,
  retention: JournalRetention | null = small,
  extra: Record<string, unknown> = {},
) {
  const journal = await PublisherJournal.open(path, identity, {
    ...(retention ? { retention } : {}),
    ...extra,
  });
  open.push(journal);
  return journal;
}
const files = async (directory: string) => (await readdir(directory)).sort();
const manifestOf = async (directory: string) =>
  JSON.parse(await readFile(join(directory, "journal.json"), "utf8"));

const captureBytes = async (directory: string) =>
  (
    await Promise.all(
      (await files(directory))
        .filter((name) => /^capture(-\d+)?\.jsonl$/.test(name))
        .map((name) => stat(join(directory, name))),
    )
  ).reduce((total, info) => total + info.size, 0);

it(
  "bounds disk usage across a long acknowledged capture and keeps sequences continuous",
  { timeout: 60_000 },
  async () => {
    const path = await root();
    const journal = await opened(path);
    await journal.bindRemote("stream_1", "revision_1");
    const samples = new Map<number, { total: number; records: number }>();
    for (let n = 1; n <= 180; n++) {
      await journal.capture(capture(n));
      await journal.acknowledge(journal.capturedThrough);
      if (n === 60 || n === 180)
        samples.set(n, {
          total: await publisherJournalBytes(journal.directory),
          records: await captureBytes(journal.directory),
        });
    }
    expect(journal.capturedThrough).toBe(180);
    expect(journal.compactedThrough).toBeGreaterThan(0);
    const early = samples.get(60)!,
      late = samples.get(180)!;
    // Tripling the captured history must not grow the journal proportionally:
    // retained capture records stay inside the configured budget, and the fixed
    // index/bloom overhead does not accumulate either.
    const budget = small.segmentBytes + small.retainAcknowledgedBytes;
    expect(late.records).toBeLessThanOrEqual(budget + small.segmentBytes);
    expect(late.records).toBeLessThan(180 * 1024);
    expect(late.total - early.total).toBeLessThan(budget);
    // Every retained segment is a contiguous continuation of the compacted prefix.
    const manifest = await manifestOf(journal.directory);
    expect(manifest.version).toBe(2);
    expect(manifest.segments[0].firstSeq).toBe(
      manifest.compacted.throughSeq + 1,
    );
    expect(manifest.compacted.adapterState).toEqual({
      cursor: manifest.compacted.throughSeq,
    });
    // The whole retained suffix still replays contiguously to the captured head.
    const suffix: number[] = [];
    for await (const event of journal.pending(journal.compactedThrough))
      suffix.push(event.producerSeq);
    expect(suffix).toEqual(
      Array.from(
        { length: 180 - journal.compactedThrough },
        (_, index) => journal.compactedThrough + 1 + index,
      ),
    );
  },
);

it(
  "preserves sequence, epoch and checkpoint continuity across a restart after pruning",
  { timeout: 60_000 },
  async () => {
    const path = await root();
    let journal = await opened(path);
    await journal.bindRemote("stream_1", "revision_1");
    const epoch = journal.identity.producerEpoch;
    for (let n = 1; n <= 120; n++) {
      await journal.capture(capture(n));
      if (n % 10 === 0) await journal.acknowledge(journal.capturedThrough - 5);
    }
    const compacted = journal.compactedThrough;
    const chain = journal.compactedChain;
    expect(compacted).toBeGreaterThan(0);
    await journal.close();
    open.length = 0;

    journal = await opened(path);
    expect(journal.identity.producerEpoch).toBe(epoch);
    expect(journal.capturedThrough).toBe(120);
    expect(journal.compactedThrough).toBe(compacted);
    expect(journal.compactedChain).toBe(chain);
    expect(journal.checkpoint).toEqual({ cursor: 120 });
    const next = await journal.capture(capture(121));
    expect(next.map((event) => event.producerSeq)).toEqual([121]);
    expect(next[0]!.producerEpoch).toBe(epoch);
    expect(next[0]!.streamId).toBe("stream_1");
  },
);

it(
  "deduplicates replayed source keys from retained, sealed and compacted history",
  { timeout: 60_000 },
  async () => {
    const path = await root();
    let journal = await opened(path);
    await journal.bindRemote("stream_1", "revision_1");
    const seen = new Map<number, number>();
    for (let n = 1; n <= 130; n++) {
      const events = await journal.capture(capture(n));
      seen.set(n, events[0]!.producerSeq);
      await journal.acknowledge(journal.capturedThrough - 1);
    }
    await journal.close();
    open.length = 0;
    journal = await opened(path);
    const compacted = journal.compactedThrough;
    expect(compacted).toBeGreaterThan(10);

    // A replay of a pruned source key is recognised without recapturing it.
    const prunedKey = 1;
    expect(seen.get(prunedKey)! <= compacted).toBe(true);
    const before = journal.capturedThrough;
    expect(await journal.capture(capture(prunedKey))).toEqual([]);
    expect(journal.capturedThrough).toBe(before);
    // A replay of a retained source key returns its original bound events.
    const retained = 130;
    const replayed = await journal.capture(capture(retained));
    expect(replayed.map((event) => event.producerSeq)).toEqual([
      seen.get(retained)!,
    ]);
    expect(replayed[0]!.streamId).toBe("stream_1");
    expect(journal.capturedThrough).toBe(before);
    // Changed content under a known source key is a conflict in both regions.
    for (const key of [prunedKey, retained])
      await expect(
        journal.capture(capture(key, "different payload")),
      ).rejects.toMatchObject({ code: "event_conflict" });
    // A genuinely new source key still captures.
    expect((await journal.capture(capture(1000)))[0]!.producerSeq).toBe(
      before + 1,
    );
  },
);

it(
  "refuses to replay history that pruning removed and keeps the retained suffix readable",
  { timeout: 60_000 },
  async () => {
    const path = await root();
    const journal = await opened(path);
    await journal.bindRemote("stream_1", "revision_1");
    for (let n = 1; n <= 110; n++) {
      await journal.capture(capture(n));
      if (journal.capturedThrough > 2)
        await journal.acknowledge(journal.capturedThrough - 2);
    }
    const compacted = journal.compactedThrough;
    expect(compacted).toBeGreaterThan(0);
    await expect(async () => {
      for await (const _ of journal.pending(0)) break;
    }).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(async () => {
      for await (const _ of journal.pending(compacted - 1)) break;
    }).rejects.toMatchObject({ code: "cursor_invalid" });
    const suffix: number[] = [];
    for await (const event of journal.pending(compacted))
      suffix.push(event.producerSeq);
    expect(suffix[0]).toBe(compacted + 1);
    expect(suffix.at(-1)).toBe(110);
    expect(suffix).toEqual(suffix.map((_, index) => compacted + 1 + index));
  },
);

it("opens an existing single-file journal unchanged and migrates it only when it rotates", async () => {
  const path = await root();
  // A journal written by the previous format: one capture.jsonl, no manifest.
  let journal = await opened(path, null);
  await journal.bindRemote("stream_1", "revision_1");
  for (let n = 1; n <= 6; n++) await journal.capture(capture(n));
  await journal.close();
  open.length = 0;
  const legacy = await files(journal.directory);
  expect(legacy).toContain("capture.jsonl");
  expect(legacy).not.toContain("journal.json");

  // Reopening with retention neither rewrites nor re-keys the existing file.
  const bytes = (await stat(join(journal.directory, "capture.jsonl"))).size;
  journal = await opened(path);
  expect(journal.capturedThrough).toBe(6);
  expect(journal.checkpoint).toEqual({ cursor: 6 });
  expect(await files(journal.directory)).toEqual(legacy);
  expect((await stat(join(journal.directory, "capture.jsonl"))).size).toBe(
    bytes,
  );
  // The first record that would exceed the segment budget migrates the format.
  for (let n = 7; n <= 20; n++) await journal.capture(capture(n));
  const migrated = await files(journal.directory);
  expect(migrated).toContain("journal.json");
  expect(migrated).toContain("capture-1.jsonl");
  expect((await manifestOf(journal.directory)).segments[0]).toMatchObject({
    id: 0,
    firstSeq: 1,
  });
  const replayed: number[] = [];
  for await (const event of journal.pending(0))
    replayed.push(event.producerSeq);
  expect(replayed).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
});

it(
  "rejects a corrupt manifest, a discontinuous manifest and a truncated index",
  { timeout: 60_000 },
  async () => {
    const path = await root();
    const journal = await opened(path);
    await journal.bindRemote("stream_1", "revision_1");
    for (let n = 1; n <= 40; n++) await journal.capture(capture(n));
    const directory = journal.directory;
    expect(await files(directory)).toContain("journal.json");
    await journal.close();
    open.length = 0;
    const good = await readFile(join(directory, "journal.json"), "utf8");
    const manifest = JSON.parse(good);
    const sealedKeys = join(
      directory,
      `capture-${manifest.segments[0].id}.keys`,
    );
    const keys = await readFile(sealedKeys);

    const reject = async () => {
      await expect(
        PublisherJournal.open(path, identity, { retention: small }),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
    };
    await writeFile(join(directory, "journal.json"), "{not json");
    await reject();
    await writeFile(
      join(directory, "journal.json"),
      JSON.stringify({ ...manifest, version: 3 }),
    );
    await reject();
    // A segment list that no longer covers the compacted boundary continuously.
    await writeFile(
      join(directory, "journal.json"),
      JSON.stringify({
        ...manifest,
        segments: manifest.segments.map((segment: { firstSeq: number }) => ({
          ...segment,
          firstSeq: segment.firstSeq + 1,
        })),
      }),
    );
    await reject();
    // A sealed segment whose declared byte boundary no longer matches the file.
    await writeFile(join(directory, "journal.json"), good);
    await writeFile(sealedKeys, keys.subarray(0, keys.length - 44));
    await reject();
    await writeFile(sealedKeys, Buffer.concat([keys, keys.subarray(0, 44)]));
    await reject();
    // A same-size but corrupt index is caught when the index is read in bulk.
    const flipped = Buffer.from(keys);
    flipped[0] = flipped[0]! ^ 0xff;
    await writeFile(sealedKeys, flipped);
    await rm(join(directory, "source-bloom.bin"), { force: true });
    await reject();
    await writeFile(sealedKeys, keys);
    const reopened = await opened(path);
    expect(reopened.capturedThrough).toBe(40);
  },
);

it(
  "leaves a journal that reopens after a SIGKILL at every durable rotation step",
  { timeout: 120_000 },
  async () => {
    const steps = [
      "rotate:keys",
      "rotate:bloom",
      "rotate:segment",
      "rotate:manifest",
      "compact:index",
      "compact:manifest",
      "compact:unlink",
    ];
    for (const step of steps) {
      const path = await root();
      const child = fork(
        fileURLToPath(
          new URL("../fixtures/journal-process.mjs", import.meta.url),
        ),
        [path, step],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let errors = "";
      child.stderr?.on("data", (data) => {
        errors += data;
      });
      let report: { captured: number; killed: boolean } | undefined;
      child.on("message", (message) => {
        report = message as { captured: number; killed: boolean };
      });
      const exit = await new Promise<{ signal: string | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (_code, signal) => resolve({ signal }));
        },
      );
      expect(errors, `${step}: ${errors}`).toBe("");
      expect(exit.signal, step).toBe("SIGKILL");
      expect(report?.killed, step).toBe(true);
      const captured = report!.captured;
      expect(captured, step).toBeGreaterThan(0);

      const journal = await opened(path);
      // Durably appended records survive; the interrupted step is either
      // complete or fully discarded, never half-applied.
      expect(journal.capturedThrough, step).toBeGreaterThanOrEqual(captured);
      expect(journal.compactedThrough, step).toBeLessThanOrEqual(
        journal.identity.acknowledgedSeq,
      );
      const events: number[] = [];
      for await (const event of journal.pending(journal.compactedThrough))
        events.push(event.producerSeq);
      expect(events[0] ?? journal.compactedThrough + 1, step).toBe(
        journal.compactedThrough + 1,
      );
      expect(events.at(-1) ?? journal.compactedThrough, step).toBe(
        journal.capturedThrough,
      );
      // Capture continues from the recovered boundary.
      const resumed = await journal.capture(capture(100_000));
      expect(resumed[0]!.producerSeq, step).toBe(captured + 1);
      await journal.close();
      open.length = 0;
      const reopened = await opened(path);
      expect(reopened.capturedThrough, step).toBe(captured + 1);
      await reopened.close();
      open.length = 0;
    }
  },
);

it("uses the documented live retention budget for long-running file publishers", () => {
  expect(LIVE_JOURNAL_RETENTION.segmentBytes).toBe(8 * 1024 * 1024);
  expect(LIVE_JOURNAL_RETENTION.retainAcknowledgedBytes).toBe(32 * 1024 * 1024);
});

it("refuses a sealed source-key index whose bytes rotted without changing size", async () => {
  const path = await root();
  let journal = await opened(path);
  // Enough records to seal at least one segment, so a sealed key index exists.
  for (let n = 1; n <= 40; n++) await journal.capture(capture(n));
  const directory = journal.directory;
  await journal.close();
  open.length = 0;
  const sealed = (await files(directory)).filter((name) =>
    name.endsWith(".keys"),
  );
  expect(sealed.length).toBeGreaterThan(0);
  const target = join(directory, sealed[0]!);
  const original = await readFile(target);

  // The clean index deduplicates a repeated source record: no second capture.
  journal = await opened(path);
  const before = journal.capturedThrough;
  await journal.capture(capture(1));
  expect(journal.capturedThrough).toBe(before);
  await journal.close();
  open.length = 0;

  // Flip one bit of a content hash: same length, so no size check sees it, and a
  // binary search would happily return the rotted entry.
  const rotted = Buffer.from(original);
  rotted[rotted.length - 1] ^= 0x01;
  expect(rotted.length).toBe(original.length);
  await writeFile(target, rotted);
  journal = await opened(path);
  await expect(journal.capture(capture(1))).rejects.toMatchObject({
    code: "corrupt_storage",
  });
  // It stays refused rather than succeeding on a later attempt.
  await expect(journal.capture(capture(1))).rejects.toMatchObject({
    code: "corrupt_storage",
  });
  await journal.close();
  open.length = 0;

  // Restoring the file restores dedup.
  await writeFile(target, original);
  journal = await opened(path);
  const after = journal.capturedThrough;
  await journal.capture(capture(1));
  expect(journal.capturedThrough).toBe(after);
});
