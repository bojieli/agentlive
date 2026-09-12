import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  startServer,
  type ServerOptions,
} from "../../packages/server/src/http.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import { AccountQuotas } from "../../packages/server/src/quotas.js";
import { FreeSpaceFloor } from "../../packages/server/src/free-space.js";

const require = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const ownerSecret = "a".repeat(64);
const writeSecret = "b".repeat(64);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const password = "p".repeat(64),
  issuer = "https://id.example",
  origin = "https://app.example";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task().catch(() => {});
});
async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
type Server = Awaited<ReturnType<typeof startServer>>;
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
function hosted(): Partial<ServerOptions> {
  return {
    publicOrigin: origin,
    hosted: {
      issuer,
      clientId: "client",
      clientSecret: "secret",
      cookiePassword: password,
      fetch: async () =>
        Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
    },
  };
}
async function create(server: Server, credential: string, requestId: string) {
  return fetch(server.url + "/api/v1/streams", {
    method: "POST",
    headers: { ...bearer(credential), "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      requestedAt: new Date().toISOString(),
      publisherId: "publisher_1",
      producerEpoch: "epoch_1",
      writeSecret,
      title: requestId,
      visibility: "private",
    }),
  });
}
async function created(server: Server, credential: string, requestId: string) {
  const response = await create(server, credential, requestId);
  expect(response.status).toBe(201);
  return (await response.json()) as { streamId: string; revision: string };
}
/** Upload `bytes` random bytes; `refused` declares the size but sends no body
 * (the server refuses by declared size before reading, so a large body would
 * race the early response). */
function upload(
  server: Server,
  streamId: string,
  bytes: number,
  refused = false,
) {
  const data = randomBytes(bytes);
  return fetch(`${server.url}/api/v1/streams/${streamId}/attachments`, {
    method: "POST",
    headers: {
      ...bearer(writeSecret),
      "x-attachment-sha256": createHash("sha256").update(data).digest("hex"),
      "x-attachment-bytes": String(bytes),
    },
    body: refused ? new Uint8Array(0) : data,
  });
}
function remove(
  server: Server,
  credential: string,
  recording: { streamId: string; revision: string },
) {
  return fetch(
    `${server.url}/api/v1/recordings/${recording.streamId}/removal`,
    {
      method: "POST",
      headers: { ...bearer(credential), "content-type": "application/json" },
      body: JSON.stringify({
        revision: recording.revision,
        operationId: `remove-${randomBytes(4).toString("hex")}`,
      }),
    },
  );
}
function importArchive(
  server: Server,
  credential: string,
  archive: Buffer,
  key: string,
) {
  return fetch(server.url + "/api/v1/imports", {
    method: "POST",
    headers: {
      ...bearer(credential),
      "content-type": "application/octet-stream",
      "idempotency-key": key,
    },
    body: archive,
  });
}
async function expectQuota(
  response: Response,
  quota: string,
  scope: "global" | "account",
) {
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.error.code).toBe("quota_exceeded");
  expect(body.error.details).toMatchObject({ quota, scope });
  expect(body.error.message).toMatch(/quota exceeded/);
  return body.error;
}
const stored = (server: Server) => server.store.quotas.totals.storedBytes;

