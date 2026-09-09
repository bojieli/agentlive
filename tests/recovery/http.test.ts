import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import type { PublishedEvent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const ownerSecret = "b".repeat(64),
  writeSecret = "a".repeat(64);
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const roots: string[] = [];
const sockets: any[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(visibility = "public", maxCachedSessions = 128) {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-http-test-"));
  roots.push(directory);
  const server = await startServer({
    directory,
    ownerSecret,
    port: 0,
    maxCachedSessions,
  });
  servers.push(server);
  const input = {
    requestId: "create_1",
    requestedAt: new Date().toISOString(),
    publisherId: "publisher_1",
    producerEpoch: "epoch_1",
    writeSecret,
    title: "HTTP test",
    visibility,
  };
  const response = await fetch(server.url + "/api/v1/streams", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  const recording = (await response.json()) as {
    streamId: string;
    revision: string;
  };
  return {
    server,
    ...recording,
    input,
    base: server.url + "/api/v1/streams/" + recording.streamId,
  };
}
function connect(url: string, secret?: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  ws.on("message", (data: Buffer) => {
    const value = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else inbox.push(value);
  });
  ws.on("error", (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return {
    ws,
    send: (value: unknown) => ws.send(JSON.stringify(value)),
    next: () =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise<any>((resolve, reject) => {
            const waiter = {
              resolve,
              reject,
              timer: setTimeout(() => {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                reject(new Error("Frame timeout"));
              }, 3000),
            };
            waiters.push(waiter);
          }),
  };
}
function event(streamId: string, producerSeq: number): PublishedEvent {
  return {
    protocolVersion: 1,
    streamId,
    producerEpoch: "epoch_1",
    producerSeq,
    observedAt: "2026-09-09T00:00:00.000Z",
    clockSegmentId: "clock_1",
    elapsedMs: producerSeq,
    fidelity: "delta",
    source: { agent: "synthetic", sessionId: "native_1" },
    content: {
      kind: "message.started",
      payload: { messageId: `m${producerSeq}`, role: "assistant" },
    },
  };
}
async function publisher(
  server: { url: string },
  streamId: string,
  revision: string,
  attempt: number,
) {
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
    attempt,
  });
  expect((await client.next()).type).toBe("resumed");
  return client;
}
it("serves bounded JSONL history and joins live at a fixed boundary", async () => {
  const { server, streamId, revision, base } = await setup();
  const pub = await publisher(server, streamId, revision, 1);
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "batch1",
    events: [event(streamId, 1)],
  });
  expect((await pub.next()).throughProducerSeq).toBe(1);
  const sub = connect(server.url + "/api/v1/watch");
  await sub.next();
  sub.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "sub",
    streamId,
    revision,
    afterServerSeq: 0,
  });
  const boundary = await sub.next();
  expect(boundary.type).toBe("subscribed");
  expect(boundary.boundary.sequence).toBe(2);
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "batch2",
    events: [event(streamId, 2)],
  });
  await pub.next();
  expect((await sub.next()).event.serverSeq).toBe(3);
  const page = await fetch(
    `${base}/events?revision=${revision}&throughServerSeq=2&limit=1`,
  );
  expect(page.status).toBe(200);
  expect(page.headers.get("x-agentlive-complete")).toBe("false");
  expect(
    (await page.text())
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x).serverSeq),
  ).toEqual([1]);
  const rest = await fetch(
    `${base}/events?revision=${revision}&afterServerSeq=1&throughServerSeq=2`,
  );
  expect(rest.headers.get("x-agentlive-complete")).toBe("true");
  expect(JSON.parse((await rest.text()).trim()).serverSeq).toBe(2);
  sub.send({ type: "unsubscribe", protocolVersion: 1, requestId: "exit" });
  expect((await sub.next()).type).toBe("unsubscribed");
});
it("deduplicates lost ACK retries and fences the prior publisher connection", async () => {
  const { server, streamId, revision, base } = await setup();
  const first = await publisher(server, streamId, revision, 1);
  const batch = {
    type: "batch",
    protocolVersion: 1,
    requestId: "batch",
    events: [event(streamId, 1)],
  };
  first.send(batch);
  await first.next();
  const resumed = await publisher(server, streamId, revision, 2);
  resumed.send(batch);
  expect((await resumed.next()).throughProducerSeq).toBe(1);
  first.send({ ...batch, events: [event(streamId, 2)] });
  expect((await first.next()).code).toBe("stale_lease");
  expect((await (await fetch(base)).json()).serverSeq).toBe(2);
});
it("protects private history and uses a single-use scoped browser ticket", async () => {
  const { server, base, streamId, revision } = await setup("private");
  expect((await fetch(base)).status).toBe(403);
  expect(
    (await fetch(base, { headers: { authorization: `Bearer ${ownerSecret}` } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(base, {
        headers: {
          origin: "https://evil.example",
          authorization: `Bearer ${ownerSecret}`,
        },
      })
    ).status,
  ).toBe(403);
  const ticket = await (
    await fetch(base + "/watch-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerSecret}` },
    })
  ).json();
  const sub = connect(server.url + "/api/v1/watch?ticket=" + ticket.ticket);
  await sub.next();
  sub.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "sub",
    streamId,
    revision,
    afterServerSeq: 0,
  });
  expect((await sub.next()).type).toBe("subscribed");
  const replay = connect(server.url + "/api/v1/watch?ticket=" + ticket.ticket);
  await expect(replay.next()).rejects.toThrow("401");
  const anonymous = connect(server.url + "/api/v1/watch");
  await anonymous.next();
  anonymous.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "sub",
    streamId,
    revision,
    afterServerSeq: 0,
  });
  expect((await anonymous.next()).code).toBe("forbidden");
});
it("uploads immutable attachments and serves them only after their event commits", async () => {
  const { server, base, streamId, revision, input } = await setup("public", 1);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 42);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const uploaded = await fetch(base + "/attachments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeSecret}`,
      "x-attachment-sha256": hash,
      "x-attachment-bytes": String(bytes.length),
    },
    body: bytes,
  });
  expect(uploaded.status).toBe(201);
  expect((await fetch(base + "/attachments/" + hash)).status).toBe(409);
  const pub = await publisher(server, streamId, revision, 1);
  const available = event(streamId, 1);
  available.content = {
    kind: "attachment.available",
    payload: {
      attachment: {
        artifactId: "art_1",
        version: 1,
        hash,
        byteSize: bytes.length,
        filename: "test.txt",
        mediaType: "text/plain",
      },
    },
  };
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "bytes",
    events: [available],
  });
  expect((await pub.next()).type).toBe("ack");
  const download = await fetch(base + "/attachments/" + hash);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  pub.ws.close();
  await expect
    .poll(async () => {
      const response = await fetch(server.url + "/api/v1/streams", {
        method: "POST",
        headers: {
          authorization: "Bearer " + ownerSecret,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          requestId: "evict-after-download-open",
        }),
      });
      await response.arrayBuffer();
      return response.status;
    })
    .toBe(201);
  expect(server.store.cacheSize).toBe(1);
  expect(
    createHash("sha256")
      .update(Buffer.from(await download.arrayBuffer()))
      .digest("hex"),
  ).toBe(hash);
});
it("rejects malformed protocol messages and invalid history bounds", async () => {
  const { server, base, revision } = await setup();
  const sub = connect(server.url + "/api/v1/watch");
  await sub.next();
  sub.send(null);
  expect((await sub.next()).code).toBe("invalid_request");
  sub.send({ type: "heartbeat", protocolVersion: 2, requestId: "future" });
  expect((await sub.next()).code).toBe("invalid_request");
  expect(
    (await fetch(`${base}/events?revision=wrong&throughServerSeq=1`)).status,
  ).toBe(409);
  expect(
    (await fetch(`${base}/events?revision=${revision}&throughServerSeq=999`))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(server.url + "/api/v1/streams", {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(401);
});
it("resumes the same recording after a server restart with a fresh connection lease", async () => {
  const { server, streamId, revision } = await setup();
  const pub = await publisher(server, streamId, revision, 1);
  const batch = {
    type: "batch",
    protocolVersion: 1,
    requestId: "batch",
    events: [event(streamId, 1)],
  };
  pub.send(batch);
  expect((await pub.next()).throughProducerSeq).toBe(1);
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const restarted = await startServer({
    directory: roots[roots.length - 1]!,
    ownerSecret,
    port: 0,
  });
  servers.push(restarted);
  const resumed = await publisher(restarted, streamId, revision, 2);
  resumed.send(batch);
  expect((await resumed.next()).throughProducerSeq).toBe(1);
  resumed.send({ ...batch, events: [event(streamId, 2)] });
  expect((await resumed.next()).throughProducerSeq).toBe(2);
  const metadata = await (
    await fetch(restarted.url + "/api/v1/streams/" + streamId)
  ).json();
  expect(metadata.revision).toBe(revision);
  expect(metadata.serverSeq).toBe(3);
});
it("downloads a fixed recording boundary while the publisher continues appending", async () => {
  const { openRecordingHistory } =
    await import("../../packages/client/src/index.js");
  const { server, streamId, revision } = await setup();
  const pub = await publisher(server, streamId, revision, 1);
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "before_replay",
    events: [event(streamId, 1)],
  });
  await pub.next();
  const history = await openRecordingHistory({
    serverOrigin: server.url,
    streamId,
    signal: AbortSignal.timeout(5000),
  });
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "during_replay",
    events: [event(streamId, 2)],
  });
  await pub.next();
  const events = [];
  for await (const event of history.events) events.push(event);
  expect(history.metadata.serverSeq).toBe(2);
  expect(events.map((event) => event.serverSeq)).toEqual([1, 2]);
});

