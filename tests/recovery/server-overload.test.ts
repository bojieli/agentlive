import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { OverloadMonitor } from "../../packages/server/src/overload.js";

const require = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const ownerSecret = "0".repeat(64);
const metricsToken = "metrics-token-" + "v".repeat(32);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

const open = (url: string) =>
  new Promise<{ socket: any; closed: Promise<[number, string]> }>(
    (done, fail) => {
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${ownerSecret}` },
      });
      const closed = new Promise<[number, string]>((resolve) =>
        socket.once("close", (code: number, reason: Buffer) =>
          resolve([code, String(reason)]),
        ),
      );
      socket.once("open", () => done({ socket, closed }));
      socket.once("error", fail);
    },
  );

it("refuses new viewers, not publishers, once it is past its delivery capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-overload-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret,
    port: 0,
    metrics: { token: metricsToken },
    overload: { eventLoopDelayMs: 100, windowMs: 60_000, holdMs: 200 },
  });
  cleanup.push(() => server.close());
  const metrics = async () =>
    (
      await fetch(server.url + "/metrics", {
        headers: { authorization: `Bearer ${metricsToken}` },
      })
    ).text();
  const ready = () => fetch(server.url + "/readyz");

  expect((await ready()).status).toBe(200);
  expect(await metrics()).toContain("agentlive_delivery_overloaded 0");
  const before = await open(server.url + "/api/v1/watch");

  // A saturated event loop: delivery still happens, it is just behind.
  server.overload.simulateDelayMs(500);

  const response = await ready();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    ready: false,
    overloaded: true,
  });
  // Existing viewers keep their sockets: dropping them would only make it worse.
  expect(before.socket.readyState).toBe(1);
  // A new viewer is told explicitly rather than queued behind the backlog.
  await expect(open(server.url + "/api/v1/watch")).rejects.toThrow(
    "Unexpected server response: 503",
  );
  // A publisher is never refused; its capture is what the recording is for.
  const publisher = await open(server.url + "/api/v1/publish");
  expect(publisher.socket.readyState).toBe(1);
  publisher.socket.close();

  const text = await metrics();
  expect(text).toContain("agentlive_delivery_overloaded 1");
  expect(text).toContain("agentlive_delivery_refused_total 1");
  expect(text).toContain("agentlive_delivery_overload_episodes_total 1");

  // It recovers on its own once the measurement does, after the hold expires.
  server.overload.simulateDelayMs(0);
  await expect
    .poll(async () => (await ready()).status, { timeout: 5000 })
    .toBe(200);
  const after = await open(server.url + "/api/v1/watch");
  expect(after.socket.readyState).toBe(1);
  after.socket.close();
  before.socket.close();
  await before.closed;
}, 60000);

it("treats queued socket bytes in aggregate, and holds the signal steady", () => {
  let buffered = 0;
  const monitor = new OverloadMonitor({
    // Each socket stays far under its own 2 MiB shedding limit; only the sum of
    // sixteen of them crosses this.
    bufferedBytes: 16 * 1024 * 1024,
    windowMs: 60_000,
    holdMs: 500,
  });
  try {
    monitor.observeBuffered(() => buffered);
    expect(monitor.state.overloaded).toBe(false);
    buffered = 15 * 1024 * 1024;
    expect(monitor.state.overloaded).toBe(false);
    buffered = 16 * 1024 * 1024 + 1;
    expect(monitor.state).toMatchObject({ overloaded: true, episodes: 1 });
    expect(monitor.refuseViewer()).toBe(true);
    expect(monitor.state.refused).toBe(1);
    // It holds after the measurement recovers, so admission does not flap.
    buffered = 0;
    expect(monitor.state.overloaded).toBe(true);
    expect(monitor.refuseViewer()).toBe(true);
  } finally {
    monitor.close();
  }
});

it("clears the signal once the hold expires, and counts a second episode", async () => {
  let buffered = 1;
  const monitor = new OverloadMonitor({
    bufferedBytes: 1,
    windowMs: 60_000,
    holdMs: 1,
  });
  try {
    monitor.observeBuffered(() => buffered);
    buffered = 2;
    expect(monitor.state.overloaded).toBe(true);
    buffered = 0;
    await new Promise((done) => setTimeout(done, 5));
    expect(monitor.state).toMatchObject({ overloaded: false, episodes: 1 });
    buffered = 2;
    expect(monitor.state).toMatchObject({ overloaded: true, episodes: 2 });
  } finally {
    monitor.close();
  }
});