function connect(url: string, secret: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: bearer(secret),
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
  return {
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
async function publisher(server: Server, streamId: string, revision: string) {
  const client = connect(server.url + "/api/v1/publish", writeSecret);
  expect((await client.next()).type).toBe("hello");
  client.send({
    type: "resume",
    protocolVersion: 1,
    requestId: "resume",
    streamId,
    revision,
    publisherId: "publisher_1",
    producerEpoch: "epoch_1",
    attempt: 1,
  });
  expect((await client.next()).type).toBe("resumed");
  let seq = 0;
  return {
    async batch(texts: string[]) {
      const events = texts.map((text) => {
        seq++;
        return {
          protocolVersion: 1,
          streamId,
          producerEpoch: "epoch_1",
          producerSeq: seq,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock_1",
          elapsedMs: seq,
          fidelity: "delta",
          source: { agent: "synthetic", sessionId: "native_1" },
          content:
            seq === 1
              ? {
                  kind: "message.started",
                  payload: { messageId: "m", role: "assistant" },
                }
              : {
                  kind: "message.text.append",
                  payload: { messageId: "m", text },
                },
        };
      });
      client.send({
        type: "batch",
        protocolVersion: 1,
        requestId: `batch-${seq}`,
        events,
      });
      const reply = await client.next();
      if (reply.type !== "ack") seq -= texts.length;
      return reply;
    },
  };
}

it("caps total stored bytes for the local owner across creation, uploads, publisher batches and imports, frees on removal and recomputes after restart", async () => {
  const root = await temporaryRoot("agentlive-storage-global-");
  const limit = 384 * 1024;
  let server = await start(root, { storage: { maxStoredBytes: limit } });
  expect(server.store.quotas.storageLimits.maxStoredBytes).toBe(limit);

  const first = await created(server, ownerSecret, "first");
  expect(stored(server)).toBeGreaterThan(0);
  expect((await upload(server, first.streamId, 32 * 1024)).status).toBe(201);
  // A declared size beyond the server limit is refused before the body is read.
  const refusedUpload = await expectQuota(
    await upload(server, first.streamId, 512 * 1024, true),
    "maxStoredBytes",
    "global",
  );
  expect(refusedUpload.details).toMatchObject({
    limit,
    requested: 512 * 1024,
  });
  // Server-wide usage is not disclosed in the error.
  expect(refusedUpload.details.used).toBeUndefined();

  // Publisher batches that fit are acknowledged; one that does not is refused whole.
  // A stored event keeps its content and the published original, so each 8 KiB
  // text stores about 16 KiB.
  const pub = await publisher(server, first.streamId, first.revision);
  const texts = (count: number, fill: string) =>
    Array.from({ length: count }, () => fill.repeat(8 * 1024));
  expect(await pub.batch(["", ...texts(12, "x")])).toMatchObject({
    type: "ack",
  });
  const beforeBatch = stored(server);
  expect(beforeBatch).toBeGreaterThan(200 * 1024);
  const refusedBatch = await pub.batch(texts(14, "y"));
  expect(refusedBatch).toMatchObject({
    type: "error",
    code: "quota_exceeded",
    details: { quota: "maxStoredBytes", scope: "global" },
  });
  expect(stored(server)).toBe(beforeBatch);
  const session = await server.store.get(first.streamId);
  try {
    expect(session.boundary.sequence).toBe(14);
  } finally {
    server.store.release(session);
  }

  // Importing a copy of the recording (over 200 KiB of log) exceeds the limit.
  const archive = Buffer.from(
    await (
      await fetch(`${server.url}/api/v1/streams/${first.streamId}/export`, {
        headers: bearer(ownerSecret),
      })
    ).arrayBuffer(),
  );
  await expectQuota(
    await importArchive(server, ownerSecret, archive, "i1"),
    "maxStoredBytes",
    "global",
  );
  expect(server.store.quotas.totals).toMatchObject({
    recordings: 1,
    reservedBytes: 0,
  });

  // Fill the remaining headroom; creation needs 4 KiB and is then refused too.
  const headroom = limit - stored(server) - 2048;
  expect((await upload(server, first.streamId, headroom)).status).toBe(201);
  await expectQuota(
    await create(server, ownerSecret, "second"),
    "maxStoredBytes",
    "global",
  );
  expect(stored(server)).toBeLessThanOrEqual(limit);
  const full = stored(server);

  // A restart recomputes identical usage and keeps enforcing the limit.
  await server.close();
  server = await start(root, { storage: { maxStoredBytes: limit } });
  expect(stored(server)).toBe(full);
  expect(server.store.quotas.totals).toMatchObject({
    recordings: 1,
    activeRecordings: 1,
  });
  await expectQuota(
    await create(server, ownerSecret, "second"),
    "maxStoredBytes",
    "global",
  );

  // Removal releases the recording's bytes immediately; the import now fits.
  const info = await (
    await fetch(`${server.url}/api/v1/streams/${first.streamId}`, {
      headers: bearer(ownerSecret),
    })
  ).json();
  expect(
    (
      await remove(server, ownerSecret, {
        streamId: first.streamId,
        revision: info.revision,
      })
    ).status,
  ).toBe(200);
  expect(stored(server)).toBe(0);
  expect((await importArchive(server, ownerSecret, archive, "i1")).status).toBe(
    201,
  );
  expect(stored(server)).toBeGreaterThan(200 * 1024);
  expect((await create(server, ownerSecret, "second")).status).toBe(201);

  // Without a configured limit the local owner is unlimited.
  await server.close();
  server = await start(root);
  expect((await upload(server, first.streamId, 1)).status).toBe(404);
  const third = await created(server, ownerSecret, "third");
  expect((await upload(server, third.streamId, 512 * 1024)).status).toBe(201);

  await expect(
    startServer({
      directory: join(root, "invalid"),
      ownerSecret,
      port: 0,
      storage: { maxStoredBytes: 100 },
    }),
  ).rejects.toThrow("Invalid server storage limit configuration");
}, 60_000);

it("checks account and server-wide limits together for hosted accounts", async () => {
  const root = await temporaryRoot("agentlive-storage-combined-");
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const account = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "storage-combined",
    displayName: "Combined",
  });
  const device = await sessions.issueDevice(account.id);
  await sessions.close();
  await accounts.close();
  const server = await start(root, {
    ...hosted(),
    quotas: { maxStoredBytesPerAccount: 160 * 1024 },
    storage: { maxStoredBytes: 200 * 1024 },
  });

  // The local owner is not account-limited but consumes server-wide bytes.
  const local = await created(server, ownerSecret, "local");
  expect((await upload(server, local.streamId, 96 * 1024)).status).toBe(201);

  const mine = await created(server, device.token, "mine");
  expect((await upload(server, mine.streamId, 64 * 1024)).status).toBe(201);
  // Within the account limit but beyond the server limit.
  const global = await expectQuota(
    await upload(server, mine.streamId, 64 * 1024, true),
    "maxStoredBytes",
    "global",
  );
  expect(global.details.accountId).toBeUndefined();

  // Removing the local recording frees server-wide bytes for the account.
  const info = await (
    await fetch(`${server.url}/api/v1/streams/${local.streamId}`, {
      headers: bearer(ownerSecret),
    })
  ).json();
  expect(
    (
      await remove(server, ownerSecret, {
        streamId: local.streamId,
        revision: info.revision,
      })
    ).status,
  ).toBe(200);
  expect((await upload(server, mine.streamId, 64 * 1024)).status).toBe(201);
  // Now the account limit is the binding one.
  const perAccount = await expectQuota(
    await upload(server, mine.streamId, 64 * 1024, true),
    "maxStoredBytesPerAccount",
    "account",
  );
  expect(perAccount.details.accountId).toBe(account.id);
  expect(server.store.quotas.usage(account.id).storedBytes).toBe(
    server.store.quotas.totals.storedBytes,
  );
}, 60_000);

