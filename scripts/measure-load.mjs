/**
 * Concurrent publish/view load measurement against a real server.
 *
 * One driver process forks a server child (production `startServer`, loopback,
 * ephemeral port, metrics enabled) and N worker children. Workers drive real
 * production clients: `PublisherJournal` + `PublisherNetwork` for publishers
 * (durable local capture, then the batching WebSocket publish loop) and
 * `SubscriberClient` for viewers (watch ticket, live socket, JSONL history
 * pages). Nothing is mocked and no production code is modified.
 *
 * Measured per shape, over a steady window that begins after a ramp:
 *   - end-to-end event latency, publisher capture -> viewer commit, from a
 *     wall-clock stamp carried inside the event payload (all processes share
 *     one system clock; `performance.timeOrigin + performance.now()`);
 *   - local durable capture latency (journal append + fsync) separately;
 *   - offered / captured / server-acknowledged / delivered event and byte rates;
 *   - concurrent history page reads at random offsets (seek + one page);
 *   - server RSS and CPU sampled in the server process itself, and the load
 *     generator's own CPU so a client-bound result is visible as such;
 *   - server `/metrics` deltas: sockets, cached sessions, HTTP status classes.
 *
 * The server child additionally wraps `RecordingSession.selectSnapshot`,
 * `buildSnapshot` and `collectSnapshots` to report why an automatic snapshot
 * failed (`/metrics` counts failures but not reasons). That wrapper lives in
 * this harness's own child process and changes no behaviour; the flag
 * --no-snapshot-diagnostics removes it.
 *
 * Then, separately: full-history download throughput (single and concurrent),
 * attachment upload/download throughput, a slow viewer that stops reading its
 * socket, and capacity probes for the connection limit and the session cache.
 *
 * Every measurement is a single local run on loopback with no network latency.
 * Reports are written incrementally, so an aborted or timed-out run still
 * leaves evidence.
 *
 *   node scripts/measure-load.mjs [report.json] [--flags]
 *   node scripts/measure-load.mjs --help
 */
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const wallNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ flags */

const HELP = `Usage: node scripts/measure-load.mjs [report.json] [options]

  --shapes=LIST       publishers x viewers-per-recording @ captures/s/publisher,
                      comma separated (default 1x1@20,10x10@20,10x10@50,10x20@50,10x24@100)
  --seconds=N         steady measurement window per shape (default 15)
  --ramp-ms=N         warm-up before the steady window (default 4000)
  --event-bytes=N     target canonical bytes per normalized event (default 1024)
  --events-per-capture=N normalized events per durable capture record (default 1);
                      the rate above counts captures, so offered events/s is
                      publishers x rate x events-per-capture
  --workers=N         load generator child processes (default 6)
  --history-viewers=N concurrent random-offset history readers per shape (default 2)
  --history-interval-ms=N pacing of each history reader (default 200)
  --page-limit=N      history page size (default 500, the subscriber default)
  --deadline-ms=N     hard deadline for the whole run (default 900000)
  --slow-viewer-ms=N  how long the slow viewer stops reading (default 8000)
  --slow-rate=N       events/s published at the slow viewer (default 100)
  --slow-event-bytes=N event size used to fill the 2 MiB socket buffer (default 65536)
  --attachment-bytes=N attachment used for transfer throughput (default 16777216)
  --socket-probe=N    viewer sockets opened to find the connection limit (default 300)
  --cache-probe=N     recordings pinned to find the session-cache limit (default 160)
  --max-connections=N --max-cached-sessions=N  server overrides (default: production)
  --skip=a,b          skip phases: shapes,history,attachment,slow-viewer,capacity
  --keep              keep the temporary server/publisher directory
`;

