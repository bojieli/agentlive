#!/usr/bin/env node
/**
 * Rehearse the documented HTTPS deployment on this machine.
 *
 * The real container image runs behind a real Caddy TLS reverse proxy
 * (deployment/compose.https.yaml), and every check below goes through the proxy
 * over HTTPS with certificate verification ON against the CA Caddy generated.
 * NODE_TLS_REJECT_UNAUTHORIZED is never touched: the probe passes the generated
 * root explicitly and trusts nothing else.
 *
 * The test hostname is resolved without touching /etc/hosts. Host-side clients
 * pass a `lookup` that returns 127.0.0.1 while keeping the real hostname in SNI,
 * in the Host header and in the certificate check; containers resolve the same
 * name through a Compose network alias on the proxy.
 *
 * Disposable throughout: its own Compose project, its own volumes, synthetic
 * content only, and every container, volume, network and temporary file removed
 * on success and on failure.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { request } from "node:https";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, rm, chmod, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

/** `ws` is the server package's own dependency; the probe speaks the same wire. */
const WebSocket = createRequire(
  new URL("../packages/server/package.json", import.meta.url),
)("ws");

const run = promisify(execFile);
const repo = resolve(new URL("..", import.meta.url).pathname);
const project = "agentlive-https-probe";
const host = process.env.AGENTLIVE_PROBE_HOST ?? "recordings.agentlive.test";
const httpsPort = Number(process.env.AGENTLIVE_HTTPS_PORT ?? 443);
const publicOrigin = `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
const outputDir = join(repo, "probe-results", "https");
/** The proxy's configured idle timeout (deployment/compose.https.yaml). The
 * quiet-viewer check waits comfortably past it rather than a token moment. */
const proxyIdleTimeoutMs = 20_000;
const quietViewerMs = Number(
  process.env.AGENTLIVE_PROBE_QUIET_MS ?? proxyIdleTimeoutMs * 3 + 5_000,
);
const attachmentBytes = 5 * 1024 * 1024;

const started = Date.now();
const checks = [];
let ca;
let ownerSecret;

/** Keep the hostname authentic while the packets go to the published port. */
const lookup = (_hostname, options, callback) =>
  options && options.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);

const docker = async (args, options = {}) =>
  (
    await run("docker", args, {
      cwd: repo,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...(options.env ?? {}) },
    })
  ).stdout;

const composeArgs = [
  "compose",
  "-p",
  project,
  "-f",
  "compose.yaml",
  "-f",
  "deployment/compose.https.yaml",
];
const compose = (args, options) =>
  docker([...composeArgs, ...args], {
    ...options,
    env: {
      AGENTLIVE_HTTPS_PORT: String(httpsPort),
      AGENTLIVE_PUBLIC_HOST: host,
      AGENTLIVE_PUBLIC_ORIGIN: publicOrigin,
      AGENTLIVE_CA_DIR: outputDir,
      ...(options?.env ?? {}),
    },
  });

/** One HTTPS request through the proxy, verified against the generated CA. */
function https(path, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let bodyChunks = 0;
    const req = request(
      {
        host,
        port: httpsPort,
        path,
        method: options.method ?? "GET",
        servername: host,
        ca,
        lookup,
        headers: {
          host: httpsPort === 443 ? host : `${host}:${httpsPort}`,
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        // Read while the socket is still attached to this response.
        const certificate = res.socket?.getPeerCertificate?.() ?? {};
        res.on("data", (chunk) => {
          bodyChunks++;
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            text: () => Buffer.concat(chunks).toString("utf8"),
            json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
            bodyChunks,
            certificate,
          }),
        );
      },
    );
    req.setTimeout(options.timeoutMs ?? 60_000, () =>
      req.destroy(new Error(`HTTPS timeout for ${path}`)),
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const owner = () => ({ authorization: `Bearer ${ownerSecret}` });

/** Fetch the same path from inside the server container over plain HTTP, to
 * prove the proxied bytes and headers are the server's own and unaltered. */
async function direct(path) {
  const raw = await compose([
    "exec",
    "-T",
    "agentlive",
    "node",
    "--input-type=module",
    "-e",
    `const r = await fetch("http://127.0.0.1:7331" + process.argv[1]);
     const body = Buffer.from(await r.arrayBuffer());
     process.stdout.write(JSON.stringify({
       status: r.status,
       headers: Object.fromEntries(r.headers),
       sha256: (await import("node:crypto")).createHash("sha256").update(body).digest("hex"),
       bytes: body.byteLength,
     }));`,
    path,
  ]);
  return JSON.parse(raw);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Run a shell script in a throwaway CLI container on the proxy's network. The
 * owner credential travels in the environment, never in argv. */
const client = (script) =>
  compose(
    [
      "--profile",
      "client",
      "run",
      "--rm",
      "-T",
      "--entrypoint",
      "sh",
      "client",
      "-c",
      script,
    ],
    { env: { AGENTLIVE_OWNER_SECRET: ownerSecret }, timeout: 300_000 },
  );

/** A raw protocol socket through the proxy. Frames are parsed as they arrive so
 * the checks can assert on order, counts and heartbeat liveness. */
function socket(path, { headers = {}, onFrame } = {}) {
  const ws = new WebSocket(`wss://${host}:${httpsPort}${path}`, {
    ca,
    lookup,
    servername: host,
    headers,
    handshakeTimeout: 20_000,
  });
  const state = {
    ws,
    frames: [],
    closed: false,
    closeInfo: undefined,
    error: undefined,
    lastSeen: Date.now(),
  };
  /** A proxy or host port forwarder can leave a half-open socket behind: the
   * peer is gone but no FIN arrives. The real clients notice the same way, by
   * the absence of the server's 20-second heartbeat. */
  state.stale = (ms = 35_000) => Date.now() - state.lastSeen > ms;
  state.drop = () => {
    ws.terminate();
    state.closed = true;
  };
  const waiters = [];
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  ws.on("message", (data) => {
    state.lastSeen = Date.now();
    const frame = JSON.parse(data.toString());
    state.frames.push(frame);
    onFrame?.(frame);
    notify();
  });
  ws.on("close", (code, reason) => {
    state.closed = true;
    state.closeInfo = { code, reason: reason.toString() };
    clearInterval(beat);
    notify();
  });
  ws.on("error", (error) => {
    state.error = error;
    notify();
  });
  // The protocol expects a client frame at least every 60 seconds; the real
  // publisher and subscriber both heartbeat every 20. A probe that stayed
  // literally silent would be closed by the server, not by the proxy.
  const beat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          protocolVersion: 1,
          requestId: "heartbeat",
        }),
      );
  }, 20_000);
  beat.unref();
  state.open = new Promise((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) =>
      reject(
        new Error(`WebSocket upgrade refused with HTTP ${res.statusCode}`),
      ),
    );
  });
  /** Wait for the first frame matching a predicate, from a given index on. */
  state.waitFor = (predicate, { timeoutMs = 30_000, from = 0 } = {}) =>
    new Promise((resolvePromise, reject) => {
      let index = from;
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting on ${path}; frames so far: ${state.frames
              .map((frame) => frame.type)
              .join(",")}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        const at = waiters.indexOf(check);
        if (at >= 0) waiters.splice(at, 1);
      };
      function check() {
        while (index < state.frames.length) {
          const frame = state.frames[index++];
          if (predicate(frame)) {
            cleanup();
            resolvePromise(frame);
            return;
          }
        }
        if (state.error) {
          cleanup();
          reject(state.error);
        } else if (state.closed) {
          cleanup();
          reject(
            new Error(
              `${path} closed (${state.closeInfo?.code} ${state.closeInfo?.reason}) before the expected frame`,
            ),
          );
        }
      }
      waiters.push(check);
      check();
    });
  state.send = (message) => ws.send(JSON.stringify(message));
  state.close = () =>
    new Promise((resolvePromise) => {
      if (ws.readyState === WebSocket.CLOSED) return resolvePromise();
      ws.once("close", () => resolvePromise());
      ws.close();
      setTimeout(() => {
        ws.terminate();
        resolvePromise();
      }, 3_000).unref();
    });
  return state;
}

