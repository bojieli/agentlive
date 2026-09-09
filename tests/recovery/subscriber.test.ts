import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../packages/server/src/http.js";
import {
  SubscriberClient,
  type SubscriberOptions,
} from "../../packages/client/src/index.js";
import type {
  PublishedEvent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const runs: { abort: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const run of runs) run.abort.abort();
  await Promise.all(runs.splice(0).map((x) => x.done.catch(() => {})));
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(visibility: "public" | "private" = "public") {
  const root = await mkdtemp(join(tmpdir(), "agentlive-subscriber-test-"));
  roots.push(root);
  const server = await startServer({
    directory: root,
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  servers.push(server);
  const session = await server.store.create({
    ownerId: "local",
    requestId: "req1",
    requestedAt: new Date().toISOString(),
    publisherId: "pub1",
    producerEpoch: "epoch1",
    writeSecret: "a".repeat(64),
    title: "Subscriber integration",
    visibility,
  });
  const { lease } = await session.resume("a".repeat(64), {
    publisherId: "pub1",
    producerEpoch: "epoch1",
    attempt: 1,
    revision: session.info.revision,
  });
  let producerSeq = 0;
  const publish = async (count: number, spacingMs = 1) => {
    const events: PublishedEvent[] = Array.from({ length: count }, () => ({
      protocolVersion: 1,
      streamId: session.info.id,
      producerEpoch: "epoch1",
      producerSeq: ++producerSeq,
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock1",
      elapsedMs: producerSeq * spacingMs,
      fidelity: "delta",
      source: { agent: "synthetic", sessionId: "native1" },
      content: {
        kind: "message.started",
        payload: { messageId: `m${producerSeq}`, role: "assistant" },
      },
    }));
    await session.append(lease, events);
  };
  const options = {
    serverOrigin: server.url,
    cursor: {
      streamId: session.info.id,
      revision: session.info.revision,
      serverSeq: 0,
    },
    retryMinMs: 5,
    retryMaxMs: 10,
  };
  return { root, server, session, publish, options };
}
function run(options: SubscriberOptions) {
  const client = new SubscriberClient(options);
  const abort = new AbortController();
  const done = client.run(abort.signal);
  void done.catch(() => {});
  runs.push({ abort, done });
  return { client, abort, done };
}
it("catches up paged history and continues live without duplicating committed events", async () => {
  const { publish, options } = await setup();
  await publish(7);
  const seen: number[] = [];
  const first = deferred(),
    finished = deferred();
  const { client, abort, done } = run({
    ...options,
    pageSize: 2,
    commit: async (events, cursor) => {
      seen.push(...events.map((x) => x.serverSeq));
      if (cursor.serverSeq === 8) first.resolve();
      if (cursor.serverSeq === 11) finished.resolve();
    },
  });
  await first.promise;
  await publish(3);
  await finished.promise;
  abort.abort();
  await done;
  expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  expect(client.cursor.serverSeq).toBe(11);
});
it("bounds live memory while a consumer is slow and recovers evicted events from history", async () => {
  const { publish, options } = await setup();
  const entered = deferred(),
    release = deferred(),
    finished = deferred();
  const seen: number[] = [];
  let reads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("/events?")) reads++;
    return fetch(input, init);
  };
  const { abort, done } = run({
    ...options,
    maxLiveBytes: 1,
    pageSize: 3,
    fetch: fetcher,
    commit: async (events, cursor) => {
      if (cursor.serverSeq === 1) {
        entered.resolve();
        await release.promise;
      }
      seen.push(...events.map((x) => x.serverSeq));
      if (cursor.serverSeq === 21) finished.resolve();
    },
  });
  await entered.promise;
  await publish(20);
  release.resolve();
  await finished.promise;
  abort.abort();
  await done;
  expect(seen).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  expect(reads).toBeGreaterThan(2);
});
it("reconnects after a dropped socket and resumes from the committed cursor", async () => {
  const { publish, options } = await setup();
  const sockets: WebSocket[] = [];
  const caught = deferred(),
    finished = deferred();
  const seen: number[] = [];
  const { abort, done } = run({
    ...options,
    webSocket: (url) => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      return ws;
    },
    commit: async (events, cursor) => {
      seen.push(...events.map((x) => x.serverSeq));
      if (cursor.serverSeq === 1) caught.resolve();
      if (cursor.serverSeq === 6) finished.resolve();
    },
  });
  await caught.promise;
  sockets[0]!.close();
  await publish(5);
  await finished.promise;
  abort.abort();
  await done;
  expect(sockets.length).toBeGreaterThan(1);
  expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
});
it("does not advance or automatically retry a failed state transaction", async () => {
  const { options } = await setup();
  const { client, done } = run({
    ...options,
    commit: async () => {
      throw new Error("disk full");
    },
  });
  await expect(done).rejects.toThrow("Subscriber state commit failed");
  expect(client.cursor.serverSeq).toBe(0);
});
it("fails explicitly when cached state has the wrong revision or exceeds retained history", async () => {
  const { options } = await setup();
  const wrong = run({
    ...options,
    cursor: { ...options.cursor, revision: "different" },
    commit: async () => {
      throw new Error("must not commit");
    },
  });
  await expect(wrong.done).rejects.toMatchObject({ code: "revision_changed" });
  const ahead = run({
    ...options,
    cursor: { ...options.cursor, serverSeq: 999 },
    commit: async () => {
      throw new Error("must not commit");
    },
  });
  await expect(ahead.done).rejects.toMatchObject({ code: "cursor_invalid" });
});
it("joins private recordings with a viewing ticket and leaves credentials out of socket URLs", async () => {
  const { options } = await setup("private");
  const finished = deferred();
  let socketUrl = "";
  const { abort, done } = run({
    ...options,
    credential: "b".repeat(64),
    webSocket: (url) => {
      socketUrl = url;
      return new WebSocket(url);
    },
    commit: async () => {
      finished.resolve();
    },
  });
  await finished.promise;
  abort.abort();
  await done;
  expect(socketUrl).toContain("?ticket=");
  expect(socketUrl).not.toContain("b".repeat(64));
  const denied = run({
    ...options,
    commit: async () => {
      throw new Error("must not commit");
    },
  });
  await expect(denied.done).rejects.toMatchObject({ code: "forbidden" });
});
it("restores an existing receipt cursor without replaying already committed state", async () => {
  const { options, publish } = await setup();
  await publish(4);
  const finished = deferred();
  const seen: number[] = [];
  const { abort, done } = run({
    ...options,
    cursor: { ...options.cursor, serverSeq: 3 },
    commit: async (events, cursor) => {
      seen.push(...events.map((x) => x.serverSeq));
      if (cursor.serverSeq === 5) finished.resolve();
    },
  });
  await finished.promise;
  abort.abort();
  await done;
  expect(seen).toEqual([4, 5]);
});
it("rejects a truncated history page without advancing the cursor", async () => {
  const { options } = await setup();
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes("/events?"))
      return new Response((await response.text()).trimEnd(), {
        headers: response.headers,
      });
    return response;
  };
  const { client, done } = run({
    ...options,
    fetch: fetcher,
    commit: async () => {
      throw new Error("must not commit");
    },
  });
  await expect(done).rejects.toMatchObject({ code: "invalid_request" });
  expect(client.cursor.serverSeq).toBe(0);
});

