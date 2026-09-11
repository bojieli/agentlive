import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import { TransferAuthority } from "../../packages/server/src/transfer-authority.js";
import type { PublishedEvent } from "../../packages/protocol/src/index.js";

// Large enough that a paused reader cannot receive the whole body through
// loopback socket and client stream buffers before revocation.
const size = 24 * 1024 * 1024;
const ownerSecret = "a".repeat(64);
const writeSecret = "b".repeat(64);
type Server = Awaited<ReturnType<typeof startServer>>;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function recording(
  server: Server,
  ownerId: string,
  requestId: string,
  visibility: "public" | "unlisted" | "private",
) {
  const bytes = randomBytes(size);
  const hash = digest(bytes);
  const session = await server.store.create({
    ownerId,
    requestId,
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "epoch",
    writeSecret,
    title: "Transfer " + requestId,
    visibility,
  });
  try {
    await session.uploadAttachment(
      writeSecret,
      { hash, byteSize: bytes.length },
      Readable.from([bytes]),
    );
    const { lease } = await session.resume(writeSecret, {
      publisherId: "pub",
      producerEpoch: "epoch",
      attempt: 1,
      revision: session.info.revision,
    });
    const event: PublishedEvent = {
      protocolVersion: 1,
      streamId: session.info.id,
      producerEpoch: "epoch",
      producerSeq: 1,
      observedAt: "2026-09-09T00:00:00.000Z",
      clockSegmentId: "clock",
      elapsedMs: 1,
      fidelity: "delta",
      source: { agent: "synthetic", sessionId: "native" },
      content: {
        kind: "attachment.available",
        payload: {
          attachment: {
            artifactId: "art",
            version: 1,
            hash,
            byteSize: bytes.length,
            filename: "large.bin",
            mediaType: "application/octet-stream",
          },
        },
      },
    };
    await session.append(lease, [event]);
    return {
      id: session.info.id,
      revision: session.info.revision,
      hash,
      base: `${server.url}/api/v1/streams/${session.info.id}`,
    };
  } finally {
    server.store.release(session);
  }
}

/** Starts a download and holds it open after its first chunk (a paused reader). */
async function begin(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  const first = await reader.read();
  expect(first.done).toBe(false);
  chunks.push(first.value!);
  return {
    async finish(): Promise<
      { complete: true; bytes: Buffer } | { complete: false; received: number }
    > {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done)
            return { complete: true, bytes: Buffer.concat(chunks) };
          chunks.push(next.value);
        }
      } catch {
        return {
          complete: false,
          received: chunks.reduce((total, chunk) => total + chunk.length, 0),
        };
      }
    },
  };
}
const expectCut = async (transfer: Awaited<ReturnType<typeof begin>>) => {
  const result = await transfer.finish();
  expect(result.complete).toBe(false);
  if (!result.complete) expect(result.received).toBeLessThan(size);
};
const expectExact = async (
  transfer: Awaited<ReturnType<typeof begin>>,
  hash: string,
) => {
  const result = await transfer.finish();
  expect(result.complete).toBe(true);
  if (result.complete) {
    expect(result.bytes.length).toBe(size);
    expect(digest(result.bytes)).toBe(hash);
  }
};

