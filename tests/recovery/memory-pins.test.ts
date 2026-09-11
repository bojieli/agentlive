import { expect, it } from "vitest";
import {
  ActivityIndex,
  initialActivityIndex,
  initialPagedState,
  PagedReducer,
} from "../../packages/playback/src/index.js";
import { MemoryPagedStore } from "../../apps/web/src/memory-paged-store.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
it("keeps a pinned unpublished historical root then reclaims it after release", async () => {
  const store = new MemoryPagedStore(binding);
  const reducer = new PagedReducer(store),
    index = new ActivityIndex(store);
  let root = initialPagedState(),
    rows = initialActivityIndex();
  const apply = async (serverSeq: number, content: StoredEvent["content"]) => {
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq,
      timelineMs: serverSeq,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `event-${serverSeq}` },
      content,
    };
    root = await reducer.apply(root, event);
    rows = await index.apply(rows, event, root, reducer);
    return {
      format: "agentlive.paged-state" as const,
      serverSeq,
      timelineMs: serverSeq,
      ref: await reducer.checkpoint(root, binding),
      activity: await index.checkpoint(rows, binding),
    };
  };
  try {
    const releaseWork = store.beginWork();
    const first = await apply(1, {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    });
    await store.publishCheckpoint(null, first, signal());
    const historical = await apply(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "old text" },
    });
    const pin = await store.pinCheckpoint(historical, signal());
    const current = await apply(3, {
      kind: "message.text.append",
      payload: { messageId: "m", text: " plus new" },
    });
    await store.publishCheckpoint(first, current, signal());
    await expect(store.collectRetained(signal())).rejects.toMatchObject({
      code: "retry_later",
    });
    releaseWork();
    releaseWork();
    const garbage = await store.put("orphan");
    const collected = await store.collectRetained(signal());
    expect(collected.removedEntries).toBeGreaterThan(0);
    await expect(store.read(garbage, 0, 1)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    const past = await reducer.open(historical.ref, binding, signal());
    const old = await reducer.get(past, "messages", "m", signal());
    expect(await store.read(old!.text, 0, old!.text.units)).toBe("old text");
    expect(await store.loadCheckpointBefore(10, 2, signal())).toEqual(first);
    await store.releasePin(pin, signal());
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    await expect(
      reducer.open(historical.ref, binding, signal()),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const present = await reducer.open(current.ref, binding, signal());
    const latest = await reducer.get(present, "messages", "m", signal());
    expect(await store.read(latest!.text, 0, latest!.text.units)).toBe(
      "old text plus new",
    );
    expect((await reducer.open(first.ref, binding, signal())).appliedSeq).toBe(
      1,
    );
    const pins: symbol[] = [];
    for (let i = 0; i < 128; i++)
      pins.push(await store.pinCheckpoint(current, signal()));
    await expect(store.pinCheckpoint(current, signal())).rejects.toMatchObject({
      code: "retry_later",
    });
    await store.releasePin(pins[0]!, signal());
    await store.pinCheckpoint(current, signal());
  } finally {
    await store.close();
  }
});
it("bounds root work and prevents admission after close", async () => {
  const store = new MemoryPagedStore(binding);
  const work = Array.from({ length: 16 }, () => store.beginWork());
  expect(() => store.beginWork()).toThrow("unavailable");
  await expect(store.collectRetained(signal())).rejects.toMatchObject({
    code: "retry_later",
  });
  for (const release of work) release();
  expect((await store.collectRetained(signal())).entries).toBe(0);
  await store.close();
  expect(() => store.beginWork()).toThrow("closing");
});

it("paged-state receipt holds construction guards through publication and releases them on failure", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const original = store.publishCheckpoint.bind(store);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.publishCheckpoint = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const event: StoredEvent = {
    protocolVersion: 1,
    serverSeq: 1,
    timelineMs: 1,
    receivedAt: "2026-09-10T00:00:00Z",
    origin: { type: "server", operationId: "start" },
    content: {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    },
  };
  try {
    const applying = session.apply([event], signal());
    await started;
    await expect(store.collectRetained(signal())).rejects.toMatchObject({
      code: "retry_later",
    });
    release();
    await applying;
    expect((await store.collectRetained(signal())).entries).toBeGreaterThan(0);
    store.publishCheckpoint = async () => {
      throw new Error("publication failed");
    };
    await expect(
      session.apply(
        [
          {
            ...event,
            serverSeq: 2,
            timelineMs: 2,
            content: {
              kind: "message.text.append",
              payload: { messageId: "m", text: "unpublished" },
            },
          },
        ],
        signal(),
      ),
    ).rejects.toThrow("publication failed");
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    expect(session.state.appliedSeq).toBe(1);
  } finally {
    release();
    await session.close();
  }
});

