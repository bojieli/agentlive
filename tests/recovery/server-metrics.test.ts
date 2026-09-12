import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  startServer,
  type ServerOptions,
} from "../../packages/server/src/http.js";

const require = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const cli = resolve("packages/cli/dist/main.js");
const ownerSecret = "c".repeat(64);
const writeSecret = "d".repeat(64);
const metricsToken = "metrics-token-" + "m".repeat(32);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task().catch(() => {});
});
async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function start(root: string, options: Partial<ServerOptions> = {}) {
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
    ...options,
  });
  cleanup.push(() => server.close());
  return server;
}
async function create(url: string, title: string, visibility = "private") {
  const response = await fetch(url + "/api/v1/streams", {
    method: "POST",
    headers: { ...bearer(ownerSecret), "content-type": "application/json" },
    body: JSON.stringify({
      requestId: `create-${randomBytes(4).toString("hex")}`,
      requestedAt: new Date().toISOString(),
      publisherId: "publisher_1",
      producerEpoch: "epoch_1",
      writeSecret,
      title,
      visibility,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { streamId: string; revision: string };
}
function connect(url: string, secret?: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: secret ? bearer(secret) : {},
  });
  cleanup.push(async () => ws.terminate());
  const inbox: any[] = [];
  const waiters: ((value: any) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    const value = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else inbox.push(value);
  });
  ws.on("error", () => {});
  return {
    ws,
    send: (value: unknown) => ws.send(JSON.stringify(value)),
    next: (): Promise<any> =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Frame timeout")),
              5000,
            );
            waiters.push((value) => {
              clearTimeout(timer);
              resolve(value);
            });
          }),
  };
}
async function publish(
  url: string,
  recording: { streamId: string; revision: string },
  text: string,
) {
  const client = connect(url + "/api/v1/publish", writeSecret);
  expect((await client.next()).type).toBe("hello");
  client.send({
    type: "resume",
    protocolVersion: 1,
    requestId: "resume",
    ...recording,
    publisherId: "publisher_1",
    producerEpoch: "epoch_1",
    attempt: 1,
  });
  expect((await client.next()).type).toBe("resumed");
  client.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "batch",
    events: [
      ["message.started", { messageId: "m", role: "assistant" }],
      ["message.text.append", { messageId: "m", text }],
    ].map(([kind, payload], index) => ({
      protocolVersion: 1,
      streamId: recording.streamId,
      producerEpoch: "epoch_1",
      producerSeq: index + 1,
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock_1",
      elapsedMs: index,
      fidelity: "delta",
      source: { agent: "synthetic", sessionId: "native_1" },
      content: { kind, payload },
    })),
  });
  expect((await client.next()).type).toBe("ack");
  return client;
}
async function subscribe(
  url: string,
  recording: { streamId: string; revision: string },
  secret?: string,
) {
  const client = connect(url + "/api/v1/watch", secret);
  expect((await client.next()).type).toBe("hello");
  client.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "subscribe",
    ...recording,
    afterServerSeq: 0,
  });
  expect((await client.next()).type).toBe("subscribed");
  return client;
}
function parse(text: string) {
  const samples = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z_]+(?:\{[^}]*\})?) (\S+)$/.exec(line);
    expect(match, line).toBeTruthy();
    samples.set(match![1]!, Number(match![2]));
  }
  return samples;
}
async function scrape(url: string, token = metricsToken) {
  const response = await fetch(url + "/metrics", { headers: bearer(token) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; version=0.0.4; charset=utf-8",
  );
  return response.text();
}

it("exposes authenticated content-free Prometheus metrics only when enabled", async () => {
  const root = await temporaryRoot("agentlive-metrics-");
  const disabled = await start(join(root, "disabled"));
  expect((await fetch(disabled.url + "/metrics")).status).toBe(404);
  expect(
    (await fetch(disabled.url + "/metrics", { headers: bearer(ownerSecret) }))
      .status,
  ).toBe(404);
  await expect(
    startServer({
      directory: join(root, "invalid"),
      ownerSecret,
      port: 0,
      metrics: { token: "short" },
    }),
  ).rejects.toThrow("Metrics token must be");

  const server = await start(join(root, "enabled"), {
    metrics: { token: metricsToken },
    storage: { maxStoredBytes: 1024 * 1024 },
  });
  const title = `metrics-title-${randomBytes(6).toString("hex")}`;
  const text = `metrics-event-${randomBytes(6).toString("hex")}`;
  const first = await create(server.url, title, "public");
  const second = await create(server.url, title);

  // Never anonymous; a recording credential or a wrong token is refused.
  for (const headers of [{}, bearer(writeSecret), bearer(metricsToken + "x")]) {
    const response = await fetch(server.url + "/metrics", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect((await response.json()).error.code).toBe("unauthorized");
  }

  const publisher = await publish(server.url, first, text);
  const viewer = await subscribe(server.url, first);
  // A declared upload beyond the server limit counts as a quota rejection.
  const refused = await fetch(
    `${server.url}/api/v1/streams/${first.streamId}/attachments`,
    {
      method: "POST",
      headers: {
        ...bearer(writeSecret),
        "x-attachment-sha256": createHash("sha256").update("x").digest("hex"),
        "x-attachment-bytes": String(2 * 1024 * 1024),
      },
      body: new Uint8Array(0),
    },
  );
  expect(refused.status).toBe(403);
  expect(
    (await fetch(`${server.url}/api/v1/streams/${first.streamId}`)).status,
  ).toBe(200);
  expect((await fetch(`${server.url}/no/such/${second.streamId}`)).status).toBe(
    404,
  );
  const removal = await fetch(
    `${server.url}/api/v1/recordings/${second.streamId}/removal`,
    {
      method: "POST",
      headers: { ...bearer(ownerSecret), "content-type": "application/json" },
      body: JSON.stringify({
        revision: second.revision,
        operationId: "remove-second",
      }),
    },
  );
  expect(removal.status).toBe(200);

  const output = await scrape(server.url);
  const metrics = parse(output);
  expect(metrics.get("agentlive_recordings")).toBe(1);
  expect(metrics.get("agentlive_recordings_open")).toBe(1);
  expect(metrics.get("agentlive_recordings_removed")).toBe(1);
  expect(metrics.get('agentlive_websocket_connections{role="publisher"}')).toBe(
    1,
  );
  expect(metrics.get('agentlive_websocket_connections{role="viewer"}')).toBe(1);
  expect(metrics.get("agentlive_storage_stored_bytes")).toBe(
    server.store.quotas.totals.storedBytes,
  );
  expect(metrics.get("agentlive_storage_stored_bytes")).toBeGreaterThan(0);
  expect(metrics.get("agentlive_storage_reserved_bytes")).toBe(0);
  expect(metrics.get("agentlive_storage_max_stored_bytes")).toBe(1024 * 1024);
  expect(metrics.has("agentlive_storage_min_free_bytes")).toBe(false);
  expect(
    metrics.get(
      'agentlive_quota_rejections_total{quota="maxStoredBytes",scope="global"}',
    ),
  ).toBe(1);
  expect(metrics.get("agentlive_cached_sessions")).toBeGreaterThanOrEqual(1);
  expect(metrics.get("agentlive_cached_sessions_capacity")).toBe(128);
  expect(metrics.get("agentlive_http_transfers_active")).toBe(0);
  expect(metrics.get("agentlive_http_requests_in_flight")).toBe(1);
  expect(metrics.get("agentlive_backups_in_progress")).toBe(0);
  expect(metrics.get("agentlive_write_barrier_paused")).toBe(0);
  expect(metrics.has("agentlive_snapshot_jobs")).toBe(true);
  expect(metrics.get("agentlive_snapshot_failures_total")).toBe(0);
  expect(metrics.get("agentlive_process_uptime_seconds")).toBeGreaterThan(0);
  expect(
    metrics.get("agentlive_process_resident_memory_bytes"),
  ).toBeGreaterThan(0);
  expect(
    metrics.get(
      'agentlive_http_requests_total{route="/api/v1/streams",method="POST",status_class="2xx"}',
    ),
  ).toBe(2);
  expect(
    metrics.get(
      'agentlive_http_requests_total{route="/api/v1/streams/:id",method="GET",status_class="2xx"}',
    ),
  ).toBe(1);
  expect(
    metrics.get(
      'agentlive_http_requests_total{route="/api/v1/streams/:id/attachments",method="POST",status_class="4xx"}',
    ),
  ).toBe(1);
  expect(
    metrics.get(
      'agentlive_http_requests_total{route="/metrics",method="GET",status_class="4xx"}',
    ),
  ).toBe(3);
  expect(
    metrics.get(
      'agentlive_http_requests_total{route="unmatched",method="GET",status_class="4xx"}',
    ),
  ).toBe(1);
  // No identifiers, titles, credentials or event content.
  for (const secret of [
    first.streamId,
    second.streamId,
    first.revision,
    title,
    text,
    ownerSecret,
    writeSecret,
    metricsToken,
  ])
    expect(output).not.toContain(secret);

  // The owner credential can also scrape; closed sockets are no longer counted.
  publisher.ws.close();
  viewer.ws.close();
  await expect
    .poll(async () => {
      const current = parse(await scrape(server.url, ownerSecret));
      return [
        current.get('agentlive_websocket_connections{role="publisher"}'),
        current.get('agentlive_websocket_connections{role="viewer"}'),
      ];
    })
    .toEqual([0, 0]);
}, 30_000);

it("never writes credentials, titles, cookies or event bodies to server logs or metrics", async () => {
  const root = await temporaryRoot("agentlive-metrics-logs-");
  const tag = randomBytes(6).toString("hex");
  const title = `title-sentinel-${tag}`;
  const text = `event-sentinel-${tag}`;
  const badToken = `badtoken-sentinel-${tag}`;
  const cookie = `cookie-sentinel-${tag}`;
  const body = `body-sentinel-${tag}`;
  const path = `path-sentinel-${tag}`;
  const child = spawn(
    process.execPath,
    [
      cli,
      "serve",
      "--state-dir",
      root,
      "--port",
      "0",
      "--metrics",
      "--max-stored-bytes",
      String(64 * 1024 * 1024),
      "--min-free-bytes",
      "1",
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        AGENTLIVE_OWNER_SECRET: ownerSecret,
        AGENTLIVE_METRICS_TOKEN: metricsToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code) => done(code)),
  );
  cleanup.push(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  await expect
    .poll(() => stdout.includes('"event":"ready"') || child.exitCode !== null, {
      timeout: 15_000,
    })
    .toBe(true);
  const url: string = JSON.parse(stdout.split("\n")[0]!).url;

  const recording = await create(url, title, "public");
  const publisher = await publish(url, recording, text);
  const data = Buffer.from(text);
  const uploaded = await fetch(
    `${url}/api/v1/streams/${recording.streamId}/attachments`,
    {
      method: "POST",
      headers: {
        ...bearer(writeSecret),
        "x-attachment-sha256": createHash("sha256").update(data).digest("hex"),
        "x-attachment-bytes": String(data.length),
      },
      body: data,
    },
  );
  expect(uploaded.status).toBe(201);
  const base = `${url}/api/v1/streams/${recording.streamId}`;
  expect((await fetch(base)).status).toBe(200);
  expect(
    (
      await fetch(
        `${base}/events?revision=${recording.revision}&throughServerSeq=3`,
      )
    ).status,
  ).toBe(200);
  const exported = await fetch(`${base}/export`, {
    headers: bearer(ownerSecret),
  });
  expect(exported.status).toBe(200);
  await exported.arrayBuffer();
  const ticket = await (
    await fetch(`${base}/watch-ticket`, {
      method: "POST",
      headers: bearer(ownerSecret),
    })
  ).json();
  const viewer = connect(`${url}/api/v1/watch?ticket=${ticket.ticket}`);
  expect((await viewer.next()).type).toBe("hello");
  viewer.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "sub",
    ...recording,
    afterServerSeq: 0,
  });
  expect((await viewer.next()).type).toBe("subscribed");
  // Rejected credentials, cookies, malformed bodies and unknown paths.
  for (const route of [
    "/api/v1/streams",
    "/api/v1/reports",
    "/api/v1/admin/accounts",
    `/api/v1/streams/${recording.streamId}/publisher-state`,
  ])
    await (
      await fetch(url + route, {
        headers: {
          ...bearer(badToken),
          cookie: `__Host-agentlive-session=${cookie}; other=${cookie}`,
        },
      })
    ).arrayBuffer();
  await (
    await fetch(url + "/api/v1/streams", {
      method: "POST",
      headers: { ...bearer(ownerSecret), "content-type": "application/json" },
      body: `{"title":"${body}",`,
    })
  ).arrayBuffer();
  await (
    await fetch(url + "/api/v1/admin/backup", {
      method: "POST",
      headers: { ...bearer(badToken), "content-type": "application/json" },
      body: JSON.stringify({ output: `/tmp/${body}` }),
    })
  ).arrayBuffer();
  await (await fetch(`${url}/${path}?q=${body}`)).arrayBuffer();
  const intruder = connect(url + "/api/v1/publish", badToken);
  expect((await intruder.next()).type).toBe("hello");
  intruder.send({ type: "resume", garbage: body });
  expect((await intruder.next()).type).toBe("error");
  intruder.ws.send(`not json ${body}`);
  expect((await intruder.next()).type).toBe("error");
  expect(
    (await fetch(url + "/metrics", { headers: bearer(badToken) })).status,
  ).toBe(401);
  const metrics = await scrape(url);
  expect(metrics).toContain("agentlive_storage_min_free_bytes 1");
  expect(metrics).toContain("agentlive_storage_max_stored_bytes 67108864");
  const removed = await fetch(
    `${url}/api/v1/recordings/${recording.streamId}/removal`,
    {
      method: "POST",
      headers: { ...bearer(ownerSecret), "content-type": "application/json" },
      body: JSON.stringify({
        revision: recording.revision,
        operationId: "remove-audit",
      }),
    },
  );
  expect(removed.status).toBe(200);
  publisher.ws.close();
  viewer.ws.close();
  intruder.ws.close();

  child.kill("SIGTERM");
  expect(await exited).toBe(143);
  // stdout carries only the ready line; nothing sensitive reaches either stream.
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "ready", url });
  for (const secret of [
    ownerSecret,
    writeSecret,
    metricsToken,
    badToken,
    cookie,
    title,
    text,
    body,
    path,
    recording.streamId,
    ticket.ticket,
  ]) {
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
    expect(metrics).not.toContain(secret);
  }
}, 60_000);
