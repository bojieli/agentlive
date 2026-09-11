import { RecordingSnapshotClient } from "../../packages/client/src/index.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
import { openArchive } from "../../packages/storage/src/archive.js";
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
it("imports a live prefix privately under a new identity with portable attachment bytes", async () => {
  const { server, base, streamId, revision } = await setup("public");
  const bytes = Buffer.from("portable version bytes");
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
  const pub = await publisher(server, streamId, revision, 1);
  const available = event(streamId, 1);
  available.content = {
    kind: "attachment.available",
    payload: {
      attachment: {
        artifactId: "portable",
        version: 1,
        hash,
        byteSize: bytes.length,
        filename: "portable.txt",
        mediaType: "text/plain",
      },
    },
  };
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "portable",
    events: [available],
  });
  expect((await pub.next()).type).toBe("ack");
  const output = join(server.store.directory, "live-prefix.agentlive");
  await exportRecording({
    serverOrigin: server.url,
    streamId,
    output,
    signal: AbortSignal.timeout(10000),
  });
  const imported = await importArchiveRecording({
    source: output,
    serverOrigin: server.url,
    credential: ownerSecret,
    signal: AbortSignal.timeout(10000),
  });
  expect(imported.streamId).not.toBe(streamId);
  expect(imported.revision).not.toBe(revision);
  expect(imported.lifecycle).toBe("ended");
  const importedBase = `${server.url}/api/v1/streams/${imported.streamId}`;
  expect((await fetch(importedBase)).status).toBe(403);
  const headers = { authorization: `Bearer ${ownerSecret}` };
  const downloaded = await fetch(`${importedBase}/attachments/${hash}`, {
    headers,
  });
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  expect((await (await fetch(base)).json()).lifecycle).toBe("open");
  const restored = await server.store.get(imported.streamId);
  try {
    const events = [];
    for await (const event of restored.history(0, restored.info.serverSeq))
      events.push(event);
    expect(events[1]!.content).toEqual(available.content);
    expect(events.at(-1)!.content.kind).toBe("recording.ended");
  } finally {
    server.store.release(restored);
  }
});
it("exports an authorized frozen recording that opens independently of the server", async () => {
  const { server, streamId } = await setup("private");
  const denied = await fetch(`${server.url}/api/v1/streams/${streamId}/export`);
  expect(denied.status).toBe(403);
  const output = join(server.store.directory, "portable.agentlive");
  const result = await exportRecording({
    serverOrigin: server.url,
    streamId,
    output,
    credential: ownerSecret,
    signal: AbortSignal.timeout(10000),
  });
  expect(result.throughServerSeq).toBe(1);
  const archive = await openArchive(output);
  try {
    expect(archive.manifest.recording.streamId).toBe(streamId);
    expect(JSON.stringify(archive.manifest)).not.toContain(ownerSecret);
    expect(JSON.stringify(archive.manifest)).not.toContain(writeSecret);
    const events = [];
    for await (const event of archive.events()) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]!.content.kind).toBe("recording.created");
  } finally {
    await archive.close();
  }
});
it("reports unavailable recording storage as unready without leaking paths", async () => {
  const { server } = await setup();
  const sessions = join(server.store.directory, "sessions");
  const moved = join(server.store.directory, "sessions-offline");
  expect((await fetch(server.url + "/readyz")).status).toBe(200);
  await rename(sessions, moved);
  try {
    const response = await fetch(server.url + "/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(server.url + "/healthz")).status).toBe(200);
  } finally {
    await rename(moved, sessions);
  }
  expect((await fetch(server.url + "/readyz")).status).toBe(200);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(
  visibility = "public",
  maxCachedSessions = 128,
  shutdownTimeoutMs = 30_000,
) {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-http-test-"));
  roots.push(directory);
  const server = await startServer({
    directory,
    ownerSecret,
    port: 0,
    maxCachedSessions,
    shutdownTimeoutMs,
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
  // Public response authorization retains the session until bytes are drained.
  const whileDownloading = await fetch(server.url + "/api/v1/streams", {
    method: "POST",
    headers: {
      authorization: "Bearer " + ownerSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...input, requestId: "evict-after-download-open" }),
  });
  expect(whileDownloading.status).toBe(503);
  await whileDownloading.arrayBuffer();
  expect(
    createHash("sha256")
      .update(Buffer.from(await download.arrayBuffer()))
      .digest("hex"),
  ).toBe(hash);
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

it.each([30_000, 30])(
  "drains queued publisher work before releasing ownership (deadline=%s)",
  async (shutdownTimeoutMs) => {
    const { RecordingStore } =
      await import("../../packages/server/src/index.js");
    const { server, streamId, revision } = await setup(
      "public",
      128,
      shutdownTimeoutMs,
    );
    if (shutdownTimeoutMs === 30) servers.splice(servers.indexOf(server), 1);
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
      if (shutdownTimeoutMs === 30)
        await expect(closing).rejects.toMatchObject({
          code: "shutdown_timeout",
        });
      await expect(RecordingStore.open(directory)).rejects.toMatchObject({
        code: "publisher_busy",
      });
      expect(finished).toBe(false);
    } finally {
      unblock();
      await server.whenClosed();
      if (shutdownTimeoutMs !== 30) await closing;
    }
    const reopened = await RecordingStore.open(directory);
    try {
      const retained = await reopened.get(streamId);
      expect(retained.boundary.sequence).toBe(2);
      reopened.release(retained);
    } finally {
      await reopened.close();
    }
  },
);

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

it.each([false, true])(
  "bounds shutdown waiting while retaining ownership and observing late cleanup (failure=%s)",
  async (fail) => {
    const { RecordingStore } =
      await import("../../packages/server/src/index.js");
    const { server, streamId } = await setup("public", 128, 30);
    servers.splice(servers.indexOf(server), 1);
    const session = await server.store.get(streamId);
    const original = session.close.bind(session);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const spy = vi.spyOn(session, "close").mockImplementation(async () => {
      await gate;
      await original();
      if (fail) throw new Error("late cleanup failure");
    });
    const closing = server.close();
    expect(server.close()).toBe(closing);
    const started = performance.now();
    try {
      await expect(closing).rejects.toMatchObject({
        code: "shutdown_timeout",
        timeoutMs: 30,
      });
      expect(performance.now() - started).toBeLessThan(2000);
      await expect(
        RecordingStore.open(server.store.directory),
      ).rejects.toMatchObject({ code: "publisher_busy" });
      expect(server.close()).toBe(closing);
    } finally {
      const drained = server.whenClosed();
      unblock();
      if (fail) await expect(drained).rejects.toThrow("Server shutdown failed");
      else await drained;
    }
    expect(spy).toHaveBeenCalledTimes(1);
    const reopened = await RecordingStore.open(server.store.directory);
    await reopened.close();
  },
);

it("finishes before the shutdown deadline and exposes the actual completion", async () => {
  const { server } = await setup("public", 128, 5000);
  await server.close();
  await server.whenClosed();
  expect(server.close()).toBe(server.close());
});

it.each([0, -1, 0.5, NaN, Infinity, 2147483648])(
  "rejects invalid shutdown deadlines before acquiring the store (%s)",
  async (shutdownTimeoutMs) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-deadline-test-"));
    roots.push(directory);
    await expect(
      startServer({ directory, ownerSecret, port: 0, shutdownTimeoutMs }),
    ).rejects.toThrow("shutdownTimeoutMs");
    const { RecordingStore } =
      await import("../../packages/server/src/index.js");
    const store = await RecordingStore.open(directory);
    await store.close();
  },
);

it("lists owner recordings in bounded pages without evicting active sessions or exposing credentials", async () => {
  const { listRecordings } = await import("../../packages/client/src/index.js");
  const { server, input, streamId, revision } = await setup("private", 1);
  const expected = [streamId];
  for (let index = 0; index < 4; index++) {
    const session = await server.store.create({
      ...input,
      ownerId: index === 3 ? "another-owner" : "local",
      requestId: `listing-${index}`,
    });
    if (index !== 3) expected.push(session.info.id);
    server.store.release(session);
  }
  const pub = await publisher(server, streamId, revision, 1);
  const settings = {
    serverOrigin: server.url,
    credential: ownerSecret,
    signal: AbortSignal.timeout(5000),
    limit: 2,
  };
  const first = await listRecordings(settings);
  expect(first.recordings).toHaveLength(2);
  expect(first.nextAfter).not.toBeNull();
  const second = await listRecordings({ ...settings, after: first.nextAfter! });
  expect(second.nextAfter).toBeNull();
  expect(
    [...first.recordings, ...second.recordings].map(
      (recording) => recording.id,
    ),
  ).toEqual(expected.sort());
  for (const recording of first.recordings)
    expect(Object.keys(recording).sort()).toEqual([
      "createdAt",
      "id",
      "revision",
      "title",
      "visibility",
    ]);
  expect(server.store.cacheSize).toBe(1);
  pub.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "after-list",
    events: [event(streamId, 1)],
  });
  expect((await pub.next()).type).toBe("ack");
  for (const credential of [undefined, writeSecret]) {
    const response = await fetch(server.url + "/api/v1/streams", {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
    });
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain(streamId);
  }
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "after=../secret",
  ]) {
    const response = await fetch(server.url + "/api/v1/streams?" + query, {
      headers: { authorization: `Bearer ${ownerSecret}` },
    });
    expect(response.status).toBe(400);
    await response.arrayBuffer();
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { resolve } = await import("node:path");
  const command = await promisify(execFile)(
    process.execPath,
    [
      resolve("packages/cli/dist/main.js"),
      "list",
      "--server",
      server.url,
      "--limit",
      "2",
    ],
    { env: { ...process.env, AGENTLIVE_OWNER_SECRET: ownerSecret } },
  );
  expect(JSON.parse(command.stdout)).toEqual(first);
  await server.close();
  const restarted = await startServer({
    directory: server.store.directory,
    ownerSecret,
    port: 0,
    maxCachedSessions: 1,
  });
  servers.push(restarted);
  expect(
    await listRecordings({
      ...settings,
      serverOrigin: restarted.url,
      signal: AbortSignal.timeout(5000),
    }),
  ).toEqual(first);
  expect(restarted.store.cacheSize).toBe(0);
});