it("resumes a durable subscriber prefix after process restart without a separate cursor checkpoint", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, session, publish, options } = await setup("private");
  await publish(3);
  const cacheOptions = {
    serverOrigin: options.serverOrigin,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(
    join(root, "subscriber"),
    cacheOptions,
  );
  async function catchUp() {
    const active = run({
      ...options,
      cursor: cache.cursor,
      credential: "b".repeat(64),
      commit: (events, cursor) => cache.commit(events, cursor),
    });
    await expect
      .poll(() => cache.cursor.serverSeq)
      .toBe(session.boundary.sequence);
    active.abort.abort();
    await active.done;
  }
  await catchUp();
  const baseline = cache.cursor.serverSeq;
  await cache.close();
  await publish(2);
  cache = await SubscriberCache.open(join(root, "subscriber"), {
    ...cacheOptions,
    initialize: async () => {
      throw new Error("Existing cache must reopen offline");
    },
  });
  try {
    expect(cache.cursor.serverSeq).toBe(baseline);
    await catchUp();
    const retained = [];
    for await (const event of cache.events()) retained.push(event.serverSeq);
    expect(retained).toEqual(
      Array.from(
        { length: session.boundary.sequence },
        (_, index) => index + 1,
      ),
    );
    await expect(
      cache.commit([], { ...cache.cursor, revision: "other_revision" }),
    ).rejects.toThrow("revision changed");
    await expect(
      cache.commit([], {
        ...cache.cursor,
        serverSeq: cache.cursor.serverSeq + 1,
      }),
    ).rejects.toThrow("receipt");
    expect(cache.cursor.serverSeq).toBe(session.boundary.sequence);
  } finally {
    await cache.close();
  }
});