/** A live publisher over the proxy that can survive the proxy or the server
 * restarting: it reconnects, resumes its lease and re-sends the last batch,
 * which the server deduplicates by producer sequence. */
class Publisher {
  constructor(streamId, revision, writeSecret) {
    this.streamId = streamId;
    this.revision = revision;
    this.writeSecret = writeSecret;
    this.publisherId = "probe-publisher";
    this.producerEpoch = "probe-epoch";
    this.attempt = 0;
    this.producerSeq = 0;
    this.sent = [];
    this.connection = undefined;
  }
  async connect() {
    this.attempt++;
    const connection = socket("/api/v1/publish", {
      headers: { authorization: `Bearer ${this.writeSecret}` },
    });
    await connection.open;
    await connection.waitFor((frame) => frame.type === "hello");
    connection.send({
      type: "resume",
      protocolVersion: 1,
      requestId: randomUUID().replaceAll("-", ""),
      streamId: this.streamId,
      revision: this.revision,
      publisherId: this.publisherId,
      producerEpoch: this.producerEpoch,
      attempt: this.attempt,
    });
    const resumed = await connection.waitFor(
      (frame) => frame.type === "resumed" || frame.type === "error",
    );
    if (resumed.type === "error")
      throw new Error(`Publisher resume refused: ${resumed.message}`);
    this.connection = connection;
    return resumed;
  }
  event(content) {
    this.producerSeq++;
    return {
      protocolVersion: 1,
      streamId: this.streamId,
      producerEpoch: this.producerEpoch,
      producerSeq: this.producerSeq,
      observedAt: new Date().toISOString(),
      clockSegmentId: "probe-segment",
      elapsedMs: this.producerSeq * 10,
      fidelity: "block",
      source: { agent: "synthetic", sessionId: "https-probe" },
      content:
        typeof content === "string"
          ? {
              kind: "message.text.append",
              payload: { messageId: "probe-message", text: content },
            }
          : content,
    };
  }
  /** Publish one batch and wait for its acknowledgement, reconnecting and
   * re-sending the identical batch if the socket dies underneath. */
  async publish(contents, { attempts = 4 } = {}) {
    const events = contents.map((content) => this.event(content));
    this.sent.push(...events);
    for (let tries = 1; ; tries++) {
      try {
        if (this.connection?.stale()) this.connection.drop();
        if (!this.connection || this.connection.closed) await this.connect();
        const requestId = randomUUID().replaceAll("-", "");
        const from = this.connection.frames.length;
        this.connection.send({
          type: "batch",
          protocolVersion: 1,
          requestId,
          events,
        });
        const ack = await this.connection.waitFor(
          (frame) =>
            (frame.type === "ack" || frame.type === "error") &&
            frame.requestId === requestId,
          { from, timeoutMs: 30_000 },
        );
        if (ack.type === "error")
          throw new Error(`Publish refused: ${ack.code} ${ack.message}`);
        return ack;
      } catch (error) {
        if (tries >= attempts) throw error;
        this.connection?.drop();
        this.connection = undefined;
        await delay(500 * tries);
      }
    }
  }
  close() {
    return this.connection?.close();
  }
}