it("paged-state historical reconstruction blocks collection and releases its guard on cancellation", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const event = (
    serverSeq: number,
    content: StoredEvent["content"],
  ): StoredEvent => ({
    protocolVersion: 1,
    serverSeq,
    timelineMs: serverSeq,
    receivedAt: "2026-09-10T00:00:00Z",
    origin: { type: "server", operationId: `op-${serverSeq}` },
    content,
  });
  const events = [
    event(1, {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    }),
    event(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "old" },
    }),
    event(3, {
      kind: "message.text.append",
      payload: { messageId: "m", text: " new" },
    }),
  ];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = new AbortController();
  try {
    await session.apply(events, signal());
    const selecting = session.select(
      2,
      async function* () {
        entered();
        await gate;
        yield* events.slice(0, 2);
      },
      stop.signal,
      2,
    );
    const cancelled = expect(selecting).rejects.toThrow("cancel selection");
    await started;
    await expect(store.collectRetained(signal())).rejects.toMatchObject({
      code: "retry_later",
    });
    stop.abort(new Error("cancel selection"));
    await cancelled;
    await store.collectRetained(signal());
    expect(session.state.appliedSeq).toBe(3);
  } finally {
    release();
    await session.close();
  }
});

it("pins completed selections through collection and rejects derived text reads after release", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const event = (
    serverSeq: number,
    content: StoredEvent["content"],
  ): StoredEvent => ({
    protocolVersion: 1,
    serverSeq,
    timelineMs: serverSeq,
    receivedAt: "2026-09-10T00:00:00Z",
    origin: { type: "server", operationId: `op-${serverSeq}` },
    content,
  });
  const events = [
    event(1, {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    }),
    event(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "old" },
    }),
    event(3, {
      kind: "message.text.append",
      payload: { messageId: "m", text: " new" },
    }),
  ];
  try {
    await session.apply(events, signal());
    const history = async function* (after: number, through: number) {
      yield* events.filter(
        (item) => item.serverSeq > after && item.serverSeq <= through,
      );
    };
    const selected = await session.select(2, history, signal(), 2);
    const row = (await selected.rows(0, 1, signal()))[0]!;
    const text = (await selected.load(row, signal()))!.texts.text!;
    await store.collectRetained(signal());
    expect(await text.read(0, text.units, signal())).toBe("old");
    const read = store.read.bind(store);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    store.read = async (...args) => {
      if (!delayed) {
        delayed = true;
        entered();
        await gate;
      }
      return read(...args);
    };
    const pendingRead = text.read(0, text.units, signal());
    await started;
    let closed = false;
    const closing = selected.close().then(() => {
      closed = true;
    });
    await store.collectRetained(signal());
    expect(closed).toBe(false);
    release();
    expect(await pendingRead).toBe("old");
    await closing;
    await selected.close();
    await expect(text.read(0, 1, signal())).rejects.toThrow("closed");
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    const rebuilt = await session.select(2, history, signal(), 2);
    const restored = (await rebuilt.load(row, signal()))!.texts.text!;
    expect(await restored.read(0, restored.units, signal())).toBe("old");
    await session.close();
    await expect(rebuilt.rows(0, 1, signal())).rejects.toThrow("closed");
    expect(store.usage).toEqual({ bytes: 0, entries: 0 });
  } finally {
    await session.close();
  }
});