it("recovers only complete cache records and refuses rebinding orphaned cached history", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { readdir, appendFile, rm } = await import("node:fs/promises");
  const { root, session, options } = await setup();
  const cacheRoot = join(root, "subscriber");
  const settings = {
    serverOrigin: options.serverOrigin,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(cacheRoot, settings);
  const events = [];
  for await (const event of session.history(0, session.boundary.sequence))
    events.push(event);
  await cache.commit(events, { ...cache.cursor, serverSeq: events.length });
  await cache.close();
  const directory = join(cacheRoot, (await readdir(cacheRoot))[0]!);
  await appendFile(join(directory, "events.jsonl"), '{"partial":');
  cache = await SubscriberCache.open(cacheRoot, settings);
  expect(cache.cursor.serverSeq).toBe(events.length);
  await cache.close();
  await rm(join(directory, "recording.json"));
  await expect(SubscriberCache.open(cacheRoot, settings)).rejects.toThrow(
    "manifest is missing",
  );
});

it("watch renders cached history independently during an offline reconnect", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { root, server, session, options } = await setup("private");
  let output = "";
  const controller = new AbortController();
  await watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: "b".repeat(64),
    cacheRoot: join(root, "viewer"),
    signal: controller.signal,
    write: async (text) => {
      output += text;
      controller.abort();
    },
  });
  expect(output).toContain("Subscriber integration");
  const baseline = output;
  await server.close();
  output = "";
  const offline = new AbortController();
  await watchRecording({
    serverOrigin: options.serverOrigin,
    streamId: session.info.id,
    cacheRoot: join(root, "viewer"),
    signal: offline.signal,
    write: async (text) => {
      output += text;
      offline.abort();
    },
  });
  expect(output).toBe(baseline);
});

it("retains committed events if terminal output fails and releases the cache for recovery", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session } = await setup();
  const cacheRoot = join(root, "failed-viewer");
  await expect(
    watchRecording({
      serverOrigin: server.url,
      streamId: session.info.id,
      cacheRoot,
      signal: AbortSignal.timeout(5000),
      write: async () => {
        throw new Error("Output disconnected");
      },
    }),
  ).rejects.toThrow("Output disconnected");
  const cache = await SubscriberCache.open(cacheRoot, {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => {
      throw new Error("Should already be durable");
    },
  });
  try {
    expect(cache.cursor.serverSeq).toBe(session.boundary.sequence);
  } finally {
    await cache.close();
  }
});

it("enforces cache storage limits without advancing receipt", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session } = await setup();
  const cache = await SubscriberCache.open(join(root, "tiny-cache"), {
    serverOrigin: server.url,
    streamId: session.info.id,
    maxBytes: 1,
    initialize: async () => ({ revision: session.info.revision }),
  });
  try {
    const events = [];
    for await (const event of session.history(0, session.boundary.sequence))
      events.push(event);
    await expect(
      cache.commit(events, { ...cache.cursor, serverSeq: events.length }),
    ).rejects.toThrow("storage limit");
    expect(cache.cursor.serverSeq).toBe(0);
  } finally {
    await cache.close();
  }
});

it("continues durable receipt while presentation is paused and replays its backlog in order", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { root, server, session, publish } = await setup();
  const gate = new PlaybackPacer();
  gate.setPaused(true);
  const abort = new AbortController();
  let receipt = 0;
  const presented: number[] = [];
  const done = watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot: join(root, "paused"),
    signal: abort.signal,
    presentation: gate,
    write: async () => {},
    onReceipt: (seq) => {
      receipt = seq;
    },
    onPresented: (seq) => {
      presented.push(seq);
    },
  });
  runs.push({ abort, done });
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  await publish(20);
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  expect(presented).toEqual([]);
  gate.setPaused(false);
  await expect.poll(() => presented.length).toBe(receipt);
  expect(presented).toEqual(
    Array.from({ length: receipt }, (_, index) => index + 1),
  );
  abort.abort();
  await done;
});
it("keeps receiving behind a stalled output sink and cancels without waiting for that sink", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session, publish } = await setup();
  const abort = new AbortController();
  const blocked = deferred();
  const entered = deferred();
  let receipt = 0;
  const cacheRoot = join(root, "stalled");
  const done = watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot,
    signal: abort.signal,
    write: async () => {
      entered.resolve();
      await blocked.promise;
    },
    onReceipt: (seq) => {
      receipt = seq;
    },
  });
  runs.push({ abort, done });
  await entered.promise;
  await publish(20);
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  abort.abort();
  await done;
  const cache = await SubscriberCache.open(cacheRoot, {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => {
      throw new Error("Cache should exist");
    },
  });
  try {
    expect(cache.cursor.serverSeq).toBe(receipt);
    const suffix: number[] = [];
    for await (const event of cache.events(5, receipt))
      suffix.push(event.serverSeq);
    expect(suffix).toEqual(
      Array.from({ length: receipt - 5 }, (_, index) => index + 6),
    );
  } finally {
    blocked.resolve();
    await cache.close();
  }
});