it("reserves concurrently against the server-wide limit across owners", () => {
  const quotas = new AccountQuotas(
    { maxStoredBytesPerAccount: 10_000 },
    { maxStoredBytes: 12_000 },
  );
  quotas.reserveRecording("local", { bytes: 0, open: true }).commit("l", 0);
  quotas.reserveRecording("account", { bytes: 0, open: true }).commit("a", 0);
  const local = quotas.forRecording("l", "local");
  const account = quotas.forRecording("a", "account");
  // The local owner is exempt from the per-account limit ...
  const big = local.reserveBytes(11_000);
  // ... and its pending reservation counts against every other writer.
  expect(() => account.reserveBytes(2_000)).toThrow(/Server storage quota/);
  big.release();
  const pending = account.reserveBytes(9_000);
  expect(() => local.reserveBytes(4_000)).toThrow(/Server storage quota/);
  expect(() => account.reserveBytes(1_001)).toThrow(/Account storage quota/);
  pending.commit(9_000);
  expect(quotas.totals).toMatchObject({ storedBytes: 9_000, reservedBytes: 0 });
  expect(local.reserveBytes(3_000)).toBeDefined();
  expect(quotas.totals.rejections).toEqual(
    expect.arrayContaining([
      { quota: "maxStoredBytes", scope: "global", count: 2 },
      { quota: "maxStoredBytesPerAccount", scope: "account", count: 1 },
    ]),
  );
});