it("automatically collects between receipt batches while preserving a paused presentation", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding, { collectionBytes: 1 });
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const event = (
    serverSeq: number,
    content: StoredEvent["content"],
  ): StoredEvent => ({
    protocolVersion: 1,
    serverSeq,
    timelineMs: serverSeq,
    receivedAt: "2026-09-10T00:00:00Z",
    origin: { type: "server", operationId: `op-${serverSeq}` },
    content,
  });
  try {
    await session.apply(
      [
        event(1, {
          kind: "message.started",
          payload: { messageId: "m", role: "assistant" },
        }),
        event(2, {
          kind: "message.text.append",
          payload: { messageId: "m", text: "before" },
        }),
      ],
      signal(),
    );
    const paused = await session.retainedView(signal());
    const row = (await paused.rows(0, 1, signal()))[0]!;
    const old = (await paused.load(row, signal()))!.texts.text!;
    const orphan = await store.put("orphan for automatic collection");
    for (let seq = 3; seq <= 12; seq++)
      await session.apply(
        [
          event(seq, {
            kind: "message.text.append",
            payload: { messageId: "m", text: "." },
          }),
        ],
        signal(),
      );
    await expect(store.read(orphan, 0, 1)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    expect(await old.read(0, old.units, signal())).toBe("before");
    const current = await session.retainedView(signal());
    const text = (await current.load(row, signal()))!.texts.text!;
    expect(await text.read(0, text.units, signal())).toBe(
      "before" + ".".repeat(10),
    );
    expect(session.state.appliedSeq).toBe(12);
    await paused.close();
    await current.close();
    await store.maintain();
  } finally {
    await session.close();
  }
});

it("thins seek landmarks under pressure only after a successful sweep and keeps pinned views", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding, { maxEntries: 1024 });
  const session = await BrowserPagedState.openContent(store, binding, signal());
  let pinned: Awaited<ReturnType<typeof session.retainedView>> | undefined;
  const events: StoredEvent[] = [];
  try {
    for (let seq = 1; seq <= 9; seq++) {
      const event: StoredEvent = {
        protocolVersion: 1,
        serverSeq: seq,
        timelineMs: seq * 10000,
        receivedAt: "2026-09-10T00:00:00Z",
        origin: { type: "server", operationId: `pressure-${seq}` },
        content:
          seq === 1
            ? {
                kind: "message.started",
                payload: { messageId: "m", role: "assistant" },
              }
            : {
                kind: "message.text.append",
                payload: { messageId: "m", text: "." },
              },
      };
      events.push(event);
      await session.apply([event], signal());
      if (seq === 2) pinned = await session.retainedView(signal());
    }
    expect(
      (await store.loadCheckpointBefore(20000, 2, signal()))?.serverSeq,
    ).toBe(2);
    let garbage = 0;
    while (store.usage.entries < 670)
      await store.put(`pressure garbage ${garbage++}`);
    const usage = store.usage;
    const trace = store.trace.bind(store);
    store.trace = async () => {
      throw new Error("failed pressure scan");
    };
    await expect(store.collectRetained(signal())).rejects.toThrow(
      "failed pressure scan",
    );
    expect(store.usage).toEqual(usage);
    expect(
      (await store.loadCheckpointBefore(20000, 2, signal()))?.serverSeq,
    ).toBe(2);
    store.trace = trace;
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    expect(
      (await store.loadCheckpointBefore(20000, 2, signal()))?.serverSeq,
    ).toBe(1);
    expect((await store.loadCheckpoint())?.serverSeq).toBe(9);
    const row = (await pinned!.rows(0, 1, signal()))[0]!;
    const text = (await pinned!.load(row, signal()))!.texts.text!;
    expect(await text.read(0, text.units, signal())).toBe(".");
    await pinned!.close();
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    const reconstructed = await session.select(
      20000,
      async function* (after, through) {
        for (const event of events)
          if (event.serverSeq > after && event.serverSeq <= through)
            yield event;
      },
      signal(),
      2,
      true,
    );
    expect(reconstructed.sequence).toBe(2);
    const restoredText = (await reconstructed.load(row, signal()))!.texts.text!;
    expect(await restoredText.read(0, restoredText.units, signal())).toBe(".");
    expect(session.state.appliedSeq).toBe(9);
    await reconstructed.close();
  } finally {
    await session.close();
  }
});

