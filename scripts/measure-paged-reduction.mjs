import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance, createHistogram } from "node:perf_hooks";
import { TextStore } from "../packages/storage/dist/index.js";
import {
  PagedReducer,
  initialPagedState,
} from "../packages/playback/dist/index.js";
const count = Number(process.argv[2] ?? 100);
const batchSize = Number(process.argv[3] ?? 1);
const inspectRetention = process.argv.includes("--retention");
const collectContent = process.argv.includes("--collect");
const collectionRoots = [];
const collections = [];
const retainedCheckpoints = [];
let finalCheckpoint;
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256)
  throw new Error("Batch size must be 1..256");
if (!Number.isSafeInteger(count) || count < 1 || count > 500000)
  throw new Error("Event count must be 1..500000");
const directory = await mkdtemp(join(tmpdir(), "agentlive-reduction-measure-"));
const content = await TextStore.open(directory);
const metrics = {
  put: { calls: 0, ms: 0 },
  append: { calls: 0, ms: 0 },
  read: { calls: 0, ms: 0 },
};
const measured = Object.fromEntries(
  Object.keys(metrics).map((name) => [
    name,
    async (...args) => {
      const start = performance.now();
      metrics[name].calls++;
      try {
        return await content[name](...args);
      } finally {
        metrics[name].ms += performance.now() - start;
      }
    },
  ]),
);
const reducer = new PagedReducer(measured);
let state = initialPagedState(),
  peakHeap = 0,
  peakRss = 0,
  completed = 0,
  failure;
const started = performance.now(),
  durations = createHistogram();
