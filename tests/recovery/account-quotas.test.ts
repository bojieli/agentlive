import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../../packages/server/src/http.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import {
  AccountQuotas,
  scanRecordingUsage,
  type QuotaLimits,
} from "../../packages/server/src/quotas.js";
import { loadHostedConfig } from "../../packages/cli/src/hosted-config.js";
import {
  getAccountUsage,
  listAccounts,
} from "../../packages/client/src/index.js";
import {
  PublisherJournal,
  PublisherNetwork,
  uploadArtifact,
  type ArtifactSpool,
} from "../../packages/publisher/src/index.js";

const exec = promisify(execFile);
const cli = resolve("packages/cli/dist/main.js");
const ownerSecret = "a".repeat(64);
const password = "p".repeat(64),
  issuer = "https://id.example",
  origin = "https://app.example";
const operator = { authorization: `Bearer ${ownerSecret}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task().catch(() => {});
});

async function seed(root: string) {
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const target = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "quota-target",
    displayName: "Target",
  });
  const other = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "quota-other",
    displayName: "Other",
  });
  const device = await sessions.issueDevice(target.id);
  const otherDevice = await sessions.issueDevice(other.id);
  await sessions.close();
  await accounts.close();
  return { target, other, device, otherDevice };
}

async function start(root: string, quotas?: QuotaLimits) {
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
    publicOrigin: origin,
    ...(quotas ? { quotas } : {}),
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
  });
  cleanup.push(() => server.close());
  return server;
}

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

type Server = Awaited<ReturnType<typeof start>>;
const writeSecret = "b".repeat(64);
function create(
  server: Server,
  credential: string,
  requestId: string,
  requestedAt = new Date().toISOString(),
) {
  return fetch(server.url + "/api/v1/streams", {
    method: "POST",
    headers: { ...bearer(credential), "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      requestedAt,
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret,
      title: requestId,
      visibility: "private",
    }),
  });
}
function lifecycle(
  server: Server,
  streamId: string,
  action: "end" | "reopen",
  expectedLifecycleSeq: number,
) {
  return fetch(`${server.url}/api/v1/streams/${streamId}/${action}`, {
    method: "POST",
    headers: { ...bearer(writeSecret), "content-type": "application/json" },
    body: JSON.stringify({
      operationId: `${action}-${randomBytes(4).toString("hex")}`,
      expectedLifecycleSeq,
      content:
        action === "end"
          ? {
              kind: "recording.ended",
              payload: { producerEpoch: "epoch", throughProducerSeq: 0 },
            }
          : { kind: "recording.reopened", payload: {} },
    }),
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
async function usage(server: Server, credential: string) {
  return getAccountUsage({
    serverOrigin: server.url,
    credential,
    signal: AbortSignal.timeout(10_000),
  });
}
async function expectQuota(response: Response, quota: string) {
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.error.code).toBe("quota_exceeded");
  expect(body.error.details.quota).toBe(quota);
  expect(body.error.message).toMatch(/quota exceeded/);
  return body.error;
}

it("limits recordings and open recordings per account, releases usage on removal and recomputes it after restart", async () => {
  const root = await temporaryRoot("agentlive-quota-count-");
  const { target, other, device, otherDevice } = await seed(root);
  const quotas = {
    maxRecordingsPerAccount: 2,
    maxActiveRecordingsPerAccount: 1,
    maxStoredBytesPerAccount: 64 * 1024 * 1024,
  };
  let server = await start(root, quotas);

  const firstAt = new Date().toISOString();
  const first = await (
    await create(server, device.token, "first", firstAt)
  ).json();
  expect((await usage(server, device.token)).usage).toMatchObject({
    recordings: 1,
    activeRecordings: 1,
  });
  // A second open recording exceeds the active limit.
  await expectQuota(
    await create(server, device.token, "second"),
    "maxActiveRecordingsPerAccount",
  );
  // Retrying an already committed creation is never quota-rejected.
  const retried = await create(server, device.token, "first", firstAt);
  expect(retried.status).toBe(201);
  expect((await retried.json()).streamId).toBe(first.streamId);

  expect((await lifecycle(server, first.streamId, "end", 1)).status).toBe(200);
  const second = await (await create(server, device.token, "second")).json();
  expect(second.streamId).toBeTruthy();
  const error = await expectQuota(
    await create(server, device.token, "third"),
    "maxRecordingsPerAccount",
  );
  expect(error.message).toContain("2 of 2 recordings");
  // Reopening the ended recording would make two recordings open.
  await expectQuota(
    await lifecycle(server, first.streamId, "reopen", 2),
    "maxActiveRecordingsPerAccount",
  );

  // Archive import is rejected before the archive body is accepted.
  const archive = Buffer.from(
    await (
      await fetch(`${server.url}/api/v1/streams/${first.streamId}/export`, {
        headers: bearer(device.token),
      })
    ).arrayBuffer(),
  );
  await expectQuota(
    await fetch(server.url + "/api/v1/imports", {
      method: "POST",
      headers: {
        ...bearer(device.token),
        "content-type": "application/octet-stream",
      },
      body: archive,
    }),
    "maxRecordingsPerAccount",
  );

  // Other accounts and the local owner are counted independently or not at all.
  expect((await create(server, otherDevice.token, "other")).status).toBe(201);
  for (const name of ["local-1", "local-2", "local-3"])
    expect((await create(server, ownerSecret, name)).status).toBe(201);
  expect((await usage(server, otherDevice.token)).usage).toMatchObject({
    recordings: 1,
    activeRecordings: 1,
  });

  const before = await usage(server, device.token);
  expect(before).toMatchObject({
    accountId: target.id,
    usage: { recordings: 2, activeRecordings: 1 },
    limits: quotas,
  });
  expect(before.usage.storedBytes).toBeGreaterThan(0);

  // The operator listing (HTTP client and CLI) includes usage and limits.
  const listed = await listAccounts({
    serverOrigin: server.url,
    credential: ownerSecret,
    signal: AbortSignal.timeout(10_000),
  });
  expect(listed.limits).toEqual(quotas);
  expect(listed.accounts.find((a) => a.id === target.id)?.usage).toEqual(
    before.usage,
  );
  expect(listed.accounts.find((a) => a.id === other.id)?.usage).toMatchObject({
    recordings: 1,
  });
  const page = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "accounts", "--server", server.url, "--state-dir", root],
        {
          env: {
            PATH: process.env.PATH ?? "",
            AGENTLIVE_OWNER_SECRET: ownerSecret,
          },
        },
      )
    ).stdout,
  );
  expect(
    page.accounts.find((a: { id: string }) => a.id === target.id).usage,
  ).toEqual(before.usage);
  // The usage route is account-only.
  expect(
    (await fetch(server.url + "/api/v1/account/usage", { headers: operator }))
      .status,
  ).toBe(401);

  // Removal releases the recording, its open slot and its bytes immediately.
  expect((await remove(server, device.token, second)).status).toBe(200);
  const released = await usage(server, device.token);
  expect(released.usage.recordings).toBe(1);
  expect(released.usage.activeRecordings).toBe(0);
  expect(released.usage.storedBytes).toBeLessThan(before.usage.storedBytes);
  expect((await lifecycle(server, first.streamId, "reopen", 2)).status).toBe(
    200,
  );
  expect((await lifecycle(server, first.streamId, "end", 3)).status).toBe(200);
  const imported = await fetch(server.url + "/api/v1/imports", {
    method: "POST",
    headers: {
      ...bearer(device.token),
      "content-type": "application/octet-stream",
    },
    body: archive,
  });
  expect(imported.status).toBe(201);
  const afterWrites = await usage(server, device.token);
  expect(afterWrites.usage).toMatchObject({
    recordings: 2,
    activeRecordings: 0,
  });

  // A restart recomputes identical usage from durable state.
  await server.close();
  server = await start(root, quotas);
  expect((await usage(server, device.token)).usage).toEqual(afterWrites.usage);
  expect((await usage(server, otherDevice.token)).usage).toMatchObject({
    recordings: 1,
    activeRecordings: 1,
  });
  await expectQuota(
    await create(server, device.token, "third"),
    "maxRecordingsPerAccount",
  );
  // Loading a recording reconciles without changing the recomputed totals.
  expect(
    (
      await fetch(`${server.url}/api/v1/streams/${first.streamId}`, {
        headers: bearer(device.token),
      })
    ).status,
  ).toBe(200);
  expect((await usage(server, device.token)).usage).toEqual(afterWrites.usage);
}, 60_000);

it("rejects attachment uploads and event batches beyond the byte quota with a non-retryable publisher error", async () => {
  const root = await temporaryRoot("agentlive-quota-bytes-");
  const { device, otherDevice } = await seed(root);
  const limit = 256 * 1024;
  const server = await start(root, { maxStoredBytesPerAccount: limit });
  const journal = await PublisherJournal.open(join(root, "publisher"), {
    serverOrigin: server.url,
    agent: "synthetic" as const,
    nativeSessionId: "quota-native",
  });
  cleanup.push(() => journal.close());
  const network = new PublisherNetwork({
    journal,
    ownerCredential: device.token,
    title: "Quota",
    visibility: "private",
    retryMinMs: 5,
    retryMaxMs: 10,
  });
  await network.ensureRemote(AbortSignal.timeout(10_000));
  const streamId = journal.identity.streamId!;
  const capture = (n: number, text: string, parts = 1) =>
    journal.capture({
      sourceKey: `source_${n}`,
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock",
      elapsedMs: n,
      fidelity: "delta",
      adapterState: { n },
      content:
        n === 0
          ? [
              {
                kind: "message.started",
                payload: { messageId: "m", role: "assistant" },
              },
            ]
          : Array.from({ length: parts }, () => ({
              kind: "message.text.append" as const,
              payload: { messageId: "m", text },
            })),
    });

  // Attachments within the quota upload; the publisher helper surfaces the rejection.
  const spoolFor = (path: string) =>
    ({ openFile: () => open(path, "r") }) as unknown as ArtifactSpool;
  const attachment = async (name: string, bytes: number) => {
    const data = randomBytes(bytes);
    const path = join(root, name);
    await writeFile(path, data);
    return {
      path,
      attachment: {
        hash: createHash("sha256").update(data).digest("hex"),
        byteSize: bytes,
      },
    };
  };
  const small = await attachment("small.bin", 64 * 1024);
  await uploadArtifact(spoolFor(small.path), small.attachment as never, {
    serverOrigin: server.url,
    streamId,
    writeSecret: journal.identity.writeSecret,
    signal: AbortSignal.timeout(10_000),
  });
  const afterSmall = (await usage(server, device.token)).usage.storedBytes;
  expect(afterSmall).toBeGreaterThan(64 * 1024);
  // A 2 MiB upload is rejected from its declared size before its body is read.
  const large = await attachment("large.bin", 2 * 1024 * 1024);
  const rejected = await uploadArtifact(
    spoolFor(large.path),
    large.attachment as never,
    {
      serverOrigin: server.url,
      streamId,
      writeSecret: journal.identity.writeSecret,
      signal: AbortSignal.timeout(20_000),
      retryMinMs: 5,
    },
  ).catch((error: unknown) => error);
  expect(rejected).toMatchObject({
    name: "ProtocolError",
    code: "quota_exceeded",
  });
  expect((rejected as Error).message).toContain(`of ${limit} bytes used`);
  expect((await usage(server, device.token)).usage.storedBytes).toBe(
    afterSmall,
  );
  const raw = await fetch(
    `${server.url}/api/v1/streams/${streamId}/attachments`,
    {
      method: "POST",
      headers: {
        ...bearer(journal.identity.writeSecret),
        "x-attachment-sha256": large.attachment.hash,
        "x-attachment-bytes": String(large.attachment.byteSize),
      },
      body: new Uint8Array(0),
    },
  );
  await expectQuota(raw, "maxStoredBytesPerAccount");

  // Event batches that fit are acknowledged.
  await capture(0, "");
  for (let n = 1; n <= 4; n++) await capture(n, "x".repeat(16 * 1024));
  const run = network.run(new AbortController().signal);
  run.catch(() => {});
  await expect.poll(() => journal.identity.acknowledgedSeq).toBe(5);
  const accepted = (await usage(server, device.token)).usage.storedBytes;
  expect(accepted).toBeGreaterThan(afterSmall + 64 * 1024);
  // A batch that would exceed the quota is rejected whole and stops the publisher.
  // One capture commits all eight events atomically, so they form one batch.
  await capture(5, "y".repeat(16 * 1024), 8);
  const failure = await Promise.race([
    run.then(
      () => new Error("publisher stopped without an error"),
      (error: unknown) => error,
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve(new Error("publisher kept retrying")), 15_000),
    ),
  ]);
  expect(failure).toMatchObject({
    name: "ProtocolError",
    code: "quota_exceeded",
  });
  expect(journal.identity.acknowledgedSeq).toBe(5);
  const session = await server.store.get(streamId);
  try {
    // The creation record plus the five acknowledged events; nothing was partially written.
    expect(session.boundary.sequence).toBe(6);
  } finally {
    server.store.release(session);
  }
  const final = (await usage(server, device.token)).usage.storedBytes;
  expect(final).toBe(accepted);
  expect(final).toBeLessThanOrEqual(limit);

  // Other accounts are unaffected by this account's usage.
  expect((await create(server, otherDevice.token, "other-bytes")).status).toBe(
    201,
  );
  // Removing the recording frees the bytes for new work.
  const info = await (
    await fetch(`${server.url}/api/v1/streams/${streamId}`, {
      headers: bearer(device.token),
    })
  ).json();
  expect(
    (await remove(server, device.token, { streamId, revision: info.revision }))
      .status,
  ).toBe(200);
  expect((await usage(server, device.token)).usage).toEqual({
    recordings: 0,
    activeRecordings: 0,
    storedBytes: 0,
  });
  expect((await create(server, device.token, "after-removal")).status).toBe(
    201,
  );
}, 60_000);

it("validates quota configuration and leaves limits unlimited when absent", async () => {
  const root = await temporaryRoot("agentlive-quota-config-");
  const path = join(root, "hosted.json");
  const config = {
    version: 1,
    publicOrigin: "https://app.example",
    issuer: "https://id.example",
    clientId: "client",
    clientSecretEnv: "OIDC_CLIENT_SECRET",
    cookiePasswordEnv: "SESSION_PASSWORD",
  };
  const env = {
    OIDC_CLIENT_SECRET: "client-secret",
    SESSION_PASSWORD: "a".repeat(64),
  };
  const quotas = {
    maxRecordingsPerAccount: 100,
    maxActiveRecordingsPerAccount: 5,
    maxStoredBytesPerAccount: 1024 ** 3,
  };
  await writeFile(path, JSON.stringify({ ...config, quotas }));
  expect((await loadHostedConfig(path, env)).quotas).toEqual(quotas);
  await writeFile(path, JSON.stringify({ ...config, quotas: {} }));
  expect((await loadHostedConfig(path, env)).quotas).toEqual({});
  await writeFile(path, JSON.stringify(config));
  expect("quotas" in (await loadHostedConfig(path, env))).toBe(false);
  for (const invalid of [
    { maxRecordingsPerAccount: 0 },
    { maxRecordingsPerAccount: 1.5 },
    { maxStoredBytesPerAccount: 1024 },
    { maxStoredBytesPerAccount: 2 ** 51 },
    { maxActiveRecordingsPerAccount: "5" },
    { maxRecordingsPerAccount: 2, maxActiveRecordingsPerAccount: 3 },
    { maxBandwidth: 10 },
    [],
  ]) {
    await writeFile(path, JSON.stringify({ ...config, quotas: invalid }));
    await expect(loadHostedConfig(path, env)).rejects.toThrow(
      /^Invalid hosted quotas/,
    );
  }
  await expect(
    startServer({
      directory: join(root, "server"),
      ownerSecret,
      port: 0,
      quotas: { maxRecordingsPerAccount: -1 },
    }),
  ).rejects.toThrow("Invalid per-account quota configuration");

  // Without quotas the account is unlimited but its usage is still reported.
  const hostedRoot = join(root, "hosted");
  const { device } = await seed(hostedRoot);
  const server = await start(hostedRoot);
  for (const name of ["u1", "u2", "u3"])
    expect((await create(server, device.token, name)).status).toBe(201);
  expect(await usage(server, device.token)).toMatchObject({
    usage: { recordings: 3, activeRecordings: 3 },
    limits: {
      maxRecordingsPerAccount: null,
      maxActiveRecordingsPerAccount: null,
      maxStoredBytesPerAccount: null,
    },
  });
  // A standalone server has no account usage route.
  const standalone = await startServer({
    directory: join(root, "standalone"),
    ownerSecret,
    port: 0,
  });
  cleanup.push(() => standalone.close());
  expect(
    (
      await fetch(standalone.url + "/api/v1/account/usage", {
        headers: operator,
      })
    ).status,
  ).toBe(404);
}, 60_000);

it("reserves concurrent writes and derives lifecycle from the last complete log record", async () => {
  const quotas = new AccountQuotas({ maxStoredBytesPerAccount: 10_000 });
  const admission = quotas.reserveRecording("account", {
    bytes: 1000,
    open: true,
  });
  admission.commit("r1", 1000);
  const hooks = quotas.forRecording("r1", "account")!;
  const first = hooks.reserveBytes(6000);
  // A concurrent write cannot use bytes already reserved by an in-flight one.
  expect(() => hooks.reserveBytes(4000)).toThrow(/storage quota exceeded/);
  first.commit(5000);
  first.release(); // settled reservations ignore later calls
  expect(quotas.usage("account")).toEqual({
    recordings: 1,
    activeRecordings: 1,
    storedBytes: 6000,
  });
  const second = hooks.reserveBytes(4000);
  second.release();
  expect(() => hooks.reserveBytes(4001)).toThrow(/storage quota exceeded/);
  expect(hooks.reserveBytes(0)).toBeDefined(); // zero-byte writes always pass
  hooks.ended();
  expect(quotas.usage("account").activeRecordings).toBe(0);
  quotas.forget("r1");
  expect(quotas.usage("account")).toEqual({
    recordings: 0,
    activeRecordings: 0,
    storedBytes: 0,
  });
  // The local owner is never counted or limited per account; it counts only
  // toward the server-wide totals.
  quotas
    .reserveRecording("local", { bytes: 10 ** 9, open: true })
    .commit("r2", 10 ** 9);
  expect(quotas.usage("local").storedBytes).toBe(0);
  expect(quotas.totals).toMatchObject({
    recordings: 1,
    activeRecordings: 1,
    storedBytes: 10 ** 9,
  });
  quotas.forget("r2");

  const root = await temporaryRoot("agentlive-quota-scan-");
  const line = (kind: string) =>
    JSON.stringify({ value: { content: { kind } } }) + "\n";
  const recording = join(root, "recording");
  await mkdir(join(recording, "attachments", ".uploads"), { recursive: true });
  await writeFile(join(recording, "attachments", "a".repeat(64)), "12345");
  await writeFile(join(recording, "attachments", ".uploads", "x"), "999");
  // A torn trailing reopen record is not committed: the recording is still ended.
  const ended =
    line("recording.created") + line("recording.ended") + '{"partial';
  await writeFile(join(recording, "events.jsonl"), ended);
  expect(await scanRecordingUsage(recording)).toEqual({
    storedBytes: Buffer.byteLength(ended) + 5,
    open: false,
  });
  await writeFile(
    join(recording, "events.jsonl"),
    line("recording.created") + line("message.started"),
  );
  expect((await scanRecordingUsage(recording)).open).toBe(true);
  await writeFile(
    join(recording, "events.jsonl"),
    line("recording.ended") + "x".repeat(70 * 1024),
  );
  // No complete record inside the tail window: counted as open (conservative).
  expect((await scanRecordingUsage(recording)).open).toBe(true);
  await writeFile(join(recording, "events.jsonl"), line("recording.ended"));
  expect((await scanRecordingUsage(recording)).open).toBe(false);
});