it("persists presentation separately from receipt and rejects a changed prefix binding", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { readdir, readFile, writeFile } = await import("node:fs/promises");
  const { root, server, session, publish } = await setup();
  await publish(4);
  const cacheRoot = join(root, "presentation-checkpoint");
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(cacheRoot, settings);
  const events = [];
  for await (const event of session.history(0, session.boundary.sequence))
    events.push(event);
  await cache.commit(events, { ...cache.cursor, serverSeq: events.length });
  expect(await cache.loadPresentation()).toBe(0);
  await cache.savePresentation(2);
  expect(cache.cursor.serverSeq).toBe(events.length);
  await expect(cache.savePresentation(events.length + 1)).rejects.toThrow(
    "exceeds durable receipt",
  );
  await cache.close();
  cache = await SubscriberCache.open(cacheRoot, {
    ...settings,
    initialize: async () => {
      throw new Error("Must reopen offline");
    },
  });
  try {
    expect(await cache.loadPresentation()).toBe(2);
    const directory = (await readdir(cacheRoot))[0]!;
    const path = join(cacheRoot, directory, "presentation.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    checkpoint.hash = "a".repeat(64);
    await writeFile(path, JSON.stringify(checkpoint));
    await expect(cache.loadPresentation()).rejects.toThrow(
      "prefix hash changed",
    );
    expect(cache.cursor.serverSeq).toBe(events.length);
    await cache.savePresentation(0);
    expect(await cache.loadPresentation()).toBe(0);
  } finally {
    await cache.close();
  }
});
it("reconstructs a saved presentation prefix and presents only the later suffix as new events", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { readdir, readFile } = await import("node:fs/promises");
  const { root, server, session, publish } = await setup();
  await publish(3);
  const cacheRoot = join(root, "resumed-view");
  const base = {
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot,
    resumeView: true,
  };
  const abort = new AbortController();
  const done = watchRecording({
    ...base,
    signal: abort.signal,
    write: async () => {},
  });
  runs.push({ abort, done });
  const baseline = session.boundary.sequence;
  await expect
    .poll(async () => {
      try {
        const directory = (await readdir(cacheRoot))[0]!;
        return JSON.parse(
          await readFile(
            join(cacheRoot, directory, "presentation.json"),
            "utf8",
          ),
        ).serverSeq;
      } catch {
        return 0;
      }
    })
    .toBe(baseline);
  abort.abort();
  await done;
  await publish(2);
  const resumedAbort = new AbortController();
  const presented: number[] = [];
  let output = "";
  const resumed = watchRecording({
    ...base,
    signal: resumedAbort.signal,
    write: async (text) => {
      output += text;
    },
    onPresented: (sequence) => {
      presented.push(sequence);
      if (sequence === session.boundary.sequence) resumedAbort.abort();
    },
  });
  runs.push({ abort: resumedAbort, done: resumed });
  await resumed;
  expect(output).toContain("Playback state");
  expect(output.match(/assistant: incomplete/g)).toHaveLength(3);
  expect(presented).toEqual([baseline + 1, baseline + 2]);
  const { writeFile } = await import("node:fs/promises");
  const directory = (await readdir(cacheRoot))[0]!;
  await writeFile(join(cacheRoot, directory, "presentation.json"), "{broken");
  const restartAbort = new AbortController();
  let firstPresented = 0;
  const restarted = watchRecording({
    ...base,
    resumeView: false,
    restartView: true,
    signal: restartAbort.signal,
    write: async () => {},
    onPresented: (sequence) => {
      firstPresented = sequence;
      restartAbort.abort();
    },
  });
  runs.push({ abort: restartAbort, done: restarted });
  await restarted;
  expect(firstPresented).toBe(1);
});
it("does not checkpoint a failed output even after receipt is durable", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session } = await setup();
  const cacheRoot = join(root, "failed-presentation");
  await expect(
    watchRecording({
      serverOrigin: server.url,
      streamId: session.info.id,
      cacheRoot,
      signal: AbortSignal.timeout(5000),
      resumeView: true,
      write: async () => {
        throw new Error("Sink failed");
      },
    }),
  ).rejects.toThrow("Sink failed");
  const cache = await SubscriberCache.open(cacheRoot, {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => {
      throw new Error("Must exist");
    },
  });
  try {
    expect(cache.cursor.serverSeq).toBe(session.boundary.sequence);
    expect(await cache.loadPresentation()).toBe(0);
  } finally {
    await cache.close();
  }
});