it("cuts off in-flight downloads on grant, publisher credential, visibility and removal changes while unaffected transfers complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-transfer-revoke-"));
  const server = await startServer({ directory: root, ownerSecret, port: 0 });
  const operator = { authorization: `Bearer ${ownerSecret}` };
  const publisher = { authorization: `Bearer ${writeSecret}` };
  const json = (url: string, body: unknown, method = "POST") =>
    fetch(url, {
      method,
      headers: { ...operator, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const priv = await recording(server, "local", "private-one", "private");
    const pub = await recording(server, "local", "public-one", "public");
    const doomed = await recording(server, "local", "removed-one", "public");
    const issue = async (label: string) => {
      const response = await json(priv.base + "/viewing-grants", {
        label,
        expiresAt: Date.now() + 60_000,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; token: string };
    };
    const revoked = await issue("revoked");
    const kept = await issue("kept");
    const attachment = (target: { base: string; hash: string }) =>
      `${target.base}/attachments/${target.hash}`;

    // Normal completion leaves no revocable-transfer registrations behind.
    await expectExact(await begin(attachment(priv), operator), priv.hash);
    await expectExact(await begin(attachment(pub), publisher), pub.hash);
    await expect.poll(() => server.activeTransfers).toBe(0);

    // (a) Viewing-grant revocation.
    const grantCut = await begin(attachment(priv), {
      authorization: `Bearer ${revoked.token}`,
    });
    const grantKept = await begin(attachment(priv), {
      authorization: `Bearer ${kept.token}`,
    });
    const operatorKept = await begin(attachment(priv), operator);
    const publisherCut = await begin(attachment(priv), publisher);
    expect(server.activeTransfers).toBe(2);
    const deleted = await fetch(`${priv.base}/viewing-grants/${revoked.id}`, {
      method: "DELETE",
      headers: operator,
    });
    expect(await deleted.json()).toEqual({ revoked: true });
    await expectCut(grantCut);

    // Publisher credential revocation cuts the publisher-key reader of a private recording.
    const credential = (await (
      await fetch(priv.base + "/publisher-credential", { headers: operator })
    ).json()) as { version: number };
    const credentialChange = await json(priv.base + "/publisher-credential", {
      operationId: "revoke-publisher",
      revision: priv.revision,
      expectedVersion: credential.version,
      replacementSecret: null,
    });
    expect(credentialChange.status).toBe(200);
    await expectCut(publisherCut);
    expect((await fetch(attachment(priv), { headers: publisher })).status).toBe(
      403,
    );

    // (c) Public -> private cuts anonymous readers; credentialed readers remain authorized.
    const anonymousCut = await begin(attachment(pub));
    const publisherPublicKept = await begin(attachment(pub), publisher);
    const operatorPublicKept = await begin(attachment(pub), operator);
    const restricted = await json(pub.base + "/visibility", {
      revision: pub.revision,
      operationId: "restrict",
      expectedVersion: 0,
      visibility: "private",
    });
    expect(restricted.status).toBe(200);
    await expectCut(anonymousCut);
    expect((await fetch(attachment(pub))).status).toBe(403);

    // (d) Recording removal cuts every reader of that recording, including the operator.
    const removalAnonymous = await begin(attachment(doomed));
    const removalOperator = await begin(attachment(doomed), operator);
    const removed = await json(
      `${server.url}/api/v1/recordings/${doomed.id}/removal`,
      {
        revision: doomed.revision,
        operationId: "remove-doomed",
      },
    );
    expect(removed.status).toBe(200);
    await expectCut(removalAnonymous);
    await expectCut(removalOperator);

    // Unaffected concurrent transfers complete byte-exactly.
    await expectExact(grantKept, priv.hash);
    await expectExact(operatorKept, priv.hash);
    await expectExact(publisherPublicKept, pub.hash);
    await expectExact(operatorPublicKept, pub.hash);
    await expect.poll(() => server.activeTransfers).toBe(0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("cuts off account-session and device transfers on logout and device revocation only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-transfer-account-"));
  const password = "p".repeat(64),
    issuer = "https://id.example",
    origin = "https://app.example";
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const account = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "owner",
    displayName: "Owner",
  });
  const managed = await sessions.issueDevice(account.id);
  const [managedDevice] = await sessions.listDevices(account.id);
  const revokedDevice = await sessions.issueDevice(account.id);
  const keptDevice = await sessions.issueDevice(account.id);
  const loggedOut = await sessions.issue(account.id);
  const keptBrowser = await sessions.issue(account.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
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
  });
  const browser = (issued: { cookie: string; csrf: string }) => ({
    cookie: `__Host-agentlive-session=${issued.cookie}`,
    origin,
    "x-csrf-token": issued.csrf,
  });
  const device = (issued: { token: string }) => ({
    authorization: `Bearer ${issued.token}`,
  });
  try {
    const owned = await recording(server, account.id, "owned", "private");
    const url = `${owned.base}/attachments/${owned.hash}`;
    const logoutCut = await begin(url, browser(loggedOut));
    const logoutExportCut = await begin(
      `${owned.base}/export`,
      browser(loggedOut),
    );
    const deviceCut = await begin(url, device(revokedDevice));
    const managedCut = await begin(url, device(managed));
    const deviceKept = await begin(url, device(keptDevice));
    const browserKept = await begin(url, browser(keptBrowser));
    expect(server.activeTransfers).toBe(6);

    // (b) Browser logout.
    const logout = await fetch(server.url + "/auth/logout", {
      method: "POST",
      headers: browser(loggedOut),
    });
    expect(logout.status).toBe(200);
    await expectCut(logoutCut);
    const exported = await logoutExportCut.finish();
    expect(exported.complete).toBe(false);
    expect(server.activeTransfers).toBe(4);

    // (b) Device self-revocation.
    const selfRevoked = await fetch(server.url + "/auth/device/revoke", {
      method: "POST",
      headers: device(revokedDevice),
    });
    expect(await selfRevoked.json()).toEqual({ revoked: true });
    await expectCut(deviceCut);

    // (b) Browser device management revocation.
    const managedRevoke = await fetch(server.url + "/auth/devices/revoke", {
      method: "POST",
      headers: { ...browser(keptBrowser), "content-type": "application/json" },
      body: JSON.stringify({ id: managedDevice!.id }),
    });
    expect(await managedRevoke.json()).toEqual({ revoked: true });
    await expectCut(managedCut);
    expect((await fetch(url, { headers: device(managed) })).status).toBe(403);

    await expectExact(deviceKept, owned.hash);
    await expectExact(browserKept, owned.hash);
    await expect.poll(() => server.activeTransfers).toBe(0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("aborts an in-flight import when its device credential is revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-transfer-import-"));
  const password = "p".repeat(64),
    issuer = "https://id.example",
    origin = "https://app.example";
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const account = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "importer",
    displayName: "Importer",
  });
  const importer = await sessions.issueDevice(account.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
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
  });
  const headers = { authorization: `Bearer ${importer.token}` };
  try {
    let send!: (chunk: Uint8Array | null) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (chunk) => {
          try {
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          } catch {
            /* The server may already have abandoned the request. */
          }
        };
      },
    });
    const upload = fetch(server.url + "/api/v1/imports", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit).then(
      (response) => response.status,
      () => "failed" as const,
    );
    send(new Uint8Array(64 * 1024));
    await expect.poll(() => server.activeTransfers).toBe(1);
    const revoke = await fetch(server.url + "/auth/device/revoke", {
      method: "POST",
      headers,
    });
    expect(await revoke.json()).toEqual({ revoked: true });
    expect(server.activeTransfers).toBe(0);
    send(new Uint8Array(64 * 1024));
    send(null);
    const status = await upload;
    expect(status === "failed" || status === 403).toBe(true);
    expect(
      (await server.store.list({ ownerId: account.id })).recordings,
    ).toEqual([]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("rechecks registered transfers when an account is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-transfer-disable-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    "p".repeat(64),
  );
  const transfers = new TransferAuthority();
  try {
    accounts.onStatusChange(() => transfers.revalidate());
    sessions.onRevoke(() => transfers.revalidate());
    const identity = { issuer: "https://id.example", displayName: "X" };
    const disabled = await accounts.resolveVerifiedIdentity({
      ...identity,
      subject: "disabled",
    });
    const other = await accounts.resolveVerifiedIdentity({
      ...identity,
      subject: "other",
    });
    const principal = (token: string) => () =>
      !!sessions.authenticateDevice(token);
    const cut = transfers.register(
      principal((await sessions.issueDevice(disabled.id)).token),
    );
    const kept = transfers.register(
      principal((await sessions.issueDevice(other.id)).token),
    );
    const browser = await sessions.authenticate(
      (await sessions.issue(disabled.id)).cookie,
    );
    const browserCut = transfers.register(browser!.isActive);
    await accounts.setDisabled(disabled.id, disabled.version, true);
    expect(cut.signal.reason).toMatchObject({ code: "forbidden" });
    expect(browserCut.signal.aborted).toBe(true);
    expect(kept.signal.aborted).toBe(false);
    expect(transfers.size).toBe(1);
    kept.close();
    expect(transfers.size).toBe(0);
    const bounded = new TransferAuthority({ limit: 1 });
    const only = bounded.register(() => true);
    expect(() => bounded.register(() => true)).toThrow(
      "Too many active transfers",
    );
    only.close();
    bounded.register(() => true).close();
    expect(bounded.size).toBe(0);
  } finally {
    transfers.close();
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("closes open viewing sockets promptly on logout and device revocation", async () => {
  const { WebSocket } = createRequire(
    new URL("../../packages/server/package.json", import.meta.url),
  )("ws") as typeof import("ws");
  const root = await mkdtemp(join(tmpdir(), "agentlive-socket-revoke-"));
  const password = "p".repeat(64),
    issuer = "https://id.example",
    origin = "https://app.example";
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const account = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "owner",
    displayName: "Owner",
  });
  const revokedDevice = await sessions.issueDevice(account.id);
  const keptDevice = await sessions.issueDevice(account.id);
  const loggedOut = await sessions.issue(account.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
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
  });
  const browser = {
    cookie: `__Host-agentlive-session=${loggedOut.cookie}`,
    origin,
    "x-csrf-token": loggedOut.csrf,
  };
  const sockets: import("ws").WebSocket[] = [];
  try {
    const owned = await recording(server, account.id, "sockets", "private");
    const connect = async (query: string, headers: Record<string, string>) => {
      const socket = new WebSocket(
        server.url.replace("http:", "ws:") + "/api/v1/watch" + query,
        { headers },
      );
      sockets.push(socket);
      const messages: { type: string }[] = [];
      socket.on("message", (bytes: Buffer) =>
        messages.push(JSON.parse(bytes.toString())),
      );
      const closed = new Promise<number>((resolve) =>
        socket.once("close", resolve),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "subscribe",
          protocolVersion: 1,
          requestId: "sub",
          streamId: owned.id,
          revision: owned.revision,
          afterServerSeq: 0,
        }),
      );
      await expect
        .poll(() => messages.some((message) => message.type === "subscribed"))
        .toBe(true);
      return { socket, closed };
    };
    const ticket = await (
      await fetch(`${owned.base}/watch-ticket`, {
        method: "POST",
        headers: { ...browser, "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    const browserSocket = await connect(`?ticket=${ticket.ticket}`, {});
    const revokedSocket = await connect("", {
      authorization: `Bearer ${revokedDevice.token}`,
    });
    const keptSocket = await connect("", {
      authorization: `Bearer ${keptDevice.token}`,
    });
    const within = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("socket stayed open")), 3000),
        ),
      ]);

    // No client traffic is sent: revocation itself must close the sockets.
    expect(
      (
        await fetch(server.url + "/auth/device/revoke", {
          method: "POST",
          headers: { authorization: `Bearer ${revokedDevice.token}` },
        })
      ).status,
    ).toBe(200);
    expect(await within(revokedSocket.closed)).toBe(1008);
    expect(
      (
        await fetch(server.url + "/auth/logout", {
          method: "POST",
          headers: browser,
        })
      ).status,
    ).toBe(200);
    expect(await within(browserSocket.closed)).toBe(1008);
    expect(keptSocket.socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