it("refuses growth below the free-space floor, reports not-ready and recovers", async () => {
  const root = await temporaryRoot("agentlive-storage-floor-");
  const floor = 1024 * 1024;
  let free = 100 * 1024 * 1024;
  let mode: "ok" | "fail" | "stall" = "ok";
  let server: Server | undefined;
  let stalled: (() => void) | undefined;
  const probes: string[] = [];
  // Simulated filesystem: configured free space minus what the server stores.
  const statfs = async (directory: string) => {
    probes.push(directory);
    if (mode === "fail") throw new Error("statfs failed");
    if (mode === "stall")
      await new Promise<void>((resolve) => {
        stalled = resolve;
      });
    const used = server?.store.quotas.totals.storedBytes ?? 0;
    return { bavail: BigInt(Math.max(0, free - used)), bsize: 1n };
  };
  server = await start(root, { storage: { minFreeBytes: floor, statfs } });
  expect(probes[0]).toBe(root);
  const ready = async () => (await fetch(server!.url + "/readyz")).status;
  expect(await ready()).toBe(200);
  const recording = await created(server, ownerSecret, "floor");

  // Leave exactly 40 KiB above the floor.
  free = floor + 40 * 1024 + stored(server);
  expect(await ready()).toBe(200);
  expect((await upload(server, recording.streamId, 32 * 1024)).status).toBe(
    201,
  );
  // The committed upload is subtracted even before the next filesystem sample.
  const refused = await expectQuota(
    await upload(server, recording.streamId, 16 * 1024, true),
    "minFreeBytes",
    "global",
  );
  expect(refused.details).toEqual({
    quota: "minFreeBytes",
    scope: "global",
    limit: floor,
    requested: 16 * 1024,
  });
  const pub = await publisher(server, recording.streamId, recording.revision);
  expect((await pub.batch([""])).type).toBe("ack");
  expect(
    await pub.batch(Array.from({ length: 4 }, () => "z".repeat(4 * 1024))),
  ).toMatchObject({
    type: "error",
    code: "quota_exceeded",
    details: { quota: "minFreeBytes", scope: "global" },
  });

  // Below the floor: not ready, creation and import prechecks are refused, reads work.
  free = floor - 1 + stored(server);
  expect(await ready()).toBe(503);
  await expectQuota(
    await create(server, ownerSecret, "refused"),
    "minFreeBytes",
    "global",
  );
  await expectQuota(
    await importArchive(server, ownerSecret, Buffer.from("x"), "refused"),
    "minFreeBytes",
    "global",
  );
  expect(
    (
      await fetch(`${server.url}/api/v1/streams/${recording.streamId}`, {
        headers: bearer(ownerSecret),
      })
    ).status,
  ).toBe(200);

  // A failing probe keeps the last sample for admission and reports not-ready.
  free = 100 * 1024 * 1024;
  mode = "fail";
  expect(await ready()).toBe(503);
  await expectQuota(
    await create(server, ownerSecret, "refused"),
    "minFreeBytes",
    "global",
  );
  mode = "ok";
  expect(await ready()).toBe(200);
  expect((await create(server, ownerSecret, "recovered")).status).toBe(201);

  // A stalled probe bounds readiness waits and fails once the sample is stale.
  mode = "stall";
  const startedAt = Date.now();
  await expect.poll(ready, { timeout: 8000, interval: 200 }).toBe(503);
  expect(Date.now() - startedAt).toBeLessThan(8000);
  const probeCount = probes.length;
  expect(await ready()).toBe(503);
  expect(probes.length).toBe(probeCount); // no probe backlog while stalled
  mode = "ok";
  stalled?.();
  await expect.poll(ready, { timeout: 5000, interval: 100 }).toBe(200);
  expect(server.store.quotas.freeSpace?.status).toMatchObject({
    minFreeBytes: floor,
    probeFailed: false,
  });
}, 60_000);

it("admits before the first successful sample and subtracts pending reservations", async () => {
  let available = 0n;
  let fail = true;
  const floor = new FreeSpaceFloor("/x", 1000, async () => {
    if (fail) throw new Error("unavailable");
    return { bavail: available, bsize: 1n };
  });
  await floor.refresh();
  expect(() => floor.admit(10 ** 9, 0)).not.toThrow();
  expect(await floor.ready()).toBe(false);
  fail = false;
  available = 5000n;
  await floor.refresh();
  expect(() => floor.admit(4000, 0)).not.toThrow();
  expect(() => floor.admit(2000, 2001)).toThrow(/quota exceeded/);
  floor.grew(3000);
  expect(() => floor.admit(1001, 0)).toThrow(/quota exceeded/);
  expect(() => floor.admit(1000, 0)).not.toThrow();
  expect(() => floor.admit(0, 10 ** 9)).not.toThrow();
  expect(floor.status).toEqual({
    minFreeBytes: 1000,
    availableBytes: 2000,
    probeFailed: false,
  });
});

it("stages transfers inside the server directory and bounds them by remaining quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-staging-"));
  const directory = join(root, "server");
  const server = await startServer({
    directory,
    ownerSecret,
    port: 0,
    storage: { maxStoredBytes: 256 * 1024 },
  });
  try {
    // Staging lives on the accounted filesystem, and startup clears it.
    expect((await stat(join(directory, "staging"))).isDirectory()).toBe(true);

    // An archive larger than the server could ever store is refused while
    // streaming, rather than staged in full somewhere nothing measures.
    const oversized = Buffer.alloc(512 * 1024, 7);
    const response = await fetch(`${server.url}/api/v1/imports`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerSecret}` },
      body: oversized,
    });
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 403,
      body: { error: { code: "quota_exceeded" } },
    });
    // Nothing is left behind in staging.
    expect(await readdir(join(directory, "staging"))).toEqual([]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
