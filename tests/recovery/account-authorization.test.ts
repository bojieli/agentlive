import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import { startServer } from "../../packages/server/src/http.js";
import { createRequire } from "node:module";
const { WebSocket } = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("ws");

it("isolates account creation, listing, private reads and management over HTTP with CSRF and bearer precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-auth-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const password = "p".repeat(64),
    issuer = "https://id.example",
    origin = "https://app.example";
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const a = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "a",
    displayName: "A",
  });
  const b = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "b",
    displayName: "B",
  });
  const sa = await sessions.issue(a.id),
    sb = await sessions.issue(b.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret: "a".repeat(64),
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
  const request = (
    auth: typeof sa,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(server.url + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: `__Host-agentlive-session=${auth.cookie}`,
        origin,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const sockets: import("ws").WebSocket[] = [];
  try {
    const input = {
      requestId: "same-request",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "c".repeat(64),
      title: "Private",
      visibility: "private",
    };
    expect(
      (await request(sa, "/api/v1/streams", input, { "x-csrf-token": "bad" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(sa, "/api/v1/streams", input, {
          authorization: "Bearer invalid",
        })
      ).status,
    ).toBe(401);
    const createdA = await request(sa, "/api/v1/streams", input);
    expect(createdA.status).toBe(201);
    const startedDevice = await fetch(server.url + "/auth/device/start", {
      method: "POST",
    });
    expect(startedDevice.status).toBe(201);
    const device = await startedDevice.json();
    expect(
      (
        await fetch(server.url + "/auth/device/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userCode: device.userCode, approve: true }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          sa,
          "/auth/device/decide",
          { userCode: device.userCode, approve: true },
          { "x-csrf-token": "bad" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(sa, "/auth/device/decide", {
          userCode: device.userCode,
          approve: true,
        })
      ).status,
    ).toBe(200);
    let deviceToken: string | undefined;
    await expect
      .poll(
        async () => {
          const response = await fetch(server.url + "/auth/device/poll", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode: device.deviceCode }),
          });
          const result = await response.json();
          deviceToken = result.token;
          return result.status;
        },
        { timeout: 8000, interval: 1000 },
      )
      .toBe("approved");
    const first = await createdA.json();
    const createdB = await request(sb, "/api/v1/streams", input);
    expect(createdB.status).toBe(201);
    const second = await createdB.json();
    expect(second.streamId).not.toBe(first.streamId);
    const lineage = {
      revision: first.revision,
      origin: {
        version: 1,
        operationId: "cross-account",
        sourceStreamId: second.streamId,
        sourceRevision: second.revision,
        sourceConverterVersion: "test-1",
        targetConverterVersion: "test-2",
        requestedSourceDisposition: "retain",
      },
    };
    expect(
      (
        await request(
          sa,
          `/api/v1/streams/${first.streamId}/migration-origin`,
          lineage,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          sb,
          `/api/v1/streams/${first.streamId}/migration-origin`,
          lineage,
        )
      ).status,
    ).toBe(401);

    expect(
      (await (await request(sa, "/api/v1/streams", input)).json()).streamId,
    ).toBe(first.streamId);
    const listA = await (await request(sa, "/api/v1/streams")).json();
    const listB = await (await request(sb, "/api/v1/streams")).json();
    expect(listA.recordings.map((row: { id: string }) => row.id)).toEqual([
      first.streamId,
    ]);
    expect(listB.recordings.map((row: { id: string }) => row.id)).toEqual([
      second.streamId,
    ]);
    const base = `/api/v1/streams/${first.streamId}`;
    const deviceHeaders = { authorization: `Bearer ${deviceToken}` };
    const devices = await (await request(sa, "/auth/devices")).json();
    expect(devices.devices).toHaveLength(1);
    expect((await (await request(sb, "/auth/devices")).json()).devices).toEqual(
      [],
    );
    expect(
      (
        await request(
          sa,
          "/auth/devices/revoke",
          { id: devices.devices[0].id },
          { "x-csrf-token": "bad" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await (
          await request(sb, "/auth/devices/revoke", {
            id: devices.devices[0].id,
          })
        ).json()
      ).revoked,
    ).toBe(false);
    expect(
      (await fetch(server.url + base, { headers: deviceHeaders })).status,
    ).toBe(200);
    expect(
      (
        await fetch(server.url + `/api/v1/streams/${second.streamId}`, {
          headers: deviceHeaders,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url + "/auth/device/revoke", {
          method: "POST",
          headers: deviceHeaders,
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(server.url + base, { headers: deviceHeaders })).status,
    ).toBe(403);
    expect((await request(sa, base)).status).toBe(200);
    expect((await request(sb, base)).status).toBe(403);
    for (const suffix of [
      "/events",
      "/export",
      "/snapshots",
      "/viewing-grants",
      "/publisher-credential",
    ]) {
      const response = await request(sb, base + suffix);
      expect([401, 403]).toContain(response.status);
    }
    expect((await request(sa, base + "/publisher-credential")).status).toBe(
      200,
    );
    expect(
      (
        await request(sa, base + "/viewing-grants", {
          label: "Reviewer",
          expiresAt: Date.now() + 60000,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(sb, base + "/viewing-grants", {
          label: "Intruder",
          expiresAt: Date.now() + 60000,
        })
      ).status,
    ).toBe(401);
    const change = {
      revision: first.revision,
      operationId: "revoke",
      expectedVersion: 0,
      replacementSecret: null,
    };
    expect(
      (await request(sb, base + "/publisher-credential", change)).status,
    ).toBe(401);
    expect(
      (await request(sa, base + "/publisher-credential", change)).status,
    ).toBe(200);
    const owned = await server.store.get(first.streamId);
    expect(owned.info.ownerId).toBe(a.id);
    server.store.release(owned);
    const ticket = await (await request(sa, base + "/watch-ticket", {})).json();
    const unused = await (await request(sa, base + "/watch-ticket", {})).json();
    expect((await request(sb, base + "/watch-ticket", {})).status).toBe(403);
    const connect = async (value: string) => {
      const socket = new WebSocket(
        server.url.replace("http:", "ws:") + `/api/v1/watch?ticket=${value}`,
      );
      sockets.push(socket);
      const messages: any[] = [];
      socket.on("message", (bytes: Buffer) =>
        messages.push(JSON.parse(bytes.toString())),
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
          streamId: first.streamId,
          revision: first.revision,
          afterServerSeq: 0,
        }),
      );
      return { socket, messages };
    };
    const active = await connect(ticket.ticket);
    await expect
      .poll(() =>
        active.messages.some((message) => message.type === "subscribed"),
      )
      .toBe(true);
    const closed = new Promise<number>((resolve) =>
      active.socket.once("close", resolve),
    );
    const disposable = await (
      await request(sa, "/api/v1/streams", {
        ...input,
        requestId: "remove-account-recording",
      })
    ).json();
    const removalPath = `/api/v1/recordings/${disposable.streamId}/removal`;
    const removal = {
      revision: disposable.revision,
      operationId: "remove-account",
    };
    expect((await request(sb, removalPath, removal)).status).toBe(401);
    expect(
      (await request(sa, removalPath, removal, { "x-csrf-token": "bad" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(sa, removalPath, removal, {
          authorization: "Bearer invalid",
        })
      ).status,
    ).toBe(401);
    expect((await request(sa, removalPath, removal)).status).toBe(200);
    expect((await request(sa, removalPath, removal)).status).toBe(200);
    expect(
      (await request(sa, `/api/v1/streams/${disposable.streamId}`)).status,
    ).toBe(404);
    expect((await request(sa, "/auth/logout", {})).status).toBe(200);
    active.socket.send(
      JSON.stringify({
        type: "heartbeat",
        protocolVersion: 1,
        requestId: "after-logout",
      }),
    );
    expect(await closed).toBe(1008);
    expect((await request(sa, base)).status).toBe(403);
    const denied = await connect(unused.ticket);
    await expect
      .poll(() => denied.messages.some((message) => message.type === "error"))
      .toBe(true);
    expect(
      denied.messages.some((message) => message.type === "subscribed"),
    ).toBe(false);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
