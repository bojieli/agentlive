import { afterEach, expect, it } from "vitest";
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
  const publish = async (count: number) => {
    const events: PublishedEvent[] = Array.from({ length: count }, () => ({
      protocolVersion: 1,
      streamId: session.info.id,
      producerEpoch: "epoch1",
      producerSeq: ++producerSeq,
      observedAt: new Date().toISOString(),
      clockSegmentId: "clock1",
      elapsedMs: producerSeq,
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