/** A live viewer over the proxy that resumes from its last received sequence. */
class Viewer {
  constructor(streamId, revision) {
    this.streamId = streamId;
    this.revision = revision;
    /** Keyed by server sequence: the live socket and the catch-up pages both
     * land here, so ordering and duplication are both observable. */
    this.events = new Map();
    this.deliveries = 0;
    this.repeats = [];
    this.heartbeats = 0;
    this.connection = undefined;
    this.reconnects = 0;
    this.lastConnectError = undefined;
  }
  accept(event) {
    this.deliveries++;
    const existing = this.events.get(event.serverSeq);
    if (existing) {
      this.repeats.push(event.serverSeq);
      assert.deepEqual(
        existing,
        event,
        `server sequence ${event.serverSeq} was redelivered with different content`,
      );
      return;
    }
    this.events.set(event.serverSeq, event);
  }
  /** Highest sequence held with no gap below it: the only safe resume point. */
  cursor() {
    let at = 0;
    while (this.events.has(at + 1)) at++;
    return at;
  }
  async connect() {
    const ticket = (
      await https(`/api/v1/streams/${this.streamId}/watch-ticket`, {
        method: "POST",
        headers: owner(),
      })
    ).json();
    const from = this.cursor();
    const connection = socket(`/api/v1/watch?ticket=${ticket.ticket}`, {
      onFrame: (frame) => {
        if (frame.type === "heartbeat") this.heartbeats++;
        if (frame.type === "event") this.accept(frame.event);
      },
    });
    await connection.open;
    await connection.waitFor((frame) => frame.type === "hello");
    connection.send({
      type: "subscribe",
      protocolVersion: 1,
      requestId: randomUUID().replaceAll("-", ""),
      streamId: this.streamId,
      revision: this.revision,
      afterServerSeq: from,
    });
    const subscribed = await connection.waitFor(
      (frame) => frame.type === "subscribed" || frame.type === "error",
    );
    if (subscribed.type === "error")
      throw new Error(`Subscribe refused: ${subscribed.message}`);
    this.connection = connection;
    // A subscription is live-only from the boundary it reports; everything
    // between the cursor and that boundary is read over HTTP, exactly as the
    // real subscriber does. Without this a reconnecting viewer silently loses
    // every event published while it was disconnected.
    await this.catchUp(from, subscribed.boundary.sequence);
  }
  async catchUp(from, through) {
    let at = from;
    while (at < through) {
      const page = await https(
        `/api/v1/streams/${this.streamId}/events?revision=${this.revision}` +
          `&afterServerSeq=${at}&throughServerSeq=${through}&limit=1000`,
        { headers: owner() },
      );
      if (page.status !== 200)
        throw new Error(`Catch-up page failed with HTTP ${page.status}`);
      const rows = page
        .text()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (!rows.length) break;
      for (const event of rows) this.accept(event);
      at = Number(page.headers["x-agentlive-next-cursor"]);
      if (page.headers["x-agentlive-complete"] === "true") break;
    }
  }
  /** Wait until `count` publisher events have arrived, reconnecting if the
   * socket drops; the resumed cursor is what prevents loss and duplication. */
  async awaitPublished(count, { timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.publisherEvents().length < count) {
      if (Date.now() > deadline)
        throw new Error(
          `Viewer received ${this.publisherEvents().length} of ${count} published events after ${this.reconnects} reconnects` +
            (this.lastConnectError
              ? `; last reconnect error: ${this.lastConnectError}`
              : "") +
            `; socket closed=${this.connection?.closed} info=${JSON.stringify(this.connection?.closeInfo)}`,
        );
      if (
        !this.connection ||
        this.connection.closed ||
        this.connection.stale()
      ) {
        this.connection?.drop();
        this.connection = undefined;
        this.reconnects++;
        try {
          await this.connect();
        } catch (error) {
          this.lastConnectError = String(error?.message ?? error);
          await delay(500);
          continue;
        }
      }
      await Promise.race([
        this.connection.waitFor(() => this.publisherEvents().length >= count, {
          timeoutMs: Math.min(5_000, Math.max(250, deadline - Date.now())),
          from: 0,
        }),
        delay(1_000),
      ]).catch(() => {});
    }
    return this.publisherEvents();
  }
  publisherEvents() {
    return [...this.events.keys()]
      .sort((a, b) => a - b)
      .map((key) => this.events.get(key))
      .filter((event) => event.origin.type === "publisher");
  }
  close() {
    return this.connection?.close();
  }
}

