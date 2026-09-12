import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const { WebSocket } = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("ws");
import { startServer } from "../../packages/server/src/http.js";
import { ViewingGrants } from "../../packages/server/src/viewing-grants.js";
import { viewingResponse } from "../../packages/server/src/viewing-response.js";

it("scopes read-only grants, persists across restart and revokes active and ticket subscriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-view-access-"));
  const owner = "a".repeat(64),
    writer = "b".repeat(64);
  let server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  const sockets: any[] = [];
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "grant",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret: writer,
      title: "Private",
      visibility: "private",
    });
    const another = await server.store.create({
      ownerId: "local",
      requestId: "other",
      requestedAt: new Date().toISOString(),
      publisherId: "q",
      producerEpoch: "f",
      writeSecret: "c".repeat(64),
      title: "Other",
      visibility: "private",
    });
    const id = session.info.id,
      revision = session.info.revision,
      otherId = another.info.id;
    server.store.release(session);
    server.store.release(another);
    const request = (
      path: string,
      credential?: string,
      method = "GET",
      body?: unknown,
    ) =>
      fetch(server.url + path, {
        method,
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const base = `/api/v1/streams/${id}`;
    expect((await request(base + "/viewing-grants")).status).toBe(401);
    const issued = await request(base + "/viewing-grants", owner, "POST", {
      label: "Viewer",
      expiresAt: Date.now() + 60000,
    });
    expect(issued.status).toBe(201);
    const grant = await issued.json();
    expect((await request(base, grant.token)).status).toBe(200);
    expect(
      (await request(`/api/v1/streams/${otherId}`, grant.token)).status,
    ).toBe(403);
    expect((await request(base + "/publisher-state", grant.token)).status).toBe(
      401,
    );
    expect((await request(base + "/viewing-grants", grant.token)).status).toBe(
      401,
    );
    expect(
      JSON.stringify(
        await (await request(base + "/viewing-grants", writer)).json(),
      ),
    ).not.toContain(grant.token);
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    expect((await request(base, grant.token)).status).toBe(200);
    const ticket = await (
      await request(base + "/watch-ticket", grant.token, "POST")
    ).json();
    const unused = await (
      await request(base + "/watch-ticket", grant.token, "POST")
    ).json();
    const socket = new WebSocket(
      server.url.replace("http:", "ws:") +
        `/api/v1/watch?ticket=${ticket.ticket}`,
    );
    sockets.push(socket);
    const messages: any[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: 1,
        requestId: "sub",
        streamId: id,
        revision,
        afterServerSeq: 0,
      }),
    );
    await expect
      .poll(() => messages.some((message) => message.type === "subscribed"))
      .toBe(true);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    expect(
      (await request(base + `/viewing-grants/${grant.id}`, owner, "DELETE"))
        .status,
    ).toBe(200);
    expect(await closed).toBe(1008);
    expect((await request(base, grant.token)).status).toBe(403);
    const revoked = new WebSocket(
      server.url.replace("http:", "ws:") +
        `/api/v1/watch?ticket=${unused.ticket}`,
    );
    sockets.push(revoked);
    const denied: any[] = [];
    revoked.on("message", (data) => denied.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      revoked.once("open", resolve);
      revoked.once("error", reject);
    });
    revoked.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: 1,
        requestId: "sub",
        streamId: id,
        revision,
        afterServerSeq: 0,
      }),
    );
    await expect
      .poll(() =>
        denied.some(
          (message) => message.type === "error" && message.code === "forbidden",
        ),
      )
      .toBe(true);
    expect(denied.some((message) => message.type === "subscribed")).toBe(false);
    const expiring = await (
      await request(base + "/viewing-grants", writer, "POST", {
        label: "Short session",
        expiresAt: Date.now() + 1200,
      })
    ).json();
    const direct = new WebSocket(
      server.url.replace("http:", "ws:") + "/api/v1/watch",
      { headers: { authorization: `Bearer ${expiring.token}` } },
    );
    sockets.push(direct);
    const directMessages: any[] = [];
    direct.on("message", (data) =>
      directMessages.push(JSON.parse(data.toString())),
    );
    const expired = new Promise<number>((resolve) =>
      direct.once("close", (code) => resolve(code)),
    );
    await new Promise<void>((resolve, reject) => {
      direct.once("open", resolve);
      direct.once("error", reject);
    });
    direct.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: 1,
        requestId: "expiry",
        streamId: id,
        revision,
        afterServerSeq: 0,
      }),
    );
    await expect
      .poll(() =>
        directMessages.some((message) => message.type === "subscribed"),
      )
      .toBe(true);
    expect(await expired).toBe(1008);
    expect((await request(base, expiring.token)).status).toBe(403);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("cancels an active response source and prevents further bytes on revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-view-response-"));
  const grants = await ViewingGrants.open(join(root, "grants.json"));
  try {
    const grant = await grants.issue({
      streamId: "one",
      revision: "rev",
      label: "stream",
      expiresAt: Date.now() + 60000,
    });
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = viewingResponse(
      new Response(source),
      grants.acquire(grant.token, "one", "rev"),
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const pending = reader.read();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "forbidden",
    });
    await grants.revoke("one", grant.id);
    await rejected;
    expect(cancelled).toBe(true);
  } finally {
    await grants.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps one recording's ticket flood from starving the others", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-ticket-share-"));
  const owner = "5".repeat(64);
  const server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const ids: string[] = [];
    for (const requestId of ["flooded", "quiet"]) {
      const session = await server.store.create({
        ownerId: "local",
        requestId,
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "6".repeat(64),
        title: "Ticket fixture",
        visibility: "public",
      });
      ids.push(session.info.id);
      server.store.release(session);
    }
    const ticket = (id: string) =>
      fetch(`${server.url}/api/v1/streams/${id}/watch-ticket`, {
        method: "POST",
      });
    // Far more anonymous requests for one recording than the whole table holds.
    const flood: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const response = await ticket(ids[0]!);
      expect(response.status).toBe(200);
      flood.push(((await response.json()) as { ticket: string }).ticket);
    }
    // The other recording is unaffected, and its ticket still works.
    const quiet = await ticket(ids[1]!);
    expect(quiet.status).toBe(200);
    const value = ((await quiet.json()) as { ticket: string }).ticket;
    const socket = new WebSocket(
      `${server.url.replace("http", "ws")}/api/v1/watch?ticket=${value}`,
    );
    try {
      await new Promise<void>((done, fail) => {
        socket.once("open", () => done());
        socket.once("error", fail);
      });
      expect(socket.readyState).toBe(1);
    } finally {
      socket.close();
    }
    // The flood recycled its own share rather than the whole table.
    expect(flood.length).toBe(1200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