it("receives a complete backlog during timed watch and switches to live catch-up without skipping events", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { root, server, session, publish } = await setup();
  await publish(20);
  const playback = new PlaybackPacer();
  const abort = new AbortController();
  let receipt = 0;
  const presented: number[] = [];
  const done = watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot: join(root, "timed"),
    signal: abort.signal,
    speed: 0.000001,
    presentation: playback,
    write: async () => {},
    onReceipt: (seq) => {
      receipt = seq;
    },
    onPresented: (seq) => {
      presented.push(seq);
    },
  });
  runs.push({ abort, done });
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  await expect.poll(() => presented.length).toBeGreaterThan(0);
  expect(presented.length).toBeLessThan(receipt);
  await publish(5);
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  expect(presented.length).toBeLessThan(receipt);
  playback.setImmediate(true);
  await expect.poll(() => presented.length).toBe(receipt);
  expect(presented).toEqual(Array.from({ length: receipt }, (_, i) => i + 1));
  abort.abort();
  await done;
});

it.each([false, true])(
  "cancels initial watch metadata and releases cache ownership (headers sent=%s)",
  async (sendHeaders) => {
    const { createServer } = await import("node:http");
    const { watchRecording } = await import("../../packages/cli/src/watch.js");
    const { SubscriberCache } =
      await import("../../packages/storage/src/index.js");
    const root = await mkdtemp(join(tmpdir(), "agentlive-stalled-join-"));
    roots.push(root);
    const entered = deferred();
    const http = createServer((_req, res) => {
      if (sendHeaders) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"revision":');
      }
      entered.resolve();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address() as import("node:net").AddressInfo;
    const serverOrigin = `http://127.0.0.1:${address.port}`;
    const abort = new AbortController();
    const cacheRoot = join(root, "cache");
    const done = watchRecording({
      serverOrigin,
      streamId: "stalled-join",
      cacheRoot,
      signal: abort.signal,
      write: async () => {},
    });
    runs.push({ abort, done });
    try {
      await entered.promise;
      abort.abort();
      await done;
      const cache = await SubscriberCache.open(cacheRoot, {
        serverOrigin,
        streamId: "stalled-join",
        initialize: async () => ({ revision: "new-revision" }),
      });
      expect(cache.cursor.serverSeq).toBe(0);
      await cache.close();
    } finally {
      abort.abort();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);

it("persists playback choices independently of receipt and rejects foreign settings", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { readdir, readFile, writeFile } = await import("node:fs/promises");
  const { root, server, session } = await setup();
  const cacheRoot = join(root, "preferences");
  const options = {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(cacheRoot, options);
  expect(await cache.loadPlayback()).toBeUndefined();
  const choices = { speed: 4, paused: true, immediate: false };
  const saved = cache.savePlayback(choices);
  choices.speed = 8;
  await saved;
  await cache.savePresentation(0);
  await cache.close();
  cache = await SubscriberCache.open(cacheRoot, options);
  try {
    expect(await cache.loadPlayback()).toEqual({
      speed: 4,
      paused: true,
      immediate: false,
    });
    expect(await cache.loadPresentation()).toBe(0);
    expect(cache.cursor.serverSeq).toBe(0);
    expect(() =>
      cache.savePlayback({ speed: NaN, paused: false, immediate: true }),
    ).toThrow("Invalid playback");
    const path = join(
      cacheRoot,
      (await readdir(cacheRoot))[0]!,
      "playback.json",
    );
    const foreign = JSON.parse(await readFile(path, "utf8"));
    foreign.revision = "wrong-revision";
    await writeFile(path, JSON.stringify(foreign));
    await expect(cache.loadPlayback()).rejects.toThrow("identity");
    expect(await cache.loadPresentation()).toBe(0);
    expect(cache.cursor.serverSeq).toBe(0);
  } finally {
    await cache.close();
  }
});

it("remembers control changes while paused and restores timed mode without blocking noninteractive watch", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session, publish } = await setup();
  await publish(3);
  const cacheRoot = join(root, "remember-controls");
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot,
    resumeView: true,
    write: async () => {},
  };
  const playback = new PlaybackPacer();
  const abort = new AbortController();
  let receipt = 0;
  const done = watchRecording({
    ...settings,
    presentation: playback,
    signal: abort.signal,
    onReceipt: (seq) => {
      receipt = seq;
    },
  });
  runs.push({ abort, done });
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  playback.setSpeed(1024);
  playback.setImmediate(false);
  playback.setPaused(true);
  abort.abort();
  await done;
  const cacheOptions = {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(cacheRoot, cacheOptions);
  expect(await cache.loadPlayback()).toEqual({
    speed: 1024,
    paused: true,
    immediate: false,
  });
  await cache.close();
  await publish(2);
  const resumedAbort = new AbortController();
  const resumed = watchRecording({
    ...settings,
    signal: resumedAbort.signal,
    onPresented: (seq) => {
      if (seq === session.boundary.sequence) resumedAbort.abort();
    },
  });
  runs.push({ abort: resumedAbort, done: resumed });
  await resumed;
  cache = await SubscriberCache.open(cacheRoot, cacheOptions);
  try {
    expect(await cache.loadPlayback()).toEqual({
      speed: 1024,
      paused: false,
      immediate: false,
    });
  } finally {
    await cache.close();
  }
});

it("seeks cached timelines across equal-time index boundaries and rebuilds on reopen", async () => {
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { root, server, session, publish } = await setup();
  for (let batch = 0; batch < 4; batch++) await publish(100);
  const events = [];
  for await (const event of session.history(0, session.boundary.sequence))
    events.push({
      ...event,
      timelineMs: Math.floor((event.serverSeq - 1) / 200) * 1000,
    });
  const cacheRoot = join(root, "timeline-index");
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  };
  let cache = await SubscriberCache.open(cacheRoot, settings);
  try {
    expect(await cache.sequenceAt(0)).toBe(0);
    await cache.commit(events, { ...cache.cursor, serverSeq: events.length });
    for (let restart = 0; restart < 2; restart++) {
      expect(await cache.sequenceAt(0)).toBe(200);
      expect(await cache.sequenceAt(999)).toBe(200);
      expect(await cache.sequenceAt(1000)).toBe(400);
      expect(await cache.sequenceAt(1000, 257)).toBe(257);
      expect(await cache.sequenceAt(0, 128)).toBe(128);
      expect(await cache.sequenceAt(9999)).toBe(events.length);
      expect(await cache.sequenceAt(9999, 0)).toBe(0);
      await expect(cache.sequenceAt(-1)).rejects.toThrow("timeline");
      await expect(cache.sequenceAt(NaN)).rejects.toThrow("timeline");
      await expect(cache.sequenceAt(1000, events.length + 1)).rejects.toThrow(
        "receipt",
      );
      await cache.close();
      cache = await SubscriberCache.open(cacheRoot, settings);
    }
    const position = events.length;
    const bad = { ...events.at(-1)!, serverSeq: position + 1, timelineMs: 0 };
    await expect(
      cache.commit([bad], { ...cache.cursor, serverSeq: position + 1 }),
    ).rejects.toThrow("backwards");
    expect(cache.cursor.serverSeq).toBe(position);
    expect(await cache.sequenceAt(2000)).toBe(position);
    const pending = cache.commit([{ ...bad, timelineMs: 3000 }], {
      ...cache.cursor,
      serverSeq: position + 1,
    });
    const frozen = cache.sequenceAt(9999);
    await pending;
    expect(await frozen).toBe(position);
    expect(await cache.sequenceAt(9999)).toBe(position + 1);
  } finally {
    await cache.close();
  }
});