it("releases a temporary seek pin when cancellation arrives during batch maintenance", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const events: StoredEvent[] = Array.from({ length: 300 }, (_, index) => ({
    protocolVersion: 1,
    serverSeq: index + 1,
    timelineMs: index + 1,
    receivedAt: "2026-09-10T00:00:00Z",
    origin: { type: "server", operationId: `cancel-${index}` },
    content:
      index === 0
        ? {
            kind: "message.started",
            payload: { messageId: "m", role: "assistant" },
          }
        : {
            kind: "message.text.append",
            payload: { messageId: "m", text: "." },
          },
  }));
  try {
    await session.apply(events.slice(0, 256), signal());
    await session.apply(events.slice(256), signal());
    const tokens = new Set<symbol>();
    const pin = store.pinCheckpoint.bind(store),
      release = store.releasePin.bind(store);
    store.pinCheckpoint = async (...args) => {
      const token = await pin(...args);
      tokens.add(token);
      return token;
    };
    store.releasePin = async (...args) => {
      await release(...args);
      tokens.delete(args[0]);
    };
    const stop = new AbortController();
    const maintain = store.maintain.bind(store);
    let interrupted = false;
    store.maintain = async () => {
      if (interrupted) return maintain();
      interrupted = true;
      expect(tokens.size).toBe(1);
      await store.collectRetained(signal());
      stop.abort(new Error("cancel at seek maintenance"));
    };
    await expect(
      session.select(
        200,
        async function* (after, through) {
          for (const event of events)
            if (event.serverSeq > after && event.serverSeq <= through)
              yield event;
        },
        stop.signal,
        200,
      ),
    ).rejects.toThrow("cancel at seek maintenance");
    expect(interrupted).toBe(true);
    expect(tokens.size).toBe(0);
    expect(session.state.appliedSeq).toBe(300);
    await store.collectRetained(signal());
    const view = await session.retainedView(signal());
    const row = (await view.rows(0, 1, signal()))[0]!;
    const text = (await view.load(row, signal()))!.texts.text!;
    expect(await text.read(0, text.units, signal())).toBe(".".repeat(299));
    await view.close();
  } finally {
    await session.close();
  }
});

it("reuses validated root closures but verifies dependencies before every sweep", async () => {
  const { BrowserPagedState } =
    await import("../../apps/web/src/paged-state.js");
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const read = store.read.bind(store);
  let reads = 0;
  store.read = (...args) => {
    reads++;
    return read(...args);
  };
  try {
    await session.apply(
      [
        {
          protocolVersion: 1,
          serverSeq: 1,
          timelineMs: 1,
          receivedAt: "2026-09-10T00:00:00Z",
          origin: { type: "server", operationId: "root" },
          content: {
            kind: "message.started",
            payload: { messageId: "m", role: "assistant" },
          },
        },
      ],
      signal(),
    );
    reads = 0;
    const interrupted = new Error("interrupted typed validation");
    store.read = (...args) => {
      reads++;
      if (reads === 5) return Promise.reject(interrupted);
      return read(...args);
    };
    const beforeFailure = store.usage;
    await expect(store.collectRetained(signal())).rejects.toBe(interrupted);
    expect(store.usage).toEqual(beforeFailure);
    store.read = (...args) => {
      reads++;
      return read(...args);
    };
    reads = 0;
    await store.collectRetained(signal());
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    // Reach the pool-compaction boundary without constructing 60k full roots.
    // These unreachable slots model references left behind by retired roots.
    const cache = store as unknown as {
      traceReferences: Array<{ hash: string; byteSize: number; units: number }>;
    };
    const liveReferences = cache.traceReferences.length;
    while (cache.traceReferences.length < 60000)
      cache.traceReferences.push({ ...cache.traceReferences[0]! });
    await store.put("unreachable");
    expect(
      (await store.collectRetained(signal())).removedEntries,
    ).toBeGreaterThan(0);
    expect(reads).toBe(0); // typed metadata already validated; codec trace still runs.
    expect(cache.traceReferences.length).toBe(liveReferences);
    // Deliberately violate the caller-owned root set to simulate a missing blob.
    // A memoized closure must fail closed, never authorize sweeping on its own.
    await store.collect(async () => {}, signal());
    const survivor = await store.put("must survive failed verification");
    const usage = store.usage;
    await expect(store.collectRetained(signal())).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    expect(store.usage).toEqual(usage);
    expect(await store.read(survivor, 0, survivor.units)).toBe(
      "must survive failed verification",
    );
  } finally {
    await session.close();
  }
});
