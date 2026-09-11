import { expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubscriberCache } from "../../packages/storage/src/index.js";
import { TerminalWatchState } from "../../packages/cli/src/watch-state.js";
import type {
  StoredEvent,
  EventContent,
} from "../../packages/protocol/src/index.js";
const signal = () => AbortSignal.timeout(15000);
it("reopens terminal presentation checkpoints and seeks using only their missing cached suffix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-terminal-state-"));
  const cache = await SubscriberCache.open(directory, {
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    initialize: async () => ({ revision: "revision" }),
  });
  let state = await TerminalWatchState.open(cache, signal());
  try {
    const contents: EventContent[] = [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: "before" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: " after" },
      },
      { kind: "message.completed", payload: { messageId: "m" } },
    ];
    const events = contents.map((content, index): StoredEvent => ({
      protocolVersion: 1,
      content,
      serverSeq: index + 1,
      timelineMs: index,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `op-${index}` },
    }));
    await cache.commit(events, { ...cache.cursor, serverSeq: 4 });
    await state.save(await state.select(2, signal()), signal());
    await state.close();
    state = await TerminalWatchState.open(cache, signal());
    const reads = vi.spyOn(cache, "events");
    const selected = await state.select(3, signal());
    expect(reads.mock.calls).toEqual([[2, 3]]);
    expect(cache.cursor.serverSeq).toBe(4);
    expect(
      (await state.reducer.materialize(selected)).messages.get("m")!.text,
    ).toBe("before after");
    const { ProtocolError } =
      await import("../../packages/protocol/dist/index.js");
    const applying = vi
      .spyOn(state.reducer, "apply")
      .mockRejectedValueOnce(
        new ProtocolError("stale_lease", "expired during append"),
      );
    reads.mockClear();
    const advanced = await state.advance(selected, events[3]!, signal());
    expect(advanced.recovered).toBe(true);
    expect(advanced.state.appliedSeq).toBe(4);
    expect(reads.mock.calls).toEqual([[0, 4]]);
    expect(
      (await state.reducer.materialize(advanced.state)).messages.get("m")!.text,
    ).toBe("before after");
    applying.mockRestore();
    let replacement = selected;
    const partial = async function* () {
      yield "partial";
      throw new ProtocolError("stale_lease", "expired during rendering");
    };
    const render = async function* (root: typeof selected) {
      yield (await state.reducer.materialize(root)).messages.get("m")!.text;
    };
    const output: string[] = [];
    for await (const text of state.render(
      partial(),
      advanced.state,
      render,
      (root) => {
        replacement = root;
      },
      signal(),
    ))
      output.push(text);
    expect(output).toEqual(["partial", "\n", "before after"]);
    expect(replacement.appliedSeq).toBe(4);
    let attempts = 0;
    await expect(
      (async () => {
        for await (const _text of state.render(
          partial(),
          advanced.state,
          async function* () {
            attempts++;
            throw new ProtocolError("stale_lease", "replacement failed");
          },
          () => {},
          signal(),
        )) {
        }
      })(),
    ).rejects.toThrow("replacement failed");
    expect(attempts).toBe(1);

    await expect(
      state.advance(advanced.state, events[3]!, signal()),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    // Rebuild saved landmarks after invalidation for the following reopen checks.
    await state.save(await state.select(2, signal()), signal());
    await expect(state.save(selected, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    await state.save(
      await state.select(selected.appliedSeq, signal()),
      signal(),
    );
    await state.close();
    state = await TerminalWatchState.open(cache, signal());
    reads.mockClear();
    expect((await state.select(2, signal())).appliedSeq).toBe(2);
    expect(reads.mock.calls).toEqual([[2, 2]]);
    await expect(state.select(5, signal())).rejects.toThrow("boundary");
    const catalogPath = join(cache.contentDirectory, "checkpoints.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    await state.close();
    await writeFile(catalogPath, JSON.stringify({ ...catalog, version: 1 }));
    state = await TerminalWatchState.open(cache, signal());
    reads.mockClear();
    const rebuilt = await state.select(3, signal());
    expect(reads.mock.calls).toEqual([[0, 3]]);
    expect(
      (await state.reducer.materialize(rebuilt)).messages.get("m")!.text,
    ).toBe("before after");
    expect(cache.cursor.serverSeq).toBe(4);
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toMatchObject({
      version: 2,
      checkpoints: [],
    });
    await state.save(rebuilt, signal());
    await state.close();
    state = await TerminalWatchState.open(cache, signal());
    reads.mockClear();
    await state.select(3, signal());
    expect(reads.mock.calls).toEqual([[3, 3]]);
    catalog.checkpoints[0].timelineMs += 100;
    await state.close();
    await writeFile(catalogPath, JSON.stringify(catalog));
    state = await TerminalWatchState.open(cache, signal());
    await expect(state.select(2, signal())).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    await state.close();
    catalog.checkpoints[0].serverSeq = 99;
    await writeFile(catalogPath, JSON.stringify(catalog));
    await expect(TerminalWatchState.open(cache, signal())).rejects.toThrow(
      "receipt",
    );
  } finally {
    await state.close();
    await cache.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds the durable seek catalog and preserves a newly selected older position", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentlive-terminal-catalog-"),
  );
  const cache = await SubscriberCache.open(directory, {
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    initialize: async () => ({ revision: "revision" }),
  });
  const state = await TerminalWatchState.open(cache, signal());
  try {
    const events: StoredEvent[] = Array.from({ length: 40 }, (_, index) => ({
      protocolVersion: 1,
      serverSeq: index + 1,
      timelineMs: index,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `op-${index}` },
      content: { kind: "turn.started", payload: { turnId: `turn-${index}` } },
    }));
    await cache.commit(events, { ...cache.cursor, serverSeq: 40 });
    let root = await state.select(0, signal());
    for (const event of events) {
      root = await state.reducer.apply(root, event, signal());
      await state.save(root, signal());
    }
    const path = join(cache.contentDirectory, "checkpoints.json");
    let catalog = JSON.parse(await readFile(path, "utf8"));
    expect(catalog.checkpoints).toHaveLength(32);
    const missing = events.find(
      (event) =>
        !catalog.checkpoints.some(
          (checkpoint: { serverSeq: number }) =>
            checkpoint.serverSeq === event.serverSeq,
        ),
    )!.serverSeq;
    await state.save(await state.select(missing, signal()), signal());
    catalog = JSON.parse(await readFile(path, "utf8"));
    expect(catalog.checkpoints).toHaveLength(32);
    expect(
      catalog.checkpoints.some(
        (checkpoint: { serverSeq: number }) => checkpoint.serverSeq === missing,
      ),
    ).toBe(true);
    expect(cache.cursor.serverSeq).toBe(40);
  } finally {
    await state.close();
    await cache.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("adopts an authorized remote snapshot, reduces only the suffix and reopens fetched content offline", async () => {
  const { startServer } = await import("../../packages/server/src/index.js");
  const { RecordingSnapshotClient } =
    await import("../../packages/client/src/index.js");
  const directory = await mkdtemp(join(tmpdir(), "agentlive-watch-remote-"));
  const ownerSecret = "b".repeat(64);
  const server = await startServer({
    directory: join(directory, "server"),
    ownerSecret,
    port: 0,
  });
  let cache: SubscriberCache | undefined;
  let state: TerminalWatchState | undefined;
  let snapshots: InstanceType<typeof RecordingSnapshotClient> | undefined;
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "remote-watch",
      requestedAt: new Date().toISOString(),
      publisherId: "publisher",
      producerEpoch: "epoch",
      writeSecret: ownerSecret,
      visibility: "private",
      title: "Remote watch",
    });
    const { lease } = await session.resume(ownerSecret, {
      publisherId: "publisher",
      producerEpoch: "epoch",
      attempt: 1,
      revision: session.info.revision,
    });
    let sequence = 0;
    const append = (content: EventContent) =>
      session.append(lease, [
        {
          protocolVersion: 1,
          streamId: session.info.id,
          producerEpoch: "epoch",
          producerSeq: ++sequence,
          observedAt: new Date().toISOString(),
          clockSegmentId: "clock",
          elapsedMs: 0,
          fidelity: "delta",
          source: { agent: "synthetic", sessionId: "native" },
          content,
        },
      ]);
    await append({
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    });
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: "remote prefix" },
    });
    const through = session.boundary.sequence;
    await session.buildSnapshot(through, signal());
    await append({
      kind: "message.text.append",
      payload: { messageId: "m", text: " local suffix" },
    });
    await append({ kind: "message.completed", payload: { messageId: "m" } });
    cache = await SubscriberCache.open(join(directory, "subscriber"), {
      serverOrigin: server.url,
      streamId: session.info.id,
      initialize: async () => ({ revision: session.info.revision }),
    });
    const events: StoredEvent[] = [];
    for await (const event of session.history(0, session.boundary.sequence))
      events.push(event);
    await cache.commit(events, {
      ...cache.cursor,
      serverSeq: session.boundary.sequence,
    });
    snapshots = new RecordingSnapshotClient({
      serverOrigin: server.url,
      streamId: session.info.id,
      revision: session.info.revision,
      credential: ownerSecret,
    });
    const blobs = vi.spyOn(snapshots, "readBlob");
    const selects = vi.spyOn(snapshots, "acquireLease");
    state = await TerminalWatchState.open(cache, signal(), snapshots);
    const reads = vi.spyOn(cache, "events");
    const retryCache = await SubscriberCache.open(
      join(directory, "retry-subscriber"),
      {
        serverOrigin: server.url,
        streamId: session.info.id,
        initialize: async () => ({ revision: session.info.revision }),
      },
    );
    await retryCache.commit(events, {
      ...retryCache.cursor,
      serverSeq: session.boundary.sequence,
    });
    const retryState = await TerminalWatchState.open(
      retryCache,
      signal(),
      snapshots,
    );
    const renewals = vi
      .spyOn(snapshots, "renewLease")
      .mockRejectedValueOnce(new TypeError("offline during admission"));
    try {
      const fallback = await retryState.select(
        retryCache.cursor.serverSeq,
        signal(),
      );
      expect(fallback.appliedSeq).toBe(retryCache.cursor.serverSeq);
      const admitted = JSON.parse(
        await readFile(
          join(retryCache.contentDirectory, "leases.json"),
          "utf8",
        ),
      ).leases[0];
      expect(admitted).toBeDefined();
      renewals.mockClear();
      await retryState.select(retryCache.cursor.serverSeq, signal());
      expect(
        renewals.mock.calls.some(([lease]) => lease.token === admitted.token),
      ).toBe(true);
    } finally {
      renewals.mockRestore();
      await retryState.close();
      await retryCache.close();
    }
    blobs.mockClear();
    const selected = await state.select(cache.cursor.serverSeq, signal());
    expect(reads.mock.calls).toEqual([[through, cache.cursor.serverSeq]]);
    expect(blobs).toHaveBeenCalled();
    expect(
      (await state.reducer.materialize(selected)).messages.get("m")!.text,
    ).toBe("remote prefix local suffix");
    expect(cache.cursor.serverSeq).toBe(events.length);
    await state.save(selected, signal());
    reads.mockClear();
    // A future snapshot cannot substitute for an earlier exact prefix, even with timestamp ties.
    const earlier = await state.select(through - 1, signal());
    expect(earlier.appliedSeq).toBe(through - 1);
    expect(
      (await state.reducer.materialize(earlier)).messages.get("m")!.text,
    ).toBe("");
    expect(reads.mock.calls).toEqual([[0, through - 1]]);
    const { ProtocolError } =
      await import("../../packages/protocol/dist/index.js");
    const opening = vi
      .spyOn(state.reducer, "open")
      .mockRejectedValueOnce(
        new ProtocolError("stale_lease", "expired during seek"),
      );
    reads.mockClear();
    const rebuiltDuringSeek = await state.select(
      cache.cursor.serverSeq,
      signal(),
    );
    expect(reads.mock.calls).toEqual([[0, cache.cursor.serverSeq]]);
    expect(
      (await state.reducer.materialize(rebuiltDuringSeek)).messages.get("m")!
        .text,
    ).toBe("remote prefix local suffix");
    opening.mockRestore();
    await state.save(rebuiltDuringSeek, signal());
    // Reacquire an import for the later explicit server-release recovery check.
    await state.select(through, signal());
    await state.close();
    state = await TerminalWatchState.open(cache, signal());
    reads.mockClear();
    const reopened = await state.select(cache.cursor.serverSeq, signal());
    expect(reads.mock.calls).toEqual([
      [cache.cursor.serverSeq, cache.cursor.serverSeq],
    ]);
    expect(
      (await state.reducer.materialize(reopened)).messages.get("m")!.text,
    ).toBe("remote prefix local suffix");
    await state.close();
    // A temporary selection transport failure preserves cached reconstruction.
    selects.mockRejectedValue(new TypeError("offline"));
    state = await TerminalWatchState.open(cache, signal(), snapshots);
    expect((await state.select(through - 1, signal())).appliedSeq).toBe(
      through - 1,
    );
    const abort = new AbortController();
    abort.abort(new Error("seek cancelled"));
    await expect(state.select(through - 1, abort.signal)).rejects.toThrow(
      "seek cancelled",
    );
    await state.close();
    const savedLeases = JSON.parse(
      await readFile(join(cache.contentDirectory, "leases.json"), "utf8"),
    );
    expect(savedLeases.leases.length).toBeGreaterThan(0);
    for (const lease of savedLeases.leases)
      await session.releaseSnapshotLease(lease.token, signal());
    state = await TerminalWatchState.open(cache, signal(), snapshots);
    reads.mockClear();
    const recovered = await state.select(cache.cursor.serverSeq, signal());
    expect(reads.mock.calls).toEqual([[0, cache.cursor.serverSeq]]);
    expect(
      (await state.reducer.materialize(recovered)).messages.get("m")!.text,
    ).toBe("remote prefix local suffix");
    expect(
      JSON.parse(
        await readFile(join(cache.contentDirectory, "leases.json"), "utf8"),
      ).leases,
    ).toEqual([]);
    await state.save(recovered, signal());
    selects.mockRestore();
    await state.close();
    snapshots.close();
    snapshots = new RecordingSnapshotClient({
      serverOrigin: server.url,
      streamId: session.info.id,
      revision: session.info.revision,
      credential: "wrong",
    });
    state = await TerminalWatchState.open(cache, signal(), snapshots);
    await expect(state.select(through - 1, signal())).rejects.toMatchObject({
      code: "forbidden",
    });
  } finally {
    await state?.close();
    snapshots?.close();
    await cache?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("serializes checkpoint saves and drains an interrupted save before close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-watch-save-"));
  const cache = await SubscriberCache.open(directory, {
    serverOrigin: "http://localhost:7331",
    streamId: "stream",
    initialize: async () => ({ revision: "revision" }),
  });
  const state = await TerminalWatchState.open(cache, signal());
  try {
    const events: StoredEvent[] = [1, 2].map((seq) => ({
      protocolVersion: 1,
      serverSeq: seq,
      timelineMs: seq,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `save-${seq}` },
      content: {
        kind: "message.started",
        payload: { messageId: `m-${seq}`, role: "assistant" },
      },
    }));
    await cache.commit(events, { ...cache.cursor, serverSeq: 2 });
    let first = await state.select(1, signal());
    let second = await state.select(2, signal());
    await Promise.all([
      state.save(first, signal()),
      state.save(second, signal()),
    ]);
    const path = join(cache.contentDirectory, "checkpoints.json");
    let releaseRace!: () => void, enterRace!: () => void;
    const raceReady = new Promise<void>((resolve) => {
      enterRace = resolve;
    });
    const raceGate = new Promise<void>((resolve) => {
      releaseRace = resolve;
    });
    const originalCheckpoint = state.reducer.checkpoint.bind(state.reducer);
    const raceSpy = vi
      .spyOn(state.reducer, "checkpoint")
      .mockImplementationOnce(async (...args) => {
        enterRace();
        await raceGate;
        return originalCheckpoint(...args);
      });
    try {
      const saving = state.save(second, signal());
      const rejected = expect(saving).rejects.toMatchObject({
        code: "stale_lease",
      });
      await raceReady;
      const { ProtocolError } =
        await import("../../packages/protocol/dist/index.js");
      const output = (async function* () {
        throw new ProtocolError("stale_lease", "invalidate during save");
      })();
      let replaced = false;
      for await (const text of state.render(
        output,
        second,
        async function* () {
          yield "replacement";
        },
        () => {
          replaced = true;
        },
        signal(),
      ))
        void text;
      expect(replaced).toBe(true);
      releaseRace();
      await rejected;
      expect(JSON.parse(await readFile(path, "utf8")).checkpoints).toEqual([]);
    } finally {
      releaseRace();
      raceSpy.mockRestore();
    }
    await expect(state.save(first, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    await expect(state.save(second, signal())).rejects.toMatchObject({
      code: "stale_lease",
    });
    const recoveredAdvance = await state.advance(first, events[1]!, signal());
    expect(recoveredAdvance.recovered).toBe(true);
    expect(recoveredAdvance.state.appliedSeq).toBe(2);
    await state.save(recoveredAdvance.state, signal());
    first = await state.select(1, signal());
    second = await state.select(2, signal());
    await Promise.all([
      state.save(first, signal()),
      state.save(second, signal()),
    ]);
    const before = await readFile(path, "utf8");
    expect(
      JSON.parse(before).checkpoints.map(
        (entry: { serverSeq: number }) => entry.serverSeq,
      ),
    ).toEqual([1, 2]);
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const checkpoint = state.reducer.checkpoint.bind(state.reducer);
    const spy = vi
      .spyOn(state.reducer, "checkpoint")
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return checkpoint(...args);
      });
    try {
      const saving = state.save(second, signal());
      const rejected = expect(saving).rejects.toThrow("closing");
      await ready;
      let closed = false;
      const closing = state.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(state.save(first, signal())).rejects.toThrow("closing");
      await expect(state.select(1, signal())).rejects.toThrow("closing");
      resume();
      await rejected;
      await closing;
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      resume();
      spy.mockRestore();
    }
  } finally {
    await state.close();
    await cache.close();
    await rm(directory, { recursive: true, force: true });
  }
});