it.each([0, 2, 9999])(
  "positions live watch at a frozen history time while receipt continues (from=%s)",
  async (fromMs) => {
    const { watchRecording } = await import("../../packages/cli/src/watch.js");
    const { PlaybackPacer, initialState, apply, renderTerminalSnapshot } =
      await import("../../packages/playback/src/index.js");
    const { root, server, session, publish } = await setup();
    await publish(6);
    const history = [];
    for await (const event of session.history(0, session.boundary.sequence))
      history.push(event);
    const position = Math.min(fromMs, history.at(-1)!.timelineMs);
    let expected = initialState();
    for (const event of history)
      if (event.timelineMs <= position) expected = apply(expected, event);
    const snapshot = [
      ...renderTerminalSnapshot(
        expected,
        server.url,
        session.info.id,
        position,
      ),
    ].join("");
    const playback = new PlaybackPacer();
    playback.setPaused(true);
    const abort = new AbortController();
    let output = "";
    let receipt = 0;
    const presented: number[] = [];
    const done = watchRecording({
      serverOrigin: server.url,
      streamId: session.info.id,
      cacheRoot: join(root, "seek-view"),
      signal: abort.signal,
      fromMs,
      resumeView: true,
      presentation: playback,
      write: async (text) => {
        output += text;
      },
      onReceipt: (seq) => {
        receipt = seq;
      },
      onPresented: (seq) => {
        presented.push(seq);
      },
    });
    runs.push({ abort, done });
    await expect.poll(() => output).toBe(snapshot);
    expect(presented).toEqual([]);
    await publish(2);
    await expect.poll(() => receipt).toBe(session.boundary.sequence);
    expect(output).toBe(snapshot);
    playback.setPaused(false);
    await expect.poll(() => presented.at(-1)).toBe(receipt);
    expect(presented).toEqual(
      Array.from(
        { length: receipt - expected.appliedSeq },
        (_, index) => expected.appliedSeq + index + 1,
      ),
    );
    abort.abort();
    await done;
  },
);