function parseFlags(argv) {
  const flags = new Map();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) flags.set(arg.slice(2), "true");
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else positional.push(arg);
  }
  return { flags, positional };
}
const { flags, positional } = parseFlags(process.argv.slice(2));
const flag = (name, fallback) => flags.get(name) ?? fallback;
const integer = (name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const value = Number(flag(name, fallback));
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid --${name}`);
  return value;
};

/* -------------------------------------------------------------- histogram */

// 1 ms resolution below 1 s, 10 ms below 11 s, one overflow bucket. Reported
// percentiles are bucket upper bounds; the exact minimum and maximum are kept.
const BUCKETS = 2048;
const bucketOf = (ms) =>
  ms <= 0
    ? 0
    : ms < 1000
      ? Math.floor(ms)
      : ms < 11000
        ? 1000 + Math.floor((ms - 1000) / 10)
        : BUCKETS - 1;
const bucketUpper = (index) =>
  index < 1000
    ? index + 1
    : index < BUCKETS - 1
      ? 1000 + (index - 999) * 10
      : null;

class Histogram {
  constructor() {
    this.counts = new Int32Array(BUCKETS);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }
  add(ms) {
    this.counts[bucketOf(ms)]++;
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }
  reset() {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }
  /** Sparse [bucket, count, ...] for IPC. */
  export() {
    const sparse = [];
    for (let i = 0; i < BUCKETS; i++)
      if (this.counts[i]) sparse.push(i, this.counts[i]);
    return {
      sparse,
      count: this.count,
      sum: this.sum,
      min: this.count ? this.min : 0,
      max: this.max,
    };
  }
}
function mergeHistograms(exports) {
  const counts = new Int32Array(BUCKETS);
  let count = 0,
    sum = 0,
    min = Infinity,
    max = 0;
  for (const item of exports) {
    if (!item?.count) continue;
    for (let i = 0; i < item.sparse.length; i += 2)
      counts[item.sparse[i]] += item.sparse[i + 1];
    count += item.count;
    sum += item.sum;
    min = Math.min(min, item.min);
    max = Math.max(max, item.max);
  }
  if (!count) return { count: 0 };
  const at = (fraction) => {
    let seen = 0;
    const want = fraction * count;
    for (let i = 0; i < BUCKETS; i++) {
      seen += counts[i];
      if (seen >= want) return bucketUpper(i);
    }
    return null;
  };
  return {
    count,
    meanMs: round(sum / count, 3),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    minMs: round(min, 3),
    maxMs: round(max, 3),
  };
}
const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/* ------------------------------------------------------------ server role */

async function runServer() {
  const { startServer } = await import(
    join(ROOT, "packages/server/dist/http.js")
  );
  // Diagnostic only: `/metrics` counts automatic snapshot failures but not why.
  // The harness wraps the two scheduler entry points in this child process to
  // report the error; behaviour, arguments and results are unchanged.
  if (!flags.has("no-snapshot-diagnostics")) {
    const { RecordingSession } = await import(
      join(ROOT, "packages/server/dist/session.js")
    );
    for (const name of [
      "selectSnapshot",
      "buildSnapshot",
      "collectSnapshots",
    ]) {
      const original = RecordingSession.prototype[name];
      if (typeof original !== "function") continue;
      RecordingSession.prototype[name] = async function (...args) {
        const started = performance.now();
        try {
          return await original.apply(this, args);
        } catch (error) {
          process.send({
            type: "snapshot-failure",
            method: name,
            elapsedMs: Math.round(performance.now() - started),
            code: error?.code,
            name: error?.name,
            message: String(error?.message ?? error).slice(0, 200),
          });
          throw error;
        }
      };
    }
  }
  const maxConnections = flags.has("max-connections")
    ? { maxConnections: integer("max-connections", 0, 1) }
    : {};
  const maxCachedSessions = flags.has("max-cached-sessions")
    ? { maxCachedSessions: integer("max-cached-sessions", 0, 1) }
    : {};
  const server = await startServer({
    directory: flag("directory"),
    ownerSecret: flag("owner-secret"),
    host: "127.0.0.1",
    port: 0,
    metrics: {},
    ...maxConnections,
    ...maxCachedSessions,
  });
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  const timer = setInterval(() => {
    const cpu = process.cpuUsage();
    const now = performance.now();
    const busyMs =
      (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    const percent = (busyMs / Math.max(1e-6, now - lastAt)) * 100;
    lastCpu = cpu;
    lastAt = now;
    const memory = process.memoryUsage();
    process.send({
      type: "sample",
      at: wallNow(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      cpuPercent: percent,
    });
  }, 250);
  process.on("message", (message) => {
    if (message.type !== "shutdown") return;
    clearInterval(timer);
    const forced = setTimeout(() => process.exit(0), 10000);
    forced.unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  });
  process.send({ type: "ready", url: server.url });
}

/* ------------------------------------------------------------ worker role */

async function runWorker() {
  const { PublisherJournal, PublisherNetwork, LIVE_JOURNAL_RETENTION } =
    await import(join(ROOT, "packages/publisher/dist/index.js"));
  const { SubscriberClient } = await import(
    join(ROOT, "packages/client/dist/index.js")
  );
  const { canonicalJson } = await import(
    join(ROOT, "packages/protocol/dist/index.js")
  );
  const id = flag("worker-id", "0");
  const abort = new AbortController();
  const signal = abort.signal;
  const state = {
    origin: "",
    publishers: [],
    viewers: [],
    errors: new Map(),
    history: { pages: 0, events: 0, bytes: 0, failures: 0 },
    latency: new Histogram(),
    capture: new Histogram(),
    schedule: new Histogram(),
    page: new Histogram(),
  };
  const fail = (scope, error) => {
    const key =
      `${scope}: ${error?.code ?? ""} ${error?.message ?? error}`.slice(0, 200);
    state.errors.set(key, (state.errors.get(key) ?? 0) + 1);
  };
  const bytesOf = (event) => Buffer.byteLength(canonicalJson(event));

  async function openPublishers(setup) {
    state.origin = setup.origin;
    for (const item of setup.publishers) {
      const journal = await PublisherJournal.open(
        join(setup.journalRoot, `pub-${item.nativeSessionId}`),
        {
          serverOrigin: setup.origin,
          agent: "synthetic",
          nativeSessionId: item.nativeSessionId,
        },
        { retention: LIVE_JOURNAL_RETENTION },
      );
      const statuses = new Map();
      const network = new PublisherNetwork({
        journal,
        ownerCredential: setup.ownerSecret,
        title: `load ${item.nativeSessionId}`,
        visibility: "public",
        onStatus: (status) =>
          statuses.set(status, (statuses.get(status) ?? 0) + 1),
      });
      await network.ensureRemote(signal);
      const publisher = {
        index: item.index,
        journal,
        network,
        statuses,
        captured: 0,
        capturedBytes: 0,
        streamId: journal.identity.streamId,
        revision: journal.identity.revision,
      };
      state.publishers.push(publisher);
    }
    return state.publishers.map((publisher) => ({
      index: publisher.index,
      streamId: publisher.streamId,
      revision: publisher.revision,
    }));
  }

  function startViewers(targets) {
    const ready = [];
    for (const target of targets) {
      const statuses = new Map();
      const viewer = {
        received: 0,
        receivedBytes: 0,
        statuses,
        streamId: target.streamId,
      };
      let live;
      const live_ = new Promise((done) => (live = done));
      const client = new SubscriberClient({
        serverOrigin: state.origin,
        cursor: {
          streamId: target.streamId,
          revision: target.revision,
          serverSeq: 0,
        },
        onStatus: (status) => {
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
          if (status === "live") live();
        },
        commit: async (events) => {
          const now = wallNow();
          for (const event of events) {
            viewer.received++;
            viewer.receivedBytes += bytesOf(event);
            const text = event.content?.payload?.text;
            if (typeof text !== "string") continue;
            const stamp = Number(text.slice(0, text.indexOf("|")));
            if (Number.isFinite(stamp)) state.latency.add(now - stamp);
          }
        },
      });
      state.viewers.push(viewer);
      client.run(signal).catch((error) => {
        if (!signal.aborted) fail("viewer", error);
      });
      ready.push(live_);
    }
    return ready;
  }

  async function publishLoop(publisher, rate, padding, perCapture) {
    const interval = 1000 / rate;
    let next = performance.now();
    let sequence = 0;
    let captures = 0;
    // One message per 64 events; the block's first event starts it, so the
    // event stream is a valid reducer input (the server's snapshot builder
    // rejects an append whose message was never started).
    const messageId = () =>
      `m_${publisher.index}_${Math.floor((sequence - 1) / 64)}`;
    while (!signal.aborted) {
      const now = performance.now();
      if (now + 0.4 < next) {
        await sleep(Math.min(next - now, 25));
        continue;
      }
      state.schedule.add(now - next);
      next += interval;
      // Bounded catch-up: never accumulate an unbounded backlog of missed ticks.
      if (next < now - 250) next = now;
      captures++;
      // One capture is one durable native source record; a real adapter often
      // normalizes several events from one record, and they share its fsync.
      const content = [];
      for (let item = 0; item < perCapture; item++) {
        sequence++;
        content.push(
          sequence % 64 === 1
            ? {
                kind: "message.started",
                payload: { messageId: messageId(), role: "assistant" },
              }
            : {
                kind: "message.text.append",
                payload: {
                  messageId: messageId(),
                  text: `${wallNow().toFixed(3)}|${padding}`,
                },
              },
        );
      }
      const started = performance.now();
      try {
        const events = await publisher.journal.capture({
          sourceKey: `p${publisher.index}_c${captures}`,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock1",
          elapsedMs: sequence,
          fidelity: "delta",
          adapterState: { sequence },
          content,
        });
        state.capture.add(performance.now() - started);
        publisher.captured += events.length;
        for (const event of events) publisher.capturedBytes += bytesOf(event);
      } catch (error) {
        if (signal.aborted) return;
        fail("capture", error);
        await sleep(100);
      }
    }
  }

  async function historyLoop(target, pageLimit, intervalMs) {
    while (!signal.aborted) {
      const tick = performance.now();
      try {
        const base = `${state.origin}/api/v1/streams/${target.streamId}`;
        const info = await (await fetch(base, { signal })).json();
        const head = info.serverSeq ?? 0;
        if (head < 2) {
          await sleep(250);
          continue;
        }
        const after = Math.floor(Math.random() * head);
        const started = performance.now();
        const response = await fetch(
          `${base}/events?revision=${target.revision}&afterServerSeq=${after}` +
            `&throughServerSeq=${head}&limit=${pageLimit}`,
          { signal },
        );
        const text = await response.text();
        state.page.add(performance.now() - started);
        if (!response.ok) {
          state.history.failures++;
          fail("history", {
            code: response.status,
            message: text.slice(0, 80),
          });
          await sleep(100);
          continue;
        }
        state.history.pages++;
        state.history.bytes += Buffer.byteLength(text);
        state.history.events += text ? text.split("\n").length - 1 : 0;
        // Paced background reads: history readers are concurrent load, not a
        // throughput benchmark of the page route (that is its own phase).
        const remaining = intervalMs - (performance.now() - tick);
        if (remaining > 0) await sleep(remaining);
      } catch (error) {
        if (signal.aborted) return;
        state.history.failures++;
        fail("history", error);
        await sleep(100);
      }
    }
  }

  const countMaps = (maps) => {
    const total = {};
    for (const map of maps)
      for (const [key, value] of map) total[key] = (total[key] ?? 0) + value;
    return total;
  };
  const counters = () => ({
    captured: state.publishers.reduce((sum, p) => sum + p.captured, 0),
    capturedBytes: state.publishers.reduce(
      (sum, p) => sum + p.capturedBytes,
      0,
    ),
    acknowledged: state.publishers.reduce(
      (sum, p) => sum + p.journal.identity.acknowledgedSeq,
      0,
    ),
    received: state.viewers.reduce((sum, v) => sum + v.received, 0),
    receivedBytes: state.viewers.reduce((sum, v) => sum + v.receivedBytes, 0),
    historyPages: state.history.pages,
    historyEvents: state.history.events,
    historyBytes: state.history.bytes,
    historyFailures: state.history.failures,
    publisherStatus: countMaps(state.publishers.map((p) => p.statuses)),
    viewerStatus: countMaps(state.viewers.map((v) => v.statuses)),
  });
  let baseline = null;
  let markedAt = 0;
  let markedCpu = process.cpuUsage();

  process.on("message", async (message) => {
    try {
      if (message.type === "setup") {
        const streams = await openPublishers(message);
        process.send({ type: "streams", streams });
      } else if (message.type === "viewers") {
        const ready = startViewers(message.targets);
        await Promise.race([
          Promise.all(ready),
          sleep(45000).then(() => {
            throw new Error("Viewers did not reach live within 45 s");
          }),
        ]);
        process.send({ type: "viewersReady" });
      } else if (message.type === "go") {
        for (const publisher of state.publishers) {
          publisher.network.run(signal).catch((error) => {
            if (!signal.aborted) fail("publisher", error);
          });
          void publishLoop(
            publisher,
            message.rate,
            message.padding,
            message.eventsPerCapture,
          );
        }
        for (const target of message.historyTargets)
          void historyLoop(
            target,
            message.pageLimit,
            message.historyIntervalMs,
          );
        process.send({ type: "going" });
      } else if (message.type === "mark") {
        baseline = counters();
        markedAt = performance.now();
        markedCpu = process.cpuUsage();
        for (const histogram of [
          state.latency,
          state.capture,
          state.schedule,
          state.page,
        ])
          histogram.reset();
        process.send({ type: "marked" });
      } else if (message.type === "collect") {
        const now = counters();
        const cpu = process.cpuUsage(markedCpu);
        const delta = {};
        for (const [key, value] of Object.entries(now))
          delta[key] =
            typeof value === "number" ? value - (baseline?.[key] ?? 0) : value;
        process.send({
          type: "collected",
          elapsedMs: performance.now() - markedAt,
          cpuMs: (cpu.user + cpu.system) / 1000,
          counters: delta,
          errors: [...state.errors].map(([message, count]) => ({
            message,
            count,
          })),
          histograms: {
            latency: state.latency.export(),
            capture: state.capture.export(),
            schedule: state.schedule.export(),
            page: state.page.export(),
          },
        });
      } else if (message.type === "stop") {
        abort.abort(new Error("Measurement phase ended"));
        await Promise.allSettled(
          state.publishers.map((p) => p.journal.close()),
        );
        process.send({ type: "stopped" });
      }
    } catch (error) {
      process.send({
        type: "failed",
        error: String(error?.stack ?? error).slice(0, 2000),
      });
    }
  });
  process.send({ type: "ready", id });
}

/* ------------------------------------------------------------ driver role */

class Child {
  constructor(label, args) {
    this.label = label;
    this.exited = false;
    this.queue = [];
    this.waiters = [];
    this.handlers = new Map();
    this.process = fork(SCRIPT, args, {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.process.on("message", (message) => {
      const handler = this.handlers.get(message.type);
      if (handler) return handler(message);
      if (message.type === "failed") {
        const error = new Error(`${label}: ${message.error}`);
        this.queue.push(message);
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        return;
      }
      const index = this.waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.queue.push(message);
    });
    this.process.on("exit", (code, cause) => {
      this.exited = true;
      const error = new Error(`${label} exited (${code ?? cause})`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }
  on(type, handler) {
    this.handlers.set(type, handler);
  }
  send(message) {
    if (!this.exited) this.process.send(message);
  }
  expect(type, timeoutMs = 60000) {
    const index = this.queue.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    const failure = this.queue.find((m) => m.type === "failed");
    if (failure)
      return Promise.reject(new Error(`${this.label}: ${failure.error}`));
    if (this.exited)
      return Promise.reject(new Error(`${this.label} already exited`));
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`${this.label}: timed out waiting for ${type}`));
      }, timeoutMs);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      waiter.resolve = settle(resolve);
      waiter.reject = settle(reject);
    });
  }
  kill() {
    if (!this.exited) this.process.kill("SIGKILL");
  }
}

async function runDriver() {
  const output = resolve(
    positional[0] ?? flag("report", "docs/performance/load-sweep.json"),
  );
  await mkdir(dirname(output), { recursive: true });
  const shapes = String(
    flag("shapes", "1x1@20,10x10@20,10x10@50,10x20@50,10x24@100"),
  )
    .split(",")
    .filter(Boolean)
    .map((text) => {
      const match = /^(\d+)x(\d+)@(\d+)$/.exec(text.trim());
      if (!match) throw new RangeError(`Invalid shape ${text}`);
      return {
        label: text.trim(),
        publishers: Number(match[1]),
        viewers: Number(match[2]),
        rate: Number(match[3]),
      };
    });
  const options = {
    shapes: shapes.map((shape) => shape.label),
    seconds: integer("seconds", 15, 1, 3600),
    rampMs: integer("ramp-ms", 4000, 0, 600000),
    eventBytes: integer("event-bytes", 1024, 64, 200000),
    eventsPerCapture: integer("events-per-capture", 1, 1, 100),
    workers: integer("workers", 6, 1, 64),
    historyViewers: integer("history-viewers", 2, 0, 64),
    historyIntervalMs: integer("history-interval-ms", 200, 0, 60000),
    pageLimit: integer("page-limit", 500, 1, 1000),
    deadlineMs: integer("deadline-ms", 900000, 10000),
    slowViewerMs: integer("slow-viewer-ms", 8000, 100, 600000),
    slowRate: integer("slow-rate", 100, 1, 100000),
    slowEventBytes: integer("slow-event-bytes", 64 * 1024, 64, 250000),
    attachmentBytes: integer("attachment-bytes", 16 * 1024 * 1024, 1024),
    socketProbe: integer("socket-probe", 300, 0, 4096),
    cacheProbe: integer("cache-probe", 160, 0, 4096),
    skip: String(flag("skip", "")).split(",").filter(Boolean),
  };
  const report = {
    success: false,
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    startedAt: new Date().toISOString(),
    fixture: "load-v1",
    options,
    limits: {
      publishBatch: "100 events or 256 KiB",
      socketOutboundBuffer: 2 * 1024 * 1024,
      maxConnections: flags.has("max-connections")
        ? integer("max-connections", 0, 1)
        : 256,
      maxCachedSessions: flags.has("max-cached-sessions")
        ? integer("max-cached-sessions", 0, 1)
        : 128,
    },
    phases: [],
    serverSamples: [],
  };
  const save = () =>
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  save();

  const directory = await mkdtemp(join(tmpdir(), "agentlive-load-"));
  const ownerSecret = randomBytes(32).toString("hex");
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    report.deadlineExceeded = true;
    deadline.abort(new Error("Run deadline exceeded"));
  }, options.deadlineMs);
  const server = new Child("server", [
    "--role=server",
    `--directory=${join(directory, "server")}`,
    `--owner-secret=${ownerSecret}`,
    ...(flags.has("max-connections")
      ? [`--max-connections=${flags.get("max-connections")}`]
      : []),
    ...(flags.has("max-cached-sessions")
      ? [`--max-cached-sessions=${flags.get("max-cached-sessions")}`]
      : []),
  ]);
  await mkdir(join(directory, "server"), { recursive: true });
  let phaseLabel = "startup";
  const samples = [];
  let lastSampleAt = 0;
  server.on("sample", (sample) => {
    samples.push({ ...sample, phase: phaseLabel });
    // Bounded downsampled series retained in the report (500 ms).
    if (sample.at - lastSampleAt >= 500) {
      lastSampleAt = sample.at;
      report.serverSamples.push({
        t: round((sample.at - Date.parse(report.startedAt)) / 1000, 2),
        phase: phaseLabel,
        rss: sample.rss,
        cpu: round(sample.cpuPercent, 1),
      });
      if (report.serverSamples.length > 4000) report.serverSamples.shift();
    }
  });
  report.snapshotFailures = [];
  server.on("snapshot-failure", (failure) => {
    const key = `${failure.method}|${failure.code ?? failure.name}|${failure.message}`;
    const found = report.snapshotFailures.find((item) => item.key === key);
    if (found) {
      found.count++;
      found.lastPhase = phaseLabel;
      found.maxElapsedMs = Math.max(found.maxElapsedMs, failure.elapsedMs);
    } else if (report.snapshotFailures.length < 32)
      report.snapshotFailures.push({
        key,
        count: 1,
        firstPhase: phaseLabel,
        lastPhase: phaseLabel,
        maxElapsedMs: failure.elapsedMs,
        ...failure,
      });
  });
  const origin = (await server.expect("ready", 60000)).url;
  report.serverOrigin = origin;
  save();

  const serverStats = (fromAt, toAt) => {
    const window = samples.filter(
      (sample) => sample.at >= fromAt && sample.at <= toAt,
    );
    if (!window.length) return null;
    const rss = window.map((s) => s.rss);
    const cpu = window.map((s) => s.cpuPercent);
    return {
      samples: window.length,
      rssPeak: Math.max(...rss),
      rssMean: Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
      cpuPercentPeak: round(Math.max(...cpu), 1),
      cpuPercentMean: round(cpu.reduce((a, b) => a + b, 0) / cpu.length, 1),
    };
  };
  const metrics = async () => {
    const response = await fetch(origin + "/metrics", {
      headers: { authorization: `Bearer ${ownerSecret}` },
    });
    const text = await response.text();
    const values = {};
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const split = line.lastIndexOf(" ");
      values[line.slice(0, split)] = Number(line.slice(split + 1));
    }
    return values;
  };
  const metricsDelta = (before, after) => {
    const delta = {};
    for (const [key, value] of Object.entries(after))
      if (key.startsWith("agentlive_http_requests_total")) {
        const change = value - (before[key] ?? 0);
        if (change)
          delta[key.replace("agentlive_http_requests_total", "")] = change;
      }
    return {
      requests: delta,
      cachedSessions: after.agentlive_cached_sessions,
      viewerSockets: after['agentlive_websocket_connections{role="viewer"}'],
      publisherSockets:
        after['agentlive_websocket_connections{role="publisher"}'],
      storedBytes: after.agentlive_storage_stored_bytes,
      snapshotFailures: after.agentlive_snapshot_failures_total,
      websocketHandlerErrors: after.agentlive_websocket_handler_errors_total,
    };
  };
  const check = () => {
    if (deadline.signal.aborted) throw deadline.signal.reason;
  };
  const padding = "x".repeat(Math.max(1, options.eventBytes - 420));

  const finish = async (failure) => {
    clearTimeout(deadlineTimer);
    if (failure) {
      report.failure = String(failure?.stack ?? failure).slice(0, 4000);
      process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    report.serverPeakRss = samples.length
      ? Math.max(...samples.map((s) => s.rss))
      : null;
    save();
    server.send({ type: "shutdown" });
    await Promise.race([
      new Promise((done) => server.process.once("exit", done)),
      sleep(15000),
    ]);
    server.kill();
    if (!flags.has("keep"))
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    else report.directory = directory;
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(output);
  };

  let recordings = [];
  try {
    /* ----------------------------------------------------- concurrent shapes */
    if (!options.skip.includes("shapes"))
      for (const [index, shape] of shapes.entries()) {
        check();
        const phase = {
          name: "shape",
          label: shape.label,
          publishers: shape.publishers,
          viewersPerRecording: shape.viewers,
          capturesPerSecondPerPublisher: shape.rate,
          eventsPerCapture: options.eventsPerCapture,
          offeredEventsPerSecond:
            shape.publishers * shape.rate * options.eventsPerCapture,
          startedAt: new Date().toISOString(),
        };
        report.phases.push(phase);
        phaseLabel = `shape ${shape.label}`;
        save();
        const workers = [];
        try {
          for (let i = 0; i < options.workers; i++) {
            const worker = new Child(`worker${i}`, [
              "--role=worker",
              `--worker-id=${i}`,
            ]);
            workers.push(worker);
            await worker.expect("ready", 60000);
          }
          const assignments = workers.map(() => []);
          for (let p = 0; p < shape.publishers; p++)
            assignments[p % workers.length].push({
              index: p,
              nativeSessionId: `s${index}_p${p}`,
            });
          const streams = [];
          await Promise.all(
            workers.map(async (worker, i) => {
              worker.send({
                type: "setup",
                origin,
                ownerSecret,
                journalRoot: join(directory, `publishers-${index}-${i}`),
                publishers: assignments[i],
              });
              const reply = await worker.expect("streams", 120000);
              streams.push(...reply.streams);
            }),
          );
          streams.sort((a, b) => a.index - b.index);
          recordings = streams;
          phase.recordings = streams.length;
          // Viewers are spread across workers and offset from their publisher's
          // worker, so a recording's viewers are not all co-located with it.
          const viewerTargets = workers.map(() => []);
          for (const [s, stream] of streams.entries())
            for (let v = 0; v < shape.viewers; v++)
              viewerTargets[(s * shape.viewers + v + 1) % workers.length].push({
                streamId: stream.streamId,
                revision: stream.revision,
              });
          await Promise.all(
            workers.map(async (worker, i) => {
              worker.send({ type: "viewers", targets: viewerTargets[i] });
              await worker.expect("viewersReady", 120000);
            }),
          );
          phase.viewers = viewerTargets.reduce((sum, t) => sum + t.length, 0);
          const historyTargets = workers.map(() => []);
          for (let h = 0; h < options.historyViewers; h++)
            historyTargets[h % workers.length].push(
              streams[h % streams.length],
            );
          await Promise.all(
            workers.map(async (worker, i) => {
              worker.send({
                type: "go",
                rate: shape.rate,
                padding,
                eventsPerCapture: options.eventsPerCapture,
                pageLimit: options.pageLimit,
                historyIntervalMs: options.historyIntervalMs,
                historyTargets: historyTargets[i],
              });
              await worker.expect("going", 60000);
            }),
          );
          await sleep(options.rampMs);
          check();
          const before = await metrics();
          const markAt = wallNow();
          await Promise.all(
            workers.map(async (worker) => {
              worker.send({ type: "mark" });
              await worker.expect("marked", 60000);
            }),
          );
          await sleep(options.seconds * 1000);
          const results = await Promise.all(
            workers.map(async (worker) => {
              worker.send({ type: "collect" });
              return worker.expect("collected", 60000);
            }),
          );
          const collectAt = wallNow();
          const after = await metrics();
          const elapsedMs =
            results.reduce((sum, r) => sum + r.elapsedMs, 0) / results.length;
          const total = (key) =>
            results.reduce((sum, r) => sum + (r.counters[key] ?? 0), 0);
          const perSecond = (key) => round((total(key) / elapsedMs) * 1000, 1);
          const statuses = (key) => {
            const merged = {};
            for (const result of results)
              for (const [name, count] of Object.entries(
                result.counters[key] ?? {},
              ))
                merged[name] = (merged[name] ?? 0) + count;
            return merged;
          };
          phase.windowMs = round(elapsedMs);
          phase.captured = total("captured");
          phase.acknowledged = total("acknowledged");
          phase.delivered = total("received");
          phase.capturedEventsPerSecond = perSecond("captured");
          phase.acknowledgedEventsPerSecond = perSecond("acknowledged");
          phase.capturedBytesPerSecond = perSecond("capturedBytes");
          phase.deliveredEventsPerSecond = perSecond("received");
          phase.deliveredBytesPerSecond = perSecond("receivedBytes");
          phase.meanEventBytes = total("captured")
            ? Math.round(total("capturedBytes") / total("captured"))
            : null;
          phase.offeredAchievedRatio = round(
            phase.capturedEventsPerSecond / phase.offeredEventsPerSecond,
            3,
          );
          phase.deliveryRatio = round(
            phase.delivered / Math.max(1, phase.captured * shape.viewers),
            3,
          );
          phase.latency = mergeHistograms(
            results.map((r) => r.histograms.latency),
          );
          phase.durableCapture = mergeHistograms(
            results.map((r) => r.histograms.capture),
          );
          phase.captureScheduleLag = mergeHistograms(
            results.map((r) => r.histograms.schedule),
          );
          phase.historyPages = total("historyPages");
          phase.historyPagesPerSecond = perSecond("historyPages");
          phase.historyEventsPerSecond = perSecond("historyEvents");
          phase.historyBytesPerSecond = perSecond("historyBytes");
          phase.historyFailures = total("historyFailures");
          phase.historyPageLatency = mergeHistograms(
            results.map((r) => r.histograms.page),
          );
          phase.publisherStatus = statuses("publisherStatus");
          phase.viewerStatus = statuses("viewerStatus");
          phase.clientCpuPercent = round(
            (results.reduce((sum, r) => sum + r.cpuMs, 0) / elapsedMs) * 100,
            1,
          );
          phase.server = serverStats(markAt, collectAt);
          phase.metrics = metricsDelta(before, after);
          phase.errors = results.flatMap((r) => r.errors);
          phase.finishedAt = new Date().toISOString();
          save();
        } finally {
          await Promise.allSettled(
            workers.map(async (worker) => {
              worker.send({ type: "stop" });
              await worker.expect("stopped", 30000).catch(() => {});
              worker.kill();
            }),
          );
          phaseLabel = "idle";
        }
      }

    /* --------------------------------------------------- history downloads */
    if (!options.skip.includes("history") && recordings.length) {
      check();
      phaseLabel = "history";
      const phase = {
        name: "history-download",
        startedAt: new Date().toISOString(),
      };
      report.phases.push(phase);
      save();
      const heads = await Promise.all(
        recordings.map(async (stream) => {
          const info = await (
            await fetch(`${origin}/api/v1/streams/${stream.streamId}`)
          ).json();
          return { ...stream, head: info.serverSeq };
        }),
      );
      heads.sort((a, b) => b.head - a.head);
      const download = async (stream) => {
        let after = 0,
          events = 0,
          bytes = 0,
          pages = 0;
        const started = performance.now();
        while (after < stream.head) {
          const response = await fetch(
            `${origin}/api/v1/streams/${stream.streamId}/events` +
              `?revision=${stream.revision}&afterServerSeq=${after}` +
              `&throughServerSeq=${stream.head}&limit=${options.pageLimit}`,
          );
          const text = await response.text();
          if (!response.ok) throw new Error(`history ${response.status}`);
          pages++;
          bytes += Buffer.byteLength(text);
          events += text.split("\n").length - 1;
          after = Number(response.headers.get("x-agentlive-next-cursor"));
        }
        return { events, bytes, pages, elapsedMs: performance.now() - started };
      };
      const target = heads[0];
      phase.recordingEvents = target.head;
      const single = await download(target);
      phase.single = {
        ...single,
        elapsedMs: round(single.elapsedMs),
        eventsPerSecond: round((single.events / single.elapsedMs) * 1000),
        bytesPerSecond: round((single.bytes / single.elapsedMs) * 1000),
      };
      save();
      const concurrency = Math.min(8, heads.length);
      const startedAt = wallNow();
      const start = performance.now();
      const many = await Promise.all(
        heads.slice(0, concurrency).map((stream) => download(stream)),
      );
      const manyMs = performance.now() - start;
      phase.concurrent = {
        downloads: concurrency,
        elapsedMs: round(manyMs),
        events: many.reduce((sum, r) => sum + r.events, 0),
        bytes: many.reduce((sum, r) => sum + r.bytes, 0),
        eventsPerSecond: round(
          (many.reduce((sum, r) => sum + r.events, 0) / manyMs) * 1000,
        ),
        bytesPerSecond: round(
          (many.reduce((sum, r) => sum + r.bytes, 0) / manyMs) * 1000,
        ),
        server: serverStats(startedAt, wallNow()),
      };
      phase.finishedAt = new Date().toISOString();
      save();
    }

    /* --------------------------------------------------------- attachments */
    if (!options.skip.includes("attachment")) {
      check();
      phaseLabel = "attachment";
      const phase = { name: "attachment", bytes: options.attachmentBytes };
      report.phases.push(phase);
      save();
      Object.assign(
        phase,
        await attachmentPhase({
          origin,
          ownerSecret,
          directory,
          options,
          serverStats,
        }),
        { finishedAt: new Date().toISOString() },
      );
      save();
    }

    /* -------------------------------------------------------- slow viewer */
    if (!options.skip.includes("slow-viewer")) {
      check();
      phaseLabel = "slow-viewer";
      const phase = {
        name: "slow-viewer",
        pauseMs: options.slowViewerMs,
        ratePerSecond: options.slowRate,
        eventBytes: options.slowEventBytes,
        startedAt: new Date().toISOString(),
      };
      report.phases.push(phase);
      save();
      const result = await slowViewerPhase({
        origin,
        ownerSecret,
        directory,
        options,
        padding: "y".repeat(Math.max(1, options.slowEventBytes - 420)),
        serverStats,
      });
      Object.assign(phase, result, { finishedAt: new Date().toISOString() });
      save();
    }

    /* ----------------------------------------------------------- capacity */
    if (!options.skip.includes("capacity")) {
      check();
      phaseLabel = "capacity";
      const phase = { name: "capacity", startedAt: new Date().toISOString() };
      report.phases.push(phase);
      save();
      const probeStream =
        report.phases.find((p) => p.name === "slow-viewer")?.streamId ??
        recordings[0]?.streamId;
      phase.connections = await connectionCapacityProbe(
        origin,
        options,
        probeStream,
      );
      save();
      phase.sessionCache = await sessionCacheProbe(
        origin,
        ownerSecret,
        options,
      );
      phase.metrics = metricsDelta({}, await metrics());
      phase.finishedAt = new Date().toISOString();
      save();
    }

    report.success = true;
    await finish();
  } catch (error) {
    await finish(error);
  }
}

/* ------------------------------------------------- slow viewer and probes */

const require = createRequire(join(ROOT, "packages/publisher/src/network.ts"));

function openSocket(origin, ticket) {
  const WebSocketImpl = require("ws");
  return new WebSocketImpl(
    origin.replace(/^http/, "ws") + "/api/v1/watch?ticket=" + ticket,
    { perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 },
  );
}
async function watchTicket(origin, streamId) {
  const response = await fetch(
    `${origin}/api/v1/streams/${streamId}/watch-ticket`,
    { method: "POST" },
  );
  if (!response.ok)
    throw Object.assign(new Error(`watch-ticket ${response.status}`), {
      status: response.status,
      body: (await response.text()).slice(0, 200),
    });
  return (await response.json()).ticket;
}
/**
 * Subscribe a raw socket and resolve once the server confirms the boundary.
 * The request is sent as soon as the socket is open rather than in reply to
 * `hello`, which may already have been delivered.
 */
function subscribeRaw(socket, streamId, revision, onEvent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscribe timeout")),
      20000,
    );
    const request = () =>
      socket.send(
        JSON.stringify({
          type: "subscribe",
          protocolVersion: 1,
          requestId: "subscribe",
          streamId,
          revision,
          afterServerSeq: 0,
        }),
      );
    if (socket.readyState === 1) request();
    else socket.once("open", request);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "hello") {
        /* already requested */
      } else if (frame.type === "subscribed") {
        clearTimeout(timer);
        resolve();
      } else if (frame.type === "event") onEvent?.(frame.event, data.length);
      else if (frame.type === "error") {
        clearTimeout(timer);
        reject(new Error(frame.message));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Upload one attachment through the real publisher credential, announce it with
 * an `attachment.available` event (the server only serves referenced blobs),
 * then measure download throughput sequentially and with four parallel readers.
 */
async function attachmentPhase(context) {
  const { origin, ownerSecret, directory, options, serverStats } = context;
  const { PublisherJournal, PublisherNetwork, LIVE_JOURNAL_RETENTION } =
    await import(join(ROOT, "packages/publisher/dist/index.js"));
  const abort = new AbortController();
  const journal = await PublisherJournal.open(
    join(directory, "attachment-publisher"),
    {
      serverOrigin: origin,
      agent: "synthetic",
      nativeSessionId: "attachment_throughput",
    },
    { retention: LIVE_JOURNAL_RETENTION },
  );
  const network = new PublisherNetwork({
    journal,
    ownerCredential: ownerSecret,
    title: "attachment throughput",
    visibility: "public",
  });
  const result = {};
  try {
    await network.ensureRemote(abort.signal);
    const streamId = journal.identity.streamId;
    const writeSecret = journal.identity.writeSecret;
    network.run(abort.signal).catch(() => {});
    const payload = randomBytes(options.attachmentBytes);
    const hash = createHash("sha256").update(payload).digest("hex");
    const uploadStart = performance.now();
    const uploaded = await fetch(
      `${origin}/api/v1/streams/${streamId}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${writeSecret}`,
          "x-attachment-sha256": hash,
          "x-attachment-bytes": String(options.attachmentBytes),
          "content-type": "application/octet-stream",
        },
        body: payload,
        duplex: "half",
      },
    );
    const uploadMs = performance.now() - uploadStart;
    result.streamId = streamId;
    result.uploadStatus = uploaded.status;
    result.uploadMs = round(uploadMs);
    result.uploadBytesPerSecond = round(
      (options.attachmentBytes / uploadMs) * 1000,
    );
    if (!uploaded.ok) {
      result.uploadBody = (await uploaded.text()).slice(0, 200);
      return result;
    }
    await journal.capture({
      sourceKey: "attachment_1",
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock1",
      elapsedMs: 1,
      fidelity: "delta",
      adapterState: null,
      content: [
        {
          kind: "attachment.available",
          payload: {
            attachment: {
              artifactId: "a_1",
              version: 1,
              hash,
              filename: "payload.bin",
              mediaType: "application/octet-stream",
              byteSize: options.attachmentBytes,
            },
          },
        },
      ],
    });
    const announcedAt = performance.now();
    while (
      journal.identity.acknowledgedSeq < 1 &&
      performance.now() - announcedAt < 30000
    )
      await sleep(25);
    result.announcedMs = round(performance.now() - announcedAt);
    const url = `${origin}/api/v1/streams/${streamId}/attachments/${hash}`;
    const fetchAll = async () => {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(
          `attachment ${response.status}: ${(await response.text()).slice(0, 120)}`,
        );
      let bytes = 0;
      for await (const chunk of response.body) bytes += chunk.byteLength;
      return bytes;
    };
    const singleStart = performance.now();
    const singleBytes = await fetchAll();
    const singleMs = performance.now() - singleStart;
    result.download = {
      bytes: singleBytes,
      elapsedMs: round(singleMs),
      bytesPerSecond: round((singleBytes / singleMs) * 1000),
    };
    const parallelAt = wallNow();
    const parallelStart = performance.now();
    const parallel = await Promise.all([0, 1, 2, 3].map(() => fetchAll()));
    const parallelMs = performance.now() - parallelStart;
    const parallelBytes = parallel.reduce((sum, value) => sum + value, 0);
    result.downloadConcurrent = {
      streams: parallel.length,
      bytes: parallelBytes,
      elapsedMs: round(parallelMs),
      bytesPerSecond: round((parallelBytes / parallelMs) * 1000),
      server: serverStats(parallelAt, wallNow()),
    };
    return result;
  } catch (error) {
    result.failure = String(error?.message ?? error).slice(0, 300);
    return result;
  } finally {
    abort.abort(new Error("attachment phase ended"));
    await journal.close().catch(() => {});
  }
}

async function slowViewerPhase(context) {
  const { origin, ownerSecret, directory, options, padding, serverStats } =
    context;
  const { PublisherJournal, PublisherNetwork, LIVE_JOURNAL_RETENTION } =
    await import(join(ROOT, "packages/publisher/dist/index.js"));
  const { SubscriberClient } = await import(
    join(ROOT, "packages/client/dist/index.js")
  );
  const abort = new AbortController();
  const journal = await PublisherJournal.open(
    join(directory, "slow-publisher"),
    {
      serverOrigin: origin,
      agent: "synthetic",
      nativeSessionId: "slow_viewer",
    },
    { retention: LIVE_JOURNAL_RETENTION },
  );
  const network = new PublisherNetwork({
    journal,
    ownerCredential: ownerSecret,
    title: "slow viewer",
    visibility: "public",
  });
  await network.ensureRemote(abort.signal);
  const streamId = journal.identity.streamId;
  const revision = journal.identity.revision;
  let healthy = 0;
  const control = new SubscriberClient({
    serverOrigin: origin,
    cursor: { streamId, revision, serverSeq: 0 },
    commit: async (events) => {
      healthy += events.length;
    },
  });
  try {
    network.run(abort.signal).catch(() => {});
    control.run(abort.signal).catch(() => {});
    const socket = openSocket(origin, await watchTicket(origin, streamId));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let received = 0;
    let receivedBytes = 0;
    let lastSeq = 0;
    const closed = new Promise((resolve) =>
      socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString().slice(0, 120) }),
      ),
    );
    await subscribeRaw(socket, streamId, revision, (event, bytes) => {
      received++;
      receivedBytes += bytes;
      lastSeq = event.serverSeq;
    });
    // The viewer stops reading its socket entirely: the kernel receive buffer
    // fills, then the server's per-socket outbound buffer reaches its limit.
    socket.pause();
    const pausedAt = wallNow();
    const pausedAtSeq = lastSeq;
    let sequence = 0;
    let capturedBytes = 0;
    const interval = 1000 / options.slowRate;
    let next = performance.now();
    const deadline = pausedAt + options.slowViewerMs;
    while (wallNow() < deadline) {
      const now = performance.now();
      if (now + 0.4 < next) {
        await sleep(Math.min(next - now, 20));
        continue;
      }
      next += interval;
      if (next < now - 250) next = now;
      sequence++;
      const events = await journal.capture({
        sourceKey: `slow_e${sequence}`,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock1",
        elapsedMs: sequence,
        fidelity: "delta",
        adapterState: { sequence },
        content: [
          sequence === 1
            ? {
                kind: "message.started",
                payload: { messageId: "m_slow", role: "assistant" },
              }
            : {
                kind: "message.text.append",
                payload: {
                  messageId: "m_slow",
                  text: `${wallNow()}|${padding}`,
                },
              },
        ],
      });
      for (const event of events)
        capturedBytes += Buffer.byteLength(JSON.stringify(event));
    }
    const publishedAt = wallNow();
    const serverDuringPause = serverStats(pausedAt, publishedAt);
    // Resume reading: drain whatever the server and kernel buffered, then
    // observe the close frame. 1013 with a resume instruction is the
    // documented shed; 1006 means the socket was cut before the frame.
    socket.resume();
    const close = await Promise.race([
      closed,
      sleep(30000).then(() => ({ code: null, reason: "no close within 30 s" })),
    ]);
    const acknowledged = journal.identity.acknowledgedSeq;
    return {
      streamId,
      captured: sequence,
      capturedBytes,
      acknowledgedByServer: acknowledged,
      controlViewerReceived: healthy,
      slowViewerReceived: received,
      slowViewerBytesAfterPause: receivedBytes,
      eventsAtPause: pausedAtSeq,
      lastServerSeqReceived: lastSeq,
      bufferedEventsDeliveredAfterResume: lastSeq - pausedAtSeq,
      closeCode: close.code,
      closeReason: close.reason,
      serverBeforePause: serverStats(pausedAt - 3000, pausedAt),
      serverDuringPause,
      serverAfterResume: serverStats(publishedAt, wallNow()),
    };
  } finally {
    abort.abort(new Error("slow viewer phase ended"));
    await journal.close().catch(() => {});
  }
}

/** Open viewer sockets until the server sheds the upgrade. */
async function connectionCapacityProbe(origin, options, streamId) {
  if (!options.socketProbe) return null;
  if (!streamId) return { skipped: "no recording available" };
  const sockets = [];
  const started = performance.now();
  let opened = 0;
  let rejection = null;
  try {
    for (let i = 0; i < options.socketProbe; i++) {
      let ticket;
      try {
        ticket = await watchTicket(origin, streamId);
      } catch (error) {
        rejection = {
          at: opened,
          stage: "watch-ticket",
          status: error.status,
          body: error.body,
        };
        break;
      }
      const socket = openSocket(origin, ticket);
      sockets.push(socket);
      const outcome = await new Promise((resolve) => {
        socket.once("open", () => resolve({ ok: true }));
        socket.once("unexpected-response", (_request, response) => {
          let body = "";
          response.on(
            "data",
            (chunk) => (body += chunk.toString().slice(0, 200)),
          );
          response.on("end", () =>
            resolve({ ok: false, status: response.statusCode, body }),
          );
        });
        socket.once("error", (error) =>
          resolve({ ok: false, status: null, body: String(error.message) }),
        );
      });
      if (!outcome.ok) {
        rejection = { at: opened, stage: "upgrade", ...outcome };
        break;
      }
      opened++;
    }
  } finally {
    for (const socket of sockets)
      try {
        socket.terminate();
      } catch {
        /* already closed */
      }
  }
  return {
    attempted: options.socketProbe,
    openedBeforeRejection: opened,
    rejection,
    elapsedMs: round(performance.now() - started),
  };
}

/** Pin distinct recordings with subscribed sockets until the session cache sheds. */
async function sessionCacheProbe(origin, ownerSecret, options) {
  if (!options.cacheProbe) return null;
  const sockets = [];
  let pinned = 0;
  let rejection = null;
  const started = performance.now();
  try {
    for (let i = 0; i < options.cacheProbe; i++) {
      const response = await fetch(`${origin}/api/v1/streams`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          requestedAt: new Date().toISOString(),
          publisherId: randomUUID(),
          producerEpoch: randomUUID(),
          writeSecret: randomBytes(32).toString("hex"),
          title: `cache probe ${i}`,
          visibility: "public",
        }),
      });
      if (!response.ok) {
        rejection = {
          at: pinned,
          stage: "create",
          status: response.status,
          body: (await response.text()).slice(0, 200),
        };
        break;
      }
      const created = await response.json();
      let ticket;
      try {
        ticket = await watchTicket(origin, created.streamId);
      } catch (error) {
        rejection = {
          at: pinned,
          stage: "watch-ticket",
          status: error.status,
          body: error.body,
        };
        break;
      }
      const socket = openSocket(origin, ticket);
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      try {
        await subscribeRaw(socket, created.streamId, created.revision);
      } catch (error) {
        rejection = { at: pinned, stage: "subscribe", body: error.message };
        break;
      }
      pinned++;
    }
  } finally {
    for (const socket of sockets)
      try {
        socket.terminate();
      } catch {
        /* already closed */
      }
  }
  return {
    attempted: options.cacheProbe,
    pinnedBeforeRejection: pinned,
    rejection,
    elapsedMs: round(performance.now() - started),
  };
}

/* ------------------------------------------------------------------ entry */

if (flags.has("help")) console.log(HELP);
else if (flag("role") === "server") await runServer();
else if (flag("role") === "worker") await runWorker();
else await runDriver();