it("holds active publisher ownership and releases failed handshakes under cache pressure", async () => {
  const { server, streamId, revision, input, base } = await setup("public", 1);
  const pub = await publisher(server, streamId, revision, 1);
  const create = () =>
    fetch(server.url + "/api/v1/streams", {
      method: "POST",
      headers: {
        authorization: "Bearer " + ownerSecret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...input, requestId: "another" }),
    });
  const blocked = await create();
  expect(blocked.status).toBe(503);
  expect((await blocked.json()).error.code).toBe("retry_later");
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "still-active",
    events: [event(streamId, 1)],
  });
  expect((await pub.next()).type).toBe("ack");
  pub.ws.close();
  let another = "";
  await expect
    .poll(async () => {
      const response = await create();
      const value = await response.json();
      if (response.status === 201) another = value.streamId;
      return response.status;
    })
    .toBe(201);
  expect(server.store.cacheSize).toBe(1);
  const bad = connect(server.url + "/api/v1/publish", "c".repeat(64));
  await bad.next();
  bad.send({
    type: "resume",
    protocolVersion: 1,
    requestId: "bad",
    streamId,
    revision,
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 2,
  });
  expect((await bad.next()).type).toBe("error");
  expect((await fetch(server.url + "/api/v1/streams/" + another)).status).toBe(
    200,
  );
  expect((await fetch(base)).status).toBe(200);
  expect(server.store.cacheSize).toBe(1);
});