/** Run one named check; a failure stops the run and the rest report as skipped. */
async function check(name, body) {
  const at = Date.now();
  try {
    const detail = await body();
    checks.push({
      name,
      status: "passed",
      ms: Date.now() - at,
      ...(detail ? { detail } : {}),
    });
    process.stderr.write(`  ok   ${name} (${Date.now() - at}ms)\n`);
  } catch (error) {
    checks.push({
      name,
      status: "failed",
      ms: Date.now() - at,
      error: String(error?.stack ?? error),
    });
    process.stderr.write(`  FAIL ${name}: ${error?.message ?? error}\n`);
    throw error;
  }
}

let failure;
const open = [];
/** An interrupt is neither success nor failure, and would otherwise strand the
 * containers and volumes; tear them down before leaving. */
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    compose(["down", "-v", "--remove-orphans", "-t", "15"], {
      timeout: 300_000,
    })
      .catch(() => {})
      .finally(() => {
        void rm(join(outputDir, "root.crt"), { force: true });
        void rm(join(outputDir, "source.jsonl"), { force: true });
        process.exit(130);
      });
  });
try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  // The image is built from the staged release, as in production.
  await access(join(repo, "dist", "package", "cli.mjs")).catch(() => {
    throw new Error("Run `pnpm package:build` before the HTTPS probe");
  });

  // A stale project from an interrupted run would otherwise reuse its volumes.
  await compose(["down", "-v", "--remove-orphans", "-t", "5"]).catch(() => {});
  process.stderr.write("building and starting the HTTPS stack\n");
  await compose(["up", "-d", "--build", "--wait", "--wait-timeout", "120"], {
    timeout: 900_000,
  });

  ca = Buffer.from(
    await compose([
      "exec",
      "-T",
      "caddy",
      "cat",
      "/data/caddy/pki/authorities/local/root.crt",
    ]),
  );
  await writeFile(join(outputDir, "root.crt"), ca, { mode: 0o600 });
  ownerSecret = JSON.parse(
    await compose(["exec", "-T", "agentlive", "cat", "/data/owner.json"]),
  ).secret;

  // Wait for the proxy to answer; Caddy issues its leaf certificate on startup.
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await https("/readyz", { timeoutMs: 5_000 })).status === 200) break;
    } catch (error) {
      if (attempt > 60) throw error;
    }
    await delay(500);
  }

  await check("proxy-terminates-tls-for-public-name", async () => {
    const response = await https("/readyz");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { ready: true });
    // Reaching this point already means the chain verified against the generated
    // root alone: `ca` replaces the default trust store, and the identity check
    // ran against the SNI name rather than the address actually dialled.
    // (Caddy issues leaves with an empty subject DN, so the name is in the SAN.)
    assert.ok(
      String(response.certificate.subjectaltname).includes(`DNS:${host}`),
      `certificate does not cover ${host}: ${response.certificate.subjectaltname}`,
    );
    assert.match(String(response.headers.via ?? ""), /Caddy/);
    return {
      issuer: response.certificate.issuer,
      subjectAltName: response.certificate.subjectaltname,
      via: response.headers.via,
    };
  });

  await check("server-reachable-only-through-proxy", async () => {
    const raw = (await compose(["ps", "--format", "json"])).trim();
    const ports = raw.startsWith("[")
      ? JSON.parse(raw)
      : raw
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    const server = ports.find((entry) => entry.Service === "agentlive");
    assert.ok(server, "agentlive service is not running");
    assert.equal(
      server.Publishers?.filter((p) => p.PublishedPort).length ?? 0,
      0,
      "the server container still publishes a host port behind the proxy",
    );
    return { serverPublishers: server.Publishers ?? [] };
  });

  await check("viewer-and-assets-survive-proxying", async () => {
    const routes = [
      ["/", "text/html; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "text/css; charset=utf-8"],
      ["/favicon.svg", "image/svg+xml"],
      ["/artifact-preview", "text/html; charset=utf-8"],
      ["/artifact-preview.js", "text/javascript; charset=utf-8"],
      ["/artifact-interactive", "text/html; charset=utf-8"],
    ];
    const sizes = {};
    for (const [path, contentType] of routes) {
      const proxied = await https(path);
      const inside = await direct(path);
      assert.equal(proxied.status, 200, `${path} returned ${proxied.status}`);
      assert.equal(proxied.headers["content-type"], contentType, path);
      assert.equal(
        sha256(proxied.body),
        inside.sha256,
        `${path} bytes differ between the server and the proxy`,
      );
      assert.equal(proxied.headers["content-encoding"], undefined, path);
      sizes[path] = proxied.body.byteLength;
    }
    assert.match((await https("/")).text(), /<html/);
    return sizes;
  });

  await check("security-headers-and-csps-unchanged", async () => {
    const compared = ["content-security-policy", "referrer-policy", "cache-control", "x-content-type-options"]; // prettier-ignore
    const policies = {};
    for (const path of ["/", "/artifact-preview", "/artifact-interactive"]) {
      const proxied = await https(path);
      const inside = await direct(path);
      for (const header of compared)
        assert.equal(
          proxied.headers[header],
          inside.headers[header],
          `${header} changed in transit on ${path}`,
        );
      assert.equal(proxied.headers["x-content-type-options"], "nosniff", path);
      assert.equal(proxied.headers["cache-control"], "no-store", path);
      assert.equal(proxied.headers["referrer-policy"], "no-referrer", path);
      policies[path] = proxied.headers["content-security-policy"];
    }
    // The artifact preview routes deliberately carry different policies from the
    // application; a proxy-wide policy would have flattened them into one.
    assert.equal(new Set(Object.values(policies)).size, 3);
    assert.match(policies["/"], /connect-src 'self'/);
    assert.match(policies["/artifact-preview"], /connect-src 'none'/);
    assert.match(policies["/artifact-interactive"], /script-src 'unsafe-inline' data:/); // prettier-ignore
    // Transport security is the proxy's to add and the only header it adds.
    assert.match(
      String((await https("/")).headers["strict-transport-security"]),
      /max-age=\d+/,
    );
    return policies;
  });

  await check("browser-origin-accepted-at-public-origin", async () => {
    const allowed = await https("/readyz", {
      headers: { origin: publicOrigin },
    });
    assert.equal(
      allowed.status,
      200,
      "the server rejects its own public origin; --public-origin is not configured",
    );
    const foreign = await https("/readyz", {
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(foreign.status, 403, "a foreign Origin was not rejected");
    // A browser always sends Origin on a WebSocket upgrade; this is the frame
    // the viewer actually uses.
    const browserLike = socket("/api/v1/watch", {
      headers: { origin: publicOrigin },
    });
    open.push(browserLike);
    await browserLike.open;
    await browserLike.waitFor((frame) => frame.type === "hello");
    await browserLike.close();
    return { foreignOriginStatus: foreign.status };
  });

  const marker = `HTTPS_PROXY_RECORDING_${randomBytes(6).toString("hex")}`;
  let imported;
  await check("private-import-and-replay-through-proxy", async () => {
    // Mounted read-only into the client container alongside the CA.
    await writeFile(
      join(outputDir, "source.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "https-probe",
        uuid: "row1",
        timestamp: "2026-09-01T00:00:00Z",
        message: { content: marker },
      }) + "\n",
      { mode: 0o600 },
    );
    // One container runs the whole publisher-side sequence. Its state directory
    // is the container's own tmpfs, so nothing of this run touches the host, and
    // it reaches the server only through the proxy under the public name.
    const output = await client(`
      set -e
      cli() { node /opt/agentlive/cli.mjs "$@" --state-dir /tmp/agentlive; }
      cli import --agent claude --source /run/ca/source.jsonl --server ${publicOrigin} | tee /tmp/imported.json
      id=$(node -e 'const rows=require("fs").readFileSync("/tmp/imported.json","utf8").trim().split("\\n").map(JSON.parse);process.stdout.write(rows.find(r=>r.streamId).streamId)')
      cli status
      cli replay --stream "$id" --server ${publicOrigin}
    `);
    const lines = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    imported = lines.find((line) => line.event === "imported");
    assert.ok(imported?.streamId, `no recording in client output: ${output}`);
    assert.equal(imported.visibility, "private");
    // The CLI reports the URL a viewer should open. Behind the proxy that has to
    // be the HTTPS public origin, never a loopback or container address.
    const binding = lines
      .find((line) => line.bindings)
      ?.bindings.find((entry) => entry.streamId === imported.streamId);
    assert.ok(binding, `no publisher binding reported: ${output}`);
    assert.equal(binding.serverOrigin, publicOrigin);
    assert.equal(
      binding.viewerUrl,
      `${publicOrigin}/?stream=${imported.streamId}`,
    );
    assert.match(output, new RegExp(marker));
    return { streamId: imported.streamId, viewerUrl: binding.viewerUrl };
  });

  await check("private-recording-stays-private-through-proxy", async () => {
    const anonymous = await https(`/api/v1/streams/${imported.streamId}`);
    assert.ok(
      [401, 403, 404].includes(anonymous.status),
      `an unauthenticated reader got HTTP ${anonymous.status}`,
    );
    const authorized = await https(`/api/v1/streams/${imported.streamId}`, {
      headers: owner(),
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.json().visibility, "private");
    return { anonymousStatus: anonymous.status };
  });

  // A live recording for every WebSocket, attachment and restart check below.
  const writeSecret = randomBytes(32).toString("hex");
  const created = await https("/api/v1/streams", {
    method: "POST",
    headers: { ...owner(), "content-type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID().replaceAll("-", ""),
      requestedAt: new Date().toISOString(),
      publisherId: "probe-publisher",
      producerEpoch: "probe-epoch",
      writeSecret,
      title: "HTTPS proxy rehearsal",
      visibility: "private",
    }),
  });
  assert.equal(created.status, 201, created.text());
  const live = created.json();
  const publisher = new Publisher(live.streamId, live.revision, writeSecret);
  const viewer = new Viewer(live.streamId, live.revision);

  await check("websocket-publisher-and-viewer-concurrently", async () => {
    await Promise.all([publisher.connect(), viewer.connect()]);
    await publisher.publish(["alpha", "bravo", "charlie"]);
    await publisher.publish(["delta", "echo"]);
    const seen = await viewer.awaitPublished(publisher.sent.length);
    assert.deepEqual(
      seen.map((event) => event.origin.event.content.payload.text),
      ["alpha", "bravo", "charlie", "delta", "echo"],
    );
    assert.deepEqual(
      seen.map((event) => event.origin.event.producerSeq),
      [1, 2, 3, 4, 5],
    );
    return { delivered: seen.length };
  });

  await check("quiet-viewer-outlives-proxy-idle-timeout", async () => {
    const before = viewer.heartbeats;
    const frames = viewer.connection.frames.length;
    process.stderr.write(
      `       holding a silent viewer for ${Math.round(quietViewerMs / 1000)}s against a ${proxyIdleTimeoutMs / 1000}s proxy idle timeout\n`,
    );
    await delay(quietViewerMs);
    assert.equal(
      viewer.connection.closed,
      false,
      `the viewer socket closed after ${quietViewerMs}ms of client silence: ${JSON.stringify(viewer.connection.closeInfo)}`,
    );
    const heartbeats = viewer.heartbeats - before;
    // Server heartbeats every 20s; if the proxy buffered them none would arrive.
    assert.ok(
      heartbeats >= 2,
      `only ${heartbeats} heartbeats crossed the proxy in ${quietViewerMs}ms`,
    );
    await publisher.publish(["after-idle"]);
    const seen = await viewer.awaitPublished(publisher.sent.length);
    assert.equal(seen.at(-1).origin.event.content.payload.text, "after-idle");
    return { quietMs: quietViewerMs, heartbeats, frames };
  });

  await check("attachment-streams-through-proxy", async () => {
    const payload = randomBytes(attachmentBytes);
    const hash = sha256(payload);
    const uploaded = await https(
      `/api/v1/streams/${live.streamId}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${writeSecret}`,
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
          "x-attachment-sha256": hash,
          "x-attachment-bytes": String(payload.byteLength),
        },
        body: payload,
        timeoutMs: 120_000,
      },
    );
    assert.equal(uploaded.status, 201, uploaded.text());
    // Only a published attachment is downloadable: the recording has to carry
    // the availability event before the blob is readable.
    await publisher.publish([
      {
        kind: "attachment.available",
        payload: {
          attachment: {
            artifactId: "probe-artifact",
            version: 1,
            hash,
            filename: "probe-attachment.bin",
            mediaType: "application/octet-stream",
            byteSize: payload.byteLength,
          },
        },
      },
    ]);
    const downloaded = await https(
      `/api/v1/streams/${live.streamId}/attachments/${hash}`,
      { headers: owner(), timeoutMs: 120_000 },
    );
    assert.equal(downloaded.status, 200);
    assert.equal(sha256(downloaded.body), hash, "attachment bytes changed");
    assert.equal(
      Number(downloaded.headers["content-length"]),
      payload.byteLength,
    );
    assert.equal(downloaded.headers["content-encoding"], undefined);
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    // Delivered progressively rather than buffered whole by the proxy.
    assert.ok(
      downloaded.bodyChunks > 1,
      "the attachment arrived as a single buffered chunk",
    );
    return { bytes: payload.byteLength, chunks: downloaded.bodyChunks };
  });

  await check("short-link-and-public-viewer-url", async () => {
    const short = await https(`/s/${live.streamId}`);
    assert.equal(short.status, 302);
    assert.equal(short.headers.location, `/?stream=${live.streamId}`);
    assert.equal(short.headers["referrer-policy"], "no-referrer");
    const followed = await https(short.headers.location);
    assert.equal(followed.status, 200);
    // The server's own startup report must name the public origin, not the
    // container address it is bound to.
    const ready = (await compose(["logs", "--no-log-prefix", "agentlive"]))
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "ready");
    assert.ok(ready, "no ready event in the server log");
    assert.deepEqual(ready.viewerUrls, [`${publicOrigin}/`]);
    assert.equal(ready.reachability, "public-origin");
    assert.ok(
      !JSON.stringify(ready.viewerUrls).includes("127.0.0.1"),
      "the server reports loopback viewer URLs while served over HTTPS",
    );
    return { ready: { viewerUrls: ready.viewerUrls, url: ready.url } };
  });

  await check("publisher-and-viewer-recover-from-proxy-restart", async () => {
    await compose(["restart", "-t", "10", "caddy"], { timeout: 120_000 });
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await https("/readyz", { timeoutMs: 5_000 })).status === 200)
          break;
      } catch (error) {
        if (attempt > 60) throw error;
      }
      await delay(500);
    }
    await publisher.publish(["after-proxy-restart-1"]);
    await publisher.publish(["after-proxy-restart-2"]);
    const seen = await viewer.awaitPublished(publisher.sent.length, {
      timeoutMs: 150_000,
    });
    assert.equal(seen.at(-1).origin.event.content.payload.text, "after-proxy-restart-2"); // prettier-ignore
    return { publisherAttempts: publisher.attempt, delivered: seen.length };
  });

  await check("publisher-and-viewer-recover-from-server-restart", async () => {
    await compose(["restart", "-t", "50", "agentlive"], { timeout: 180_000 });
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await https("/readyz", { timeoutMs: 5_000 })).status === 200)
          break;
      } catch (error) {
        if (attempt > 120) throw error;
      }
      await delay(500);
    }
    await publisher.publish(["after-server-restart-1"], { attempts: 8 });
    await publisher.publish(["after-server-restart-2"], { attempts: 8 });
    const seen = await viewer.awaitPublished(publisher.sent.length, {
      timeoutMs: 150_000,
    });
    assert.equal(seen.at(-1).origin.event.content.payload.text, "after-server-restart-2"); // prettier-ignore
    return { publisherAttempts: publisher.attempt, delivered: seen.length };
  });

  await check("no-events-lost-or-duplicated-across-restarts", async () => {
    // What the live viewer saw, and what the durable history holds, must both be
    // exactly the events the publisher sent, once each, in order.
    // The server stores events with canonical key order; compare on content, not
    // on the key order the probe happened to write.
    const identity = (value) =>
      JSON.stringify(value, (_key, inner) =>
        inner && typeof inner === "object" && !Array.isArray(inner)
          ? Object.fromEntries(
              Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
            )
          : inner,
      );
    const expected = publisher.sent.map((event) => identity(event.content));
    const delivered = viewer
      .publisherEvents()
      .map((event) => identity(event.origin.event.content));
    assert.deepEqual(delivered, expected, "live delivery lost or duplicated");
    const info = await https(`/api/v1/streams/${live.streamId}`, {
      headers: owner(),
    });
    assert.equal(info.status, 200, info.text());
    const through = info.json().serverSeq;
    const history = [];
    let cursor = 0;
    while (cursor < through) {
      const page = await https(
        `/api/v1/streams/${live.streamId}/events?revision=${live.revision}` +
          `&afterServerSeq=${cursor}&throughServerSeq=${through}&limit=1000`,
        { headers: owner() },
      );
      assert.equal(page.status, 200, page.text());
      const rows = page
        .text()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (!rows.length) break;
      history.push(...rows);
      cursor = Number(page.headers["x-agentlive-next-cursor"]);
      if (page.headers["x-agentlive-complete"] === "true") break;
    }
    const stored = history
      .filter((event) => event.origin.type === "publisher")
      .map((event) => event.origin.event);
    assert.deepEqual(
      stored.map((event) => identity(event.content)),
      expected,
      "durable history lost or duplicated events",
    );
    assert.deepEqual(
      stored.map((event) => event.producerSeq),
      expected.map((_, index) => index + 1),
    );
    assert.equal(
      new Set(history.map((event) => event.serverSeq)).size,
      history.length,
      "duplicate server sequences in history",
    );
    await publisher.close();
    await viewer.close();
    return {
      published: expected.length,
      storedEvents: history.length,
      liveDeliveries: viewer.deliveries,
      // Benign overlap between a catch-up page and the live socket after a
      // reconnect; every repeat was byte-identical (accept() asserts that).
      repeatedSequences: viewer.repeats.length,
      viewerReconnects: viewer.reconnects,
      publisherAttempts: publisher.attempt,
    };
  });
} catch (error) {
  failure = error;
} finally {
  for (const connection of open) await connection.close?.().catch(() => {});
  const report = {
    success: !failure,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    publicOrigin,
    proxy: "caddy:2.11.4-alpine, tls internal",
    composeFiles: ["compose.yaml", "deployment/compose.https.yaml"],
    quietViewerMs,
    attachmentBytes,
    checks: checks.map((entry) => entry.name),
    results: checks,
    ...(failure ? { error: String(failure?.stack ?? failure) } : {}),
  };
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(outputDir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {}
  // Containers, networks and volumes, on success and on failure alike.
  await compose(["down", "-v", "--remove-orphans", "-t", "15"], {
    timeout: 300_000,
  }).catch(() => {});
  for (const name of ["root.crt", "source.jsonl"])
    await rm(join(outputDir, name), { force: true });
  await chmod(join(outputDir, "report.json"), 0o600).catch(() => {});
  process.stdout.write(
    JSON.stringify({
      probe: "https",
      success: report.success,
      durationMs: report.durationMs,
      publicOrigin,
      checks: checks.map(({ name, status }) => ({ name, status })),
      report: "probe-results/https/report.json",
      ...(failure ? { error: String(failure?.message ?? failure) } : {}),
    }) + "\n",
  );
  if (failure) process.exitCode = 1;
}