it("seeks backward and forward while paused, coalesces requests, and keeps receipt connected", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { root, server, session, publish } = await setup();
  await publish(6);
  const retained = [];
  for await (const event of session.history(0, session.boundary.sequence))
    retained.push(event);
  const initialTime = retained[4]!.timelineMs;
  const playback = new PlaybackPacer();
  playback.setPaused(true);
  const abort = new AbortController();
  let receipt = 0;
  const positions: { serverSeq: number; timelineMs: number }[] = [];
  const shown: number[] = [];
  let connections = 0;
  const done = watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot: join(root, "reseek"),
    signal: abort.signal,
    fromMs: initialTime,
    presentation: playback,
    write: async () => {},
    onReceipt: (seq) => {
      receipt = seq;
    },
    onPositioned: (position) => {
      positions.push(position);
    },
    onPresented: (seq) => {
      shown.push(seq);
    },
    onStatus: (status) => {
      if (status === "connecting") connections++;
    },
  });
  runs.push({ abort, done });
  await expect.poll(() => positions.length).toBe(1);
  const initial = positions[0]!;
  playback.seek(0);
  await expect.poll(() => positions.length).toBe(2);
  expect(positions[1]!.serverSeq).toBeLessThan(initial.serverSeq);
  playback.seek(9999);
  await expect.poll(() => positions.length).toBe(3);
  expect(positions[2]!.serverSeq).toBe(receipt);
  await publish(2);
  await expect.poll(() => receipt).toBe(session.boundary.sequence);
  expect(shown).toEqual([]);
  playback.seek(0);
  playback.seek(initialTime);
  await expect.poll(() => positions.length).toBe(4);
  expect(positions[3]).toEqual(initial);
  expect(connections).toBe(1);
  playback.setPaused(false);
  await expect.poll(() => shown.at(-1)).toBe(receipt);
  expect(shown).toEqual(
    Array.from(
      { length: receipt - initial.serverSeq },
      (_, i) => initial.serverSeq + i + 1,
    ),
  );
  abort.abort();
  await done;
  const count = positions.length;
  playback.seek(0);
  expect(positions.length).toBe(count);
});

it("finishes an accepted output write before rendering a requested seek snapshot", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { root, server, session, publish } = await setup();
  await publish(4);
  const playback = new PlaybackPacer();
  const abort = new AbortController();
  const entered = deferred();
  const release = deferred();
  let receipt = 0,
    writes = 0,
    positioned = 0;
  let writing = false;
  const done = watchRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot: join(root, "seek-output"),
    signal: abort.signal,
    presentation: playback,
    write: async () => {
      expect(writing).toBe(false);
      writing = true;
      if (++writes === 1) {
        entered.resolve();
        await release.promise;
      }
      writing = false;
    },
    onReceipt: (seq) => {
      receipt = seq;
    },
    onPositioned: () => {
      positioned++;
    },
  });
  runs.push({ abort, done });
  try {
    await entered.promise;
    playback.setPaused(true);
    playback.seek(0);
    await publish(2);
    await expect.poll(() => receipt).toBe(session.boundary.sequence);
    expect(positioned).toBe(0);
    expect(writes).toBe(1);
    release.resolve();
    await expect.poll(() => positioned).toBe(1);
  } finally {
    release.resolve();
    abort.abort();
    await done;
  }
});