it("keeps a subscribed session resident until explicit unsubscribe", async () => {
  const { server, streamId, revision, input } = await setup("public", 1);
  const sub = connect(server.url + "/api/v1/watch");
  await sub.next();
  sub.send({
    type: "subscribe",
    protocolVersion: 1,
    requestId: "sub",
    streamId,
    revision,
    afterServerSeq: 0,
  });
  expect((await sub.next()).type).toBe("subscribed");
  const create = () =>
    fetch(server.url + "/api/v1/streams", {
      method: "POST",
      headers: {
        authorization: "Bearer " + ownerSecret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...input, requestId: "next-session" }),
    });
  const response = await create();
  expect(response.status).toBe(503);
  await response.arrayBuffer();
  sub.send({ type: "unsubscribe", protocolVersion: 1, requestId: "unsub" });
  expect((await sub.next()).type).toBe("unsubscribed");
  const next = await create();
  expect(next.status).toBe(201);
  await next.arrayBuffer();
  expect(server.store.cacheSize).toBe(1);
});

it("drains queued publisher work before closing sessions or releasing the store lock", async () => {
  const { RecordingStore } = await import("../../packages/server/src/index.js");
  const { server, streamId, revision } = await setup();
  const session = await server.store.get(streamId);
  const directory = server.store.directory;
  const original = session.append.bind(session);
  let unblock!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(session, "append").mockImplementation(async (...args) => {
    entered = true;
    await gate;
    return original(...args);
  });
  const pub = await publisher(server, streamId, revision, 1);
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "during-close",
    events: [event(streamId, 1)],
  });
  await expect.poll(() => entered).toBe(true);
  let finished = false;
  const closing = server.close().then(() => {
    finished = true;
  });
  try {
    await expect(RecordingStore.open(directory)).rejects.toMatchObject({
      code: "publisher_busy",
    });
    expect(finished).toBe(false);
  } finally {
    unblock();
    await closing;
  }
  const reopened = await RecordingStore.open(directory);
  try {
    const retained = await reopened.get(streamId);
    expect(retained.boundary.sequence).toBe(2);
    reopened.release(retained);
  } finally {
    await reopened.close();
  }
});

it("waits for an in-flight HTTP handler after its connection is closed", async () => {
  const { RecordingStore } = await import("../../packages/server/src/index.js");
  const { server, streamId, base } = await setup();
  const session = await server.store.get(streamId);
  const original = session.attachmentStatus.bind(session);
  let unblock!: () => void;
  let entered = false;
  let completed = false;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(session, "attachmentStatus").mockImplementation(async (...args) => {
    entered = true;
    await gate;
    const result = await original(...args);
    completed = true;
    return result;
  });
  const response = fetch(
    base + "/attachments/" + "a".repeat(64) + "/status?byteSize=1",
    { headers: { authorization: "Bearer " + writeSecret } },
  ).then(
    async (result) => {
      await result.arrayBuffer();
    },
    () => {},
  );
  await expect.poll(() => entered).toBe(true);
  const closing = server.close();
  try {
    await expect(
      RecordingStore.open(server.store.directory),
    ).rejects.toMatchObject({ code: "publisher_busy" });
    expect(completed).toBe(false);
  } finally {
    unblock();
    await closing;
    await response;
  }
  expect(completed).toBe(true);
});
