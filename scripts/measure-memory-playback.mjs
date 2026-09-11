import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { BrowserPagedState } from "../apps/web/dist/paged-state.js";
import { MemoryPagedStore } from "../apps/web/dist/memory-paged-store.js";
import { tracePairedSnapshot } from "../packages/playback/dist/index.js";
const auditHead = process.argv.includes("--audit-head");
const storeOptions = {};
for (const [flag, key] of [
  ["--max-entries=", "maxEntries"],
  ["--max-bytes=", "maxBytes"],
]) {
  const option = process.argv.find((value) => value.startsWith(flag));
  if (option) storeOptions[key] = Number(option.slice(flag.length));
}
const count = Number(process.argv[2] ?? 10000);
if (!Number.isSafeInteger(count) || count < 2 || count > 500000)
  throw new RangeError("Count must be 2..500000");
const durationOption = process.argv.find((value) =>
  value.startsWith("--duration-ms="),
);
const durationMs = durationOption
  ? Number(durationOption.slice("--duration-ms=".length))
  : count * 10;
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < count ||
  durationMs > 30 * 86400000
)
  throw new RangeError(
    "Duration must be an integer from event count through 30 days",
  );
const timeline = (seq) => Math.floor((seq * durationMs) / count);
const output = resolve(
  process.argv[3] ?? `probe-results/memory-playback-${count}.json`,
);
await mkdir(resolve(output, ".."), { recursive: true });
const report = {
  success: false,
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  hardware: {
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  count,
  durationMs,
  validation: "boundary-text-v1",
  storeOptions,
  completed: 0,
  phase: "opening",
  collections: [],
  peakHeap: 0,
  peakRss: 0,
  peakBytes: 0,
  peakEntries: 0,
};
const save = () =>
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const stop = new AbortController();
const deadline = setTimeout(
  () => stop.abort(new Error("Benchmark exceeded ten minutes")),
  600000,
);
const store = new MemoryPagedStore(
  {
    serverOrigin: "http://synthetic.invalid",
    streamId: "memory-measure",
    revision: "revision",
  },
  storeOptions,
);
const collect = store.collectRetained.bind(store);
store.collectRetained = async (...args) => {
  const started = performance.now();
  try {
    const result = await collect(...args);
    report.collections.push({
      through: report.completed,
      elapsedMs: performance.now() - started,
      ...result,
    });
    return result;
  } finally {
    save();
  }
};
const sample = () => {
  const m = process.memoryUsage();
  report.peakHeap = Math.max(report.peakHeap, m.heapUsed);
  report.peakRss = Math.max(report.peakRss, m.rss);
  report.peakBytes = Math.max(report.peakBytes, store.usage.bytes);
  report.peakEntries = Math.max(report.peakEntries, store.usage.entries);
};
const timer = setInterval(sample, 25);
const event = (seq) => ({
  protocolVersion: 1,
  serverSeq: seq,
  timelineMs: timeline(seq),
  receivedAt: "2026-09-10T00:00:00Z",
  origin: { type: "server", operationId: `op-${seq}` },
  content:
    seq % 32 === 1
      ? {
          kind: "message.started",
          payload: {
            messageId: `m-${Math.floor((seq - 1) / 32)}`,
            role: "assistant",
          },
        }
      : {
          kind: "message.text.append",
          payload: {
            messageId: `m-${Math.floor((seq - 1) / 32)}`,
            text: `delta ${seq}\n`,
          },
        },
});
const history = async function* (after, through) {
  for (let seq = after + 1; seq <= through; seq++) yield event(seq);
};
let state, pinned;
const started = performance.now();
try {
  state = await BrowserPagedState.openContent(
    store,
    {
      serverOrigin: "http://synthetic.invalid",
      streamId: "memory-measure",
      revision: "revision",
    },
    stop.signal,
  );
  report.phase = "receipt";
  save();
  for (let seq = 1; seq <= count;) {
    const batch = [];
    while (seq <= count && batch.length < 256) batch.push(event(seq++));
    await state.apply(batch, stop.signal);
    report.completed = seq - 1;
    if (!pinned) pinned = await state.retainedView(stop.signal);
    const live = await state.retainedView(stop.signal);
    await live.rows(0, 16, stop.signal);
    await live.close();
    sample();
    save();
  }
  report.receiptMs = performance.now() - started;
  report.phase = "seek";
  save();
  report.seeks = [];
  for (const through of [Math.floor(count / 2), 1, count]) {
    const start = performance.now();
    const view = await state.select(
      timeline(through),
      history,
      stop.signal,
      through,
      true,
    );
    assert.equal(view.sequence, through);
    const expectedRows = Math.ceil(through / 32);
    assert.equal(view.rowCount, expectedRows);
    // Check both ends, including the partially appended final message, while
    // retaining at most one viewport of row descriptors and loaded text.
    const offsets = [...new Set([0, Math.max(0, expectedRows - 8)])];
    for (const offset of offsets) {
      const rows = await view.rows(offset, 8, stop.signal);
      assert.equal(rows.length, Math.min(8, expectedRows - offset));
      for (const [index, row] of rows.entries()) {
        const message = offset + index;
        assert.equal(row.kind, "messages");
        assert.equal(row.id, `m-${message}`);
        const text = (await view.load(row, stop.signal)).texts.text;
        const last = Math.min(through, (message + 1) * 32);
        const expected = Array.from(
          { length: last - (message * 32 + 1) },
          (_, i) => `delta ${message * 32 + i + 2}\n`,
        ).join("");
        assert.equal(await text.read(0, text.units, stop.signal), expected);
      }
    }
    report.seeks.push({ through, elapsedMs: performance.now() - start });
    await view.close();
  }
  const rows = await pinned.rows(0, 1, stop.signal);
  const text = (await pinned.load(rows[0], stop.signal)).texts.text;
  const expected = Array.from(
    { length: Math.min(32, count) - 1 },
    (_, i) => `delta ${i + 2}\n`,
  ).join("");
  assert.equal(await text.read(0, text.units, stop.signal), expected);
  report.finalUsage = store.usage;
  report.success = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (auditHead && state) {
    report.phase = "head-audit";
    save();
    try {
      const auditSignal = AbortSignal.timeout(30000);
      const head = await store.loadCheckpoint(auditSignal);
      const dependencies = new Map();
      if (head) {
        await tracePairedSnapshot(
          store,
          head,
          {
            serverOrigin: "http://synthetic.invalid",
            streamId: "memory-measure",
            revision: "revision",
          },
          async (ref) => {
            for (const dependency of await store.trace(ref, auditSignal))
              dependencies.set(dependency.hash, dependency.byteSize);
          },
          auditSignal,
        );
        report.headAudit = {
          through: head.serverSeq,
          entries: dependencies.size,
          bytes: [...dependencies.values()].reduce(
            (sum, size) => sum + size,
            0,
          ),
        };
      }
    } catch (error) {
      report.headAuditFailure = error.stack;
    }
  }
  report.phase = "closing";
  save();
  clearInterval(timer);
  clearTimeout(deadline);
  await pinned?.close();
  await state?.close();
  await store.close();
  report.afterClose = store.usage;
  report.elapsedMs = performance.now() - started;
  report.phase = "complete";
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  console.log(output);
}