const binding = { streamId: "synthetic-performance", revision: "revision-1" };
const sample = () => {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
};
const sampler = setInterval(sample, 25);
sample();
const collect = async () => {
  const beforeBytes = content.usage.storedBytes,
    started = performance.now();
  const result = await content.collect(async (scope, signal) => {
    const reader = new PagedReducer({
      read: scope.read,
      put: async () => {
        throw new Error("Collection cannot write reducer state");
      },
      append: async () => {
        throw new Error("Collection cannot append reducer state");
      },
    });
    for (const root of collectionRoots)
      await reader.trace(root, binding, scope.retain, signal);
  });
  collections.push({
    completed,
    roots: collectionRoots.length,
    beforeBytes,
    afterBytes: content.usage.storedBytes,
    elapsedMs: performance.now() - started,
    ...result,
  });
};
try {
  let pending = [],
    reported = 0;
  const flush = async () => {
    const before = performance.now();
    state =
      batchSize === 1
        ? await reducer.apply(state, pending[0])
        : await reducer.applyBatch(state, pending);
    durations.record(
      Math.max(1, Math.round((performance.now() - before) * 1000000)),
    );
    completed += pending.length;
    pending = [];
    if (completed % 256 === 0) {
      const checkpoint = await reducer.checkpoint(state, binding);
      if (inspectRetention) retainedCheckpoints.push(checkpoint);
      if (collectContent) {
        collectionRoots.push(checkpoint);
        if (collectionRoots.length > 128) collectionRoots.shift();
      }
    }
    if (collectContent && completed % 8192 === 0) await collect();
    if (completed - reported >= (count >= 10000 ? 10000 : 100)) {
      process.stderr.write(
        JSON.stringify({
          completed,
          elapsedMs: performance.now() - started,
          storedBytes: content.usage.storedBytes,
        }) + "\n",
      );
      reported = completed;
    }
  };
  for (let index = 0; index < count; index++) {
    const slot = index % 64,
      messageId = `message-${Math.floor(index / 64)}`;
    const eventContent =
      slot === 0
        ? { kind: "message.started", payload: { messageId, role: "assistant" } }
        : slot === 63
          ? { kind: "message.completed", payload: { messageId } }
          : {
              kind: "message.text.append",
              payload: { messageId, text: "delta\n".repeat(8) },
            };
    const event = {
      protocolVersion: 1,
      serverSeq: index + 1,
      timelineMs:
        count > 1 ? Math.floor((index * 8 * 3600000) / (count - 1)) : 0,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `synthetic-${index}` },
      content: eventContent,
    };
    pending.push(event);
    if (pending.length === batchSize) await flush();
  }
  if (pending.length) await flush();
  const checkpoint = await reducer.checkpoint(state, binding);
  finalCheckpoint = checkpoint;
  if (collectContent) {
    collectionRoots.push(checkpoint);
    if (collectionRoots.length > 128) collectionRoots.shift();
    await collect();
  }
  const reopened = await reducer.open(checkpoint, binding);
  if (reopened.appliedSeq !== count)
    throw new Error("Checkpoint boundary differs");
  // Independently check first/last message text, without materializing the full session.
  for (const id of new Set([0, Math.floor((count - 1) / 64)])) {
    const message = await reducer.get(reopened, "messages", `message-${id}`);
    const appends = Math.max(0, Math.min(62, count - id * 64 - 1));
    const expected = "delta\n".repeat(8 * appends);
    if (
      !message ||
      (await content.read(message.text, 0, message.text.units)) !== expected
    )
      throw new Error("Sampled message text differs");
  }
} catch (error) {
  failure = { name: error.name, message: error.message, code: error.code };
} finally {
  clearInterval(sampler);
  sample();
}
const elapsedMs = performance.now() - started;
let retention;
if (inspectRetention && finalCheckpoint) {
  const { auditPagedContentReachability } =
    await import("./audit-content-reachability.mjs");
  const began = performance.now();
  try {
    retention = {
      latest: await auditPagedContentReachability(
        content,
        [finalCheckpoint],
        binding,
      ),
      checkpoints: await auditPagedContentReachability(
        content,
        [
          ...(collectContent ? collectionRoots : retainedCheckpoints),
          finalCheckpoint,
        ],
        binding,
      ),
      diagnosticMs: performance.now() - began,
      scope:
        "Format-aware reducer and codec tracing; no pins or reclamation; excluded from reduction timing",
    };
  } catch (error) {
    retention = {
      failure: { name: error.name, message: error.message },
      diagnosticMs: performance.now() - began,
    };
    process.exitCode = 1;
  }
}
const report = {
  workload:
    "paged reducer; one message per 64 events, 48-byte text deltas, 8-hour simulated timeline",
  runtime: process.version,
  platform: process.platform,
  requestedEvents: count,
  batchSize,
  ...(collectContent
    ? {
        collectionPolicy:
          "every 8192 events and final; latest 128 checkpoint roots",
        collections,
      }
    : {}),
  latencyUnit: batchSize === 1 ? "event" : "batch",
  completed,
  elapsedMs,
  eventsPerSecond: completed / (elapsedMs / 1000),
  reductionP50Ms: durations.count ? durations.percentile(50) / 1000000 : 0,
  reductionP95Ms: durations.count ? durations.percentile(95) / 1000000 : 0,
  peakHeap,
  peakRss,
  storedBytes: content.usage.storedBytes,
  blobFiles: (await readdir(join(directory, "pages"))).filter(
    (name) => !name.startsWith("."),
  ).length,
  operations: metrics,
  failure: failure ?? null,
  ...(failure || retention?.failure ? { preservedDirectory: directory } : {}),
  ...(retention ? { retention } : {}),
};
await content.close();
const output = resolve(
  "probe-results",
  `paged-reduction-${count}-batch${batchSize}-${Date.now()}.json`,
);
await mkdir(resolve("probe-results"), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
// Keep failed runs available for inspection, and never delete the store before
// its report has been written successfully.
if (!failure && !retention?.failure)
  await rm(directory, { recursive: true, force: true });
console.log(JSON.stringify({ output, ...report }));
if (failure) process.exitCode = 1;
