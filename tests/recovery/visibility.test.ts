import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { viewingResponse } from "../../packages/server/src/viewing-response.js";
const { WebSocket } = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("ws");
it("persists owner visibility changes and denies old anonymous tickets after public becomes private", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-visibility-"));
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
      requestId: "visibility",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: writer,
      title: "Visibility",
      visibility: "public",
    });
    const id = session.info.id,
      revision = session.info.revision;
    const base = `/api/v1/streams/${id}`;
    const call = (suffix: string, body?: unknown, credential = owner) =>
      fetch(server.url + base + suffix, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const ticket = async () =>
      (
        await (
          await fetch(server.url + base + "/watch-ticket", { method: "POST" })
        ).json()
      ).ticket;
    const unused = await ticket();
    const connect = async (value: string) => {
      const socket = new WebSocket(
        server.url.replace("http:", "ws:") + `/api/v1/watch?ticket=${value}`,
      );
      sockets.push(socket);
      const messages: any[] = [];
      socket.on("message", (data: Buffer) =>
        messages.push(JSON.parse(data.toString())),
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
          streamId: id,
          revision,
          afterServerSeq: 0,
        }),
      );
      return { socket, messages };
    };
    const active = await connect(await ticket());
    await expect
      .poll(() => active.messages.some((m) => m.type === "subscribed"))
      .toBe(true);
    const change = {
      revision,
      operationId: "private",
      expectedVersion: 0,
      visibility: "private" as const,
    };
    expect((await call("/visibility", change, writer)).status).toBe(401);
    const save = vi
      .spyOn(session as unknown as { save: () => Promise<void> }, "save")
      .mockRejectedValueOnce(new Error("disk failed"));
    await expect(session.changeVisibility(change)).rejects.toThrow(
      "disk failed",
    );
    save.mockRestore();
    expect(session.visibilityState.visibility).toBe("public");
    const closed = new Promise((resolve) =>
      active.socket.once("close", resolve),
    );
    expect((await call("/visibility", change)).status).toBe(200);
    await closed;
    expect((await call("/visibility", change)).status).toBe(200);
    expect((await fetch(server.url + base)).status).toBe(403);
    const denied = await connect(unused);
    await expect
      .poll(() => denied.messages.some((m) => m.type === "error"))
      .toBe(true);
    expect(denied.messages.some((m) => m.type === "subscribed")).toBe(false);
    expect(
      (await (await fetch(server.url + "/api/v1/public-recordings")).json())
        .recordings,
    ).toEqual([]);
    const unlisted = {
      ...change,
      operationId: "unlisted",
      expectedVersion: 1,
      visibility: "unlisted",
    };
    expect((await call("/visibility", unlisted)).status).toBe(200);
    expect((await call("/visibility", change)).status).toBe(409);
    expect((await fetch(server.url + base)).status).toBe(200);
    await expect(session.shareEnded("public")).rejects.toThrow(
      "versioned visibility",
    );
    server.store.release(session);
    for (const socket of sockets) socket.terminate();
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    expect(await (await call("/visibility")).json()).toMatchObject({
      version: 2,
      visibility: "unlisted",
    });
    expect(
      (
        await call("/visibility", {
          ...change,
          operationId: "public",
          expectedVersion: 2,
          visibility: "public",
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await fetch(server.url + "/api/v1/public-recordings")).json())
        .recordings[0].id,
    ).toBe(id);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels public response sources after durable restriction and guards responses still being prepared", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-visibility-response-"));
  const server = await startServer({
    directory: root,
    ownerSecret: "a".repeat(64),
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "response",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "b".repeat(64),
      title: "Public response",
      visibility: "public",
    });
    const change = {
      revision: session.info.revision,
      operationId: "restrict",
      expectedVersion: 0,
      visibility: "private" as const,
    };
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const access = session.acquirePublicRead()!;
    const reader = viewingResponse(
      new Response(source),
      access,
    ).body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const pending = reader.read();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "forbidden",
    });
    const save = vi
      .spyOn(session as unknown as { save: () => Promise<void> }, "save")
      .mockRejectedValueOnce(new Error("failed persist"));
    await expect(session.changeVisibility(change)).rejects.toThrow(
      "failed persist",
    );
    save.mockRestore();
    expect(access.signal.aborted).toBe(false);
    const original = session.history.bind(session);
    let unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const history = vi
      .spyOn(session, "history")
      .mockImplementation(async function* (after, through) {
        entered();
        await blocked;
        yield* original(after, through);
      });
    const url = `${server.url}/api/v1/streams/${session.info.id}/events?revision=${session.info.revision}&throughServerSeq=${session.boundary.sequence}`;
    const responseTask = fetch(url).then(
      async (response) => {
        try {
          return { ok: response.ok, text: await response.text() };
        } catch {
          return { ok: false, text: "" };
        }
      },
      () => ({ ok: false, text: "" }),
    );
    await started;
    await session.changeVisibility(change);
    await rejected;
    expect(cancelled).toBe(true);
    unblock();
    const response = await responseTask;
    expect(response.ok).toBe(false);
    expect(response.text).not.toContain("Public response");
    history.mockRestore();
    expect(session.acquirePublicRead()).toBeUndefined();
    server.store.release(session);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