it("publishes revision-bound snapshots and serves verified content only to authorized readers", async () => {
  const { server, base, streamId, revision } = await setup("private");
  const { openRecordingSnapshot } =
    await import("../../packages/playback/src/index.js");
  const headers = {
    authorization: `Bearer ${writeSecret}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify({ revision, throughServerSeq: 1 });
  expect(
    (
      await fetch(base + "/snapshots", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await fetch(base + `/snapshots?revision=${revision}&throughServerSeq=1`))
      .status,
  ).toBe(403);
  const empty = await fetch(
    base + `/snapshots?revision=${revision}&throughServerSeq=1`,
    { headers },
  );
  expect((await empty.json()).snapshot).toBeNull();
  const created = await fetch(base + "/snapshots", {
    method: "POST",
    body,
    headers,
  });
  expect(created.status).toBe(201);
  const descriptor = (await created.json()).snapshot;
  const blobUrl =
    base +
    `/snapshot-blobs/${descriptor.ref.hash}?${new URLSearchParams({ revision, byteSize: String(descriptor.ref.byteSize), units: String(descriptor.ref.units) })}`;
  expect((await fetch(blobUrl)).status).toBe(403);
  const wrongBlob = new URL(blobUrl);
  wrongBlob.searchParams.set("revision", "other");
  expect((await fetch(wrongBlob, { headers })).status).toBe(409);
  const blobReply = await fetch(blobUrl, { headers });
  expect(blobReply.status).toBe(200);
  const bytes = Buffer.from((await blobReply.json()).base64, "base64");
  expect(bytes.length).toBe(descriptor.ref.byteSize);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    descriptor.ref.hash,
  );

  const retry = await fetch(base + "/snapshots", {
    method: "POST",
    body,
    headers,
  });
  expect((await retry.json()).snapshot).toEqual(descriptor);
  const query = new URLSearchParams({
    revision,
    byteSize: String(descriptor.ref.byteSize),
    units: String(descriptor.ref.units),
    offset: "0",
    length: String(descriptor.ref.units),
  });
  const contentUrl = base + `/snapshot-content/${descriptor.ref.hash}?${query}`;
  expect((await fetch(contentUrl)).status).toBe(403);
  const wrong = new URL(contentUrl);
  wrong.searchParams.set("revision", "other");
  expect((await fetch(wrong, { headers })).status).toBe(409);
  const content = {
    put: async () => {
      throw new Error("Read-only HTTP content");
    },
    read: async (
      ref: { hash: string; byteSize: number; units: number },
      offset: number,
      length: number,
    ) => {
      const query = new URLSearchParams({
        revision,
        byteSize: String(ref.byteSize),
        units: String(ref.units),
        offset: String(offset),
        length: String(length),
      });
      const response = await fetch(
        base + `/snapshot-content/${ref.hash}?${query}`,
        { headers },
      );
      expect(response.status).toBe(200);
      return (await response.json()).text;
    },
  };
  const snapshot = await openRecordingSnapshot(
    descriptor,
    { streamId, revision },
    content,
  );
  expect(await snapshot.materialize()).toMatchObject({
    title: "HTTP test",
    appliedSeq: 1,
  });
  const { RecordingSnapshotClient } =
    await import("../../packages/client/src/index.js");
  const client = new RecordingSnapshotClient({
    serverOrigin: server.url,
    streamId,
    revision,
    credential: writeSecret,
  });
  try {
    const opened = await client.publish(1, AbortSignal.timeout(5000));
    expect(opened.descriptor).toEqual(descriptor);
    const selected = await client.select(1, AbortSignal.timeout(5000));
    expect(await selected!.reader.materialize()).toStrictEqual(
      await snapshot.materialize(),
    );
    expect(await client.select(0, AbortSignal.timeout(5000))).toBeNull();
  } finally {
    client.close();
  }
  const invalid = await fetch(base + "/snapshots", {
    method: "POST",
    headers,
    body: JSON.stringify({ revision, throughServerSeq: 2 }),
  });
  expect(invalid.status).toBe(400);
});

it("loads exact Unicode text ranges through the shared snapshot client", async () => {
  const { server, streamId, revision } = await setup("private");
  const { RecordingSnapshotClient } =
    await import("../../packages/client/src/index.js");
  const session = await server.store.get(streamId);
  try {
    const { lease } = await session.resume(writeSecret, {
      publisherId: "publisher_1",
      producerEpoch: "epoch_1",
      attempt: 1,
      revision,
    });
    const text = "x".repeat(16383) + "🦊\ud800" + "tail";
    const base = {
      protocolVersion: 1 as const,
      streamId,
      producerEpoch: "epoch_1",
      observedAt: "2026-09-09T00:00:00Z",
      clockSegmentId: "clock",
      fidelity: "delta" as const,
      source: { agent: "synthetic" as const, sessionId: "native" },
    };
    await session.append(lease, [
      {
        ...base,
        producerSeq: 1,
        elapsedMs: 0,
        content: {
          kind: "message.started",
          payload: { messageId: "message", role: "assistant" },
        },
      },
      {
        ...base,
        producerSeq: 2,
        elapsedMs: 1,
        content: {
          kind: "message.text.append",
          payload: { messageId: "message", text },
        },
      },
    ]);
    const client = new RecordingSnapshotClient({
      serverOrigin: server.url,
      streamId,
      revision,
      credential: writeSecret,
    });
    try {
      const { reader, descriptor } = await client.publish(
        session.info.serverSeq,
        AbortSignal.timeout(5000),
      );
      expect(reader).toHaveProperty("format", "agentlive.paged-state");
      if (!("format" in reader) || reader.format !== "agentlive.paged-state")
        throw new Error("Expected paged snapshot");
      const contents = (await reader.get("messages", "message"))!.text;
      expect(await reader.text(contents, 16383, 1)).toBe("\ud83e");
      expect(await reader.text(contents, 16384, 3)).toBe("\udd8a\ud800t");
      expect(await reader.text(contents, 16380, 9)).toBe(
        text.slice(16380, 16389),
      );
      const { TextStore } = await import("../../packages/storage/src/index.js");
      const { PagedReducer, ActivityIndex } =
        await import("../../packages/playback/src/index.js");
      const directory = await mkdtemp(
        join(tmpdir(), "agentlive-http-disk-snapshot-"),
      );
      roots.push(directory);
      let downloaded = 0;
      let disk = await TextStore.open(
        directory,
        undefined,
        async (ref, active) => {
          downloaded++;
          return client.readBlob(ref, active);
        },
      );
      try {
        const binding = { streamId, revision },
          signal = AbortSignal.timeout(10000);
        const reducer = new PagedReducer(disk),
          index = new ActivityIndex(disk);
        let state = await reducer.open(descriptor.ref, binding, signal);
        let rows = await index.open(descriptor.activity!, binding, signal);
        expect(await reducer.materialize(state, undefined, signal)).toEqual(
          await reader.materialize(),
        );
        await session.append(lease, [
          {
            ...base,
            producerSeq: 3,
            elapsedMs: 2,
            content: {
              kind: "message.text.append",
              payload: { messageId: "message", text: " suffix" },
            },
          },
        ]);
        for await (const event of session.history(
          descriptor.serverSeq,
          session.info.serverSeq,
        )) {
          state = await reducer.apply(state, event, signal);
          rows = await index.apply(rows, event, state, reducer, signal);
        }
        const checkpoint = await reducer.checkpoint(state, binding, signal);
        const activity = await index.checkpoint(rows, binding, signal);
        const expected = await reducer.materialize(state, undefined, signal);
        expect(expected.messages.get("message")!.text).toBe(text + " suffix");
        expect(downloaded).toBeGreaterThan(0);
        await disk.close();
        client.close();
        disk = await TextStore.open(directory);
        const reopened = new PagedReducer(disk);
        expect(
          await reopened.materialize(
            await reopened.open(checkpoint, binding, signal),
            undefined,
            signal,
          ),
        ).toEqual(expected);
        expect(
          (await new ActivityIndex(disk).open(activity, binding, signal))
            .appliedSeq,
        ).toBe(state.appliedSeq);
      } finally {
        await disk.close();
      }
      client.close();
      await expect(reader.text(contents, 0, 1)).rejects.toThrow("closed");
    } finally {
      client.close();
    }
  } finally {
    server.store.release(session);
  }
});
it("authorizes durable snapshot leases independently of their tokens and fences revision and release", async () => {
  const { base, revision } = await setup("private");
  const headers = {
    authorization: `Bearer ${writeSecret}`,
    "content-type": "application/json",
  };
  const acquire = (extraHeaders = headers, selectedRevision = revision) =>
    fetch(base + "/snapshot-leases", {
      method: "POST",
      headers: extraHeaders,
      body: JSON.stringify({ revision: selectedRevision, throughServerSeq: 0 }),
    });
  expect(
    (await acquire({ "content-type": "application/json" } as typeof headers))
      .status,
  ).toBe(403);
  const absent = await acquire();
  expect(absent.status).toBe(201);
  expect((await absent.json()).lease).toBeNull();
  expect(
    (
      await fetch(base + "/snapshots", {
        method: "POST",
        headers,
        body: JSON.stringify({ revision, throughServerSeq: 0 }),
      })
    ).status,
  ).toBe(201);
  const selected = await acquire();
  expect(selected.status).toBe(201);
  const envelope = await selected.json();
  expect(envelope.revision).toBe(revision);
  expect(envelope.lease.snapshot.activity).toBeDefined();
  const leasedClient = new RecordingSnapshotClient({
    serverOrigin: new URL(base).origin,
    streamId: envelope.streamId,
    revision,
    credential: writeSecret,
  });
  try {
    expect(
      (await leasedClient.openLease(envelope.lease, AbortSignal.timeout(5000)))
        .descriptor,
    ).toEqual(envelope.lease.snapshot);
  } finally {
    leasedClient.close();
  }
  const root = envelope.lease.snapshot.ref;
  const query = new URLSearchParams({
    revision,
    byteSize: String(root.byteSize),
    units: String(root.units),
    lease: envelope.lease.token,
  });
  const blobUrl = base + `/snapshot-blobs/${root.hash}?${query}`;
  const rangeUrl =
    base + `/snapshot-content/${root.hash}?${query}&offset=0&length=1`;
  expect((await fetch(blobUrl, { headers })).status).toBe(200);
  expect((await fetch(rangeUrl, { headers })).status).toBe(200);
  expect((await fetch(blobUrl)).status).toBe(403);
  const leasePath = base + "/snapshot-leases/" + envelope.lease.token;
  const renew = (extraHeaders = headers, selectedRevision = revision) =>
    fetch(leasePath + "/renew", {
      method: "POST",
      headers: extraHeaders,
      body: JSON.stringify({ revision: selectedRevision }),
    });
  expect(
    (await renew({ "content-type": "application/json" } as typeof headers))
      .status,
  ).toBe(403);
  expect((await renew(headers, "wrong")).status).toBe(409);
  const renewed = await renew();
  expect(renewed.status).toBe(200);
  expect((await renewed.json()).lease.snapshot).toEqual(
    envelope.lease.snapshot,
  );
  expect(
    (await fetch(leasePath + `?revision=${revision}`, { method: "DELETE" }))
      .status,
  ).toBe(403);
  expect((await renew()).status).toBe(200);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await fetch(leasePath + `?revision=${revision}`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(204);
  for (const url of [blobUrl, rangeUrl]) {
    const read = await fetch(url, { headers });
    expect(read.status).toBe(409);
    expect((await read.json()).error.code).toBe("stale_lease");
  }
  const staleClient = new RecordingSnapshotClient({
    serverOrigin: new URL(base).origin,
    streamId: envelope.streamId,
    revision,
    credential: writeSecret,
  });
  try {
    await expect(
      staleClient.openLease(envelope.lease, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await expect(
      staleClient.readBlob(
        root,
        AbortSignal.timeout(5000),
        envelope.lease.token,
      ),
    ).rejects.toMatchObject({ code: "stale_lease" });
  } finally {
    staleClient.close();
  }
  const stale = await renew();
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe("stale_lease");
  expect((await acquire(headers, "wrong")).status).toBe(409);
});