it("retains a seek between events across viewer restart and reads legacy positions", async () => {
  const { watchRecording } = await import("../../packages/cli/src/watch.js");
  const { PlaybackPacer } =
    await import("../../packages/playback/src/index.js");
  const { SubscriberCache } =
    await import("../../packages/storage/src/index.js");
  const { readdir, readFile, writeFile } = await import("node:fs/promises");
  const { root, server, session, publish } = await setup();
  await publish(6, 10000);
  const events = [];
  for await (const event of session.history(0, session.boundary.sequence))
    events.push(event);
  const target = (events[3]!.timelineMs + events[4]!.timelineMs) / 2;
  const cacheRoot = join(root, "idle-position");
  const settings = {
    serverOrigin: server.url,
    streamId: session.info.id,
    cacheRoot,
    resumeView: true,
    write: async () => {},
  };
  const positions: { serverSeq: number; timelineMs: number }[] = [];
  for (const fromMs of [target, undefined]) {
    const abort = new AbortController();
    const playback = new PlaybackPacer();
    playback.setPaused(true);
    const done = watchRecording({
      ...settings,
      ...(fromMs === undefined ? {} : { fromMs }),
      presentation: playback,
      signal: abort.signal,
      onPositioned: (position) => {
        positions.push(position);
        abort.abort();
      },
    });
    runs.push({ abort, done });
    await done;
  }
  expect(positions).toEqual([
    { serverSeq: 4, timelineMs: target },
    { serverSeq: 4, timelineMs: target },
  ]);
  const cache = await SubscriberCache.open(cacheRoot, {
    serverOrigin: server.url,
    streamId: session.info.id,
    initialize: async () => ({ revision: session.info.revision }),
  });
  try {
    expect(await cache.loadPresentation()).toBe(4);
    await expect(
      cache.savePresentation(4, events[4]!.timelineMs + 1),
    ).rejects.toThrow("interval");
    await expect(
      cache.savePresentation(4, events[3]!.timelineMs - 1),
    ).rejects.toThrow("interval");
    await expect(cache.savePresentation(4, NaN)).rejects.toThrow("interval");
    const path = join(
      cacheRoot,
      (await readdir(cacheRoot))[0]!,
      "presentation.json",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.version).toBe(2);
    saved.timelineMs = null;
    await writeFile(path, JSON.stringify(saved));
    await expect(cache.loadPresentationPosition()).rejects.toThrow("interval");
    saved.version = 1;
    delete saved.timelineMs;
    await writeFile(path, JSON.stringify(saved));
    expect(await cache.loadPresentationPosition()).toEqual({
      serverSeq: 4,
      timelineMs: events[3]!.timelineMs,
    });
  } finally {
    await cache.close();
  }
});

it.each([false, true])(
  "bounds watch cancellation and observes late cleanup failure=%s while retaining cache ownership",
  async (failCleanup) => {
    const { watchRecording, CancellationTimeoutError } =
      await import("../../packages/cli/src/watch.js");
    const { SubscriberCache } =
      await import("../../packages/storage/dist/index.js");
    const { root, session, options, publish } = await setup();
    await publish(2);
    const cacheRoot = join(root, "deadline-cache");
    const entered = deferred();
    const release = deferred();
    const originalClose = SubscriberCache.prototype.close;
    const lateFailure = new Error("Injected late cache cleanup failure");
    const closeSpy = vi
      .spyOn(SubscriberCache.prototype, "close")
      .mockImplementationOnce(async function () {
        await originalClose.call(this);
        if (failCleanup) throw lateFailure;
      });
    const original = SubscriberCache.prototype.commit;
    const spy = vi
      .spyOn(SubscriberCache.prototype, "commit")
      .mockImplementation(async function (events, cursor) {
        entered.resolve();
        await release.promise;
        return original.call(this, events, cursor);
      });
    const abort = new AbortController();
    const done = watchRecording({
      ...options,
      streamId: session.info.id,
      cacheRoot,
      signal: abort.signal,
      cancellationTimeoutMs: 25,
      write: async () => {},
    });
    const result = done.catch((error: unknown) => error);
    const cacheOptions = {
      serverOrigin: options.serverOrigin,
      streamId: session.info.id,
      initialize: async () => ({ revision: session.info.revision }),
    };
    try {
      await entered.promise;
      abort.abort();
      const error = await result;
      expect(error).toBeInstanceOf(CancellationTimeoutError);
      expect(error).toMatchObject({
        code: "cancellation_timeout",
        timeoutMs: 25,
      });
      await expect(
        SubscriberCache.open(cacheRoot, cacheOptions),
      ).rejects.toThrow();
      release.resolve();
      const drained = (error as InstanceType<typeof CancellationTimeoutError>)
        .whenDrained;
      if (failCleanup) await expect(drained).rejects.toBe(lateFailure);
      else await drained;
      const reopened = await SubscriberCache.open(cacheRoot, cacheOptions);
      try {
        expect(reopened.cursor.serverSeq).toBe(session.boundary.sequence);
      } finally {
        await reopened.close();
      }
    } finally {
      release.resolve();
      abort.abort();
      const error = await result;
      if (error instanceof CancellationTimeoutError)
        await error.whenDrained.catch(() => {});
      spy.mockRestore();
      closeSpy.mockRestore();
    }
  },
);

it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])(
  "rejects invalid watch cancellation deadline %s before opening a cache",
  async (cancellationTimeoutMs) => {
    const { watchRecording } = await import("../../packages/cli/src/watch.js");
    await expect(
      watchRecording({
        serverOrigin: "http://localhost",
        streamId: "unused",
        cacheRoot: "unused",
        signal: new AbortController().signal,
        cancellationTimeoutMs,
      }),
    ).rejects.toThrow("cancellationTimeoutMs");
  },
);
