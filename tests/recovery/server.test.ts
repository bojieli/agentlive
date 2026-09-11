import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecordingStore,
  type CreateSession,
} from "../../packages/server/src/index.js";
import type {
  PublishedEvent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const roots: string[] = [];
const stores: RecordingStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const request = (): CreateSession => ({
  ownerId: "owner",
  requestId: "create_1",
  requestedAt: new Date().toISOString(),
  publisherId: "publisher_1",
  producerEpoch: "epoch_1",
  writeSecret: "a".repeat(64),
  title: "Synthetic recording",
  visibility: "unlisted",
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-server-test-"));
  roots.push(root);
  const store = await RecordingStore.open(root);
  stores.push(store);
  const input = request();
  const session = await store.create(input);
  const resumed = await session.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 1,
    revision: session.info.revision,
  });
  return { root, store, input, session, lease: resumed.lease };
}
function event(
  streamId: string,
  producerSeq: number,
  text = "hello",
): PublishedEvent {
  return {
    protocolVersion: 1,
    streamId,
    producerEpoch: "epoch_1",
    producerSeq,
    observedAt: new Date().toISOString(),
    clockSegmentId: "clock_1",
    elapsedMs: producerSeq * 100,
    fidelity: "delta",
    source: { agent: "synthetic", sessionId: "native_1" },
    content:
      producerSeq === 1
        ? {
            kind: "message.started",
            payload: { messageId: "m1", role: "assistant" },
          }
        : { kind: "message.text.append", payload: { messageId: "m1", text } },
  };
}
it("returns one session for concurrent creation retries and never persists the write secret", async () => {
  const { root, store, input, session } = await setup();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.create(input)),
  );
  expect(new Set(results.map((x) => x.info.id))).toEqual(
    new Set([session.info.id]),
  );
  expect(
    await readFile(
      join(root, "sessions", session.info.id, "metadata.json"),
      "utf8",
    ),
  ).not.toContain(input.writeSecret);
  await expect(
    store.create({ ...input, title: "changed" }),
  ).rejects.toMatchObject({ code: "event_conflict" });
});
it("recovers server cursor after restart and deduplicates an ACK-lost publisher batch", async () => {
  const { root, store, input, session, lease } = await setup();
  const events = [event(session.info.id, 1), event(session.info.id, 2)];
  const ack = await session.append(lease, events);
  expect(ack.throughProducerSeq).toBe(2);
  const id = session.info.id;
  const revision = session.info.revision;
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const restarted = await RecordingStore.open(root);
  stores.push(restarted);
  const recovered = await restarted.get(id);
  const resumed = await recovered.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 2,
    revision,
  });
  expect(resumed.ack).toEqual(ack);
  expect(await recovered.append(resumed.lease, events)).toEqual(ack);
  expect(recovered.boundary.sequence).toBe(3);
  await expect(recovered.append(lease, [event(id, 3)])).rejects.toMatchObject({
    code: "stale_lease",
  });
  await expect(
    recovered.append(resumed.lease, [
      {
        ...events[1]!,
        content: {
          kind: "message.text.append",
          payload: { messageId: "m1", text: "conflict" },
        },
      },
    ]),
  ).rejects.toMatchObject({ code: "event_conflict" });
});
it("rejects gaps and delayed reconnects without poisoning the accepted publisher", async () => {
  const { session, input, lease } = await setup();
  await expect(
    session.append(lease, [event(session.info.id, 2)]),
  ).rejects.toMatchObject({ code: "sequence_gap" });
  const resumed = await session.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 3,
    revision: session.info.revision,
  });
  await expect(
    session.resume(input.writeSecret, {
      publisherId: input.publisherId,
      producerEpoch: input.producerEpoch,
      attempt: 2,
      revision: session.info.revision,
    }),
  ).rejects.toMatchObject({ code: "stale_lease" });
  expect(
    (await session.append(resumed.lease, [event(session.info.id, 1)]))
      .throughProducerSeq,
  ).toBe(1);
});
it("captures a history/live boundary without missing or duplicating an append", async () => {
  const { session, lease } = await setup();
  await session.append(lease, [event(session.info.id, 1)]);
  const live: StoredEvent[] = [];
  const subscription = session.subscribe({
    deliver: (value) => live.push(value),
    invalidate: () => {},
  });
  const append = session.append(lease, [event(session.info.id, 2)]);
  const { boundary, unsubscribe } = await subscription;
  await append;
  const history = [];
  for await (const value of session.history(0, boundary.sequence))
    history.push(value);
  expect([...history, ...live].map((x) => x.serverSeq)).toEqual([1, 2, 3]);
  unsubscribe();
  await session.append(lease, [event(session.info.id, 3)]);
  expect(live).toHaveLength(1);
});
it("makes explicit finish/reopen idempotent with lifecycle preconditions", async () => {
  const { session, input, lease } = await setup();
  await session.append(lease, [event(session.info.id, 1)]);
  const finish = {
    kind: "recording.ended" as const,
    payload: { producerEpoch: input.producerEpoch, throughProducerSeq: 1 },
  };
  const ended = await session.lifecycle(
    input.writeSecret,
    "finish_1",
    1,
    finish,
  );
  expect(session.info.lifecycle).toBe("ended");
  expect(
    await session.lifecycle(input.writeSecret, "finish_1", 1, finish),
  ).toEqual(ended);
  await expect(
    session.append(lease, [event(session.info.id, 2)]),
  ).rejects.toMatchObject({ code: "stale_lease" });
  const reopened = await session.lifecycle(
    input.writeSecret,
    "reopen_1",
    ended.serverSeq,
    { kind: "recording.reopened", payload: {} },
  );
  expect(session.info.lifecycle).toBe("open");
  await expect(
    session.lifecycle(input.writeSecret, "late_reopen", ended.serverSeq, {
      kind: "recording.reopened",
      payload: {},
    }),
  ).rejects.toMatchObject({ code: "precondition_failed" });
  expect(reopened.serverSeq).toBe(ended.serverSeq + 1);
});
it("authenticates publishers and refuses a second owner of the data directory", async () => {
  const { root, session, input } = await setup();
  await expect(RecordingStore.open(root)).rejects.toMatchObject({
    code: "publisher_busy",
  });
  await expect(
    session.resume("wrong", {
      publisherId: input.publisherId,
      producerEpoch: input.producerEpoch,
      attempt: 2,
      revision: session.info.revision,
    }),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

it("isolates subscriber callback mutation from other subscribers and the durable log", async () => {
  const { session, lease } = await setup();
  const observed: StoredEvent[] = [];
  await session.subscribe({
    deliver: (event) => {
      event.serverSeq = 999;
    },
    invalidate: () => {},
  });
  await session.subscribe({
    deliver: (event) => observed.push(event),
    invalidate: () => {},
  });
  await session.append(lease, [event(session.info.id, 1)]);
  expect(observed[0]?.serverSeq).toBe(2);
  const stored = [];
  for await (const value of session.history(1, 2)) stored.push(value);
  expect(stored[0]?.serverSeq).toBe(2);
});

it("publishes attachment versions only after durable upload and preserves them across restart", async () => {
  const { createHash } = await import("node:crypto");
  const { root, store, session, input, lease } = await setup();
  const bytes = Buffer.from("synthetic image");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const descriptor = { hash, byteSize: bytes.length };
  const available: PublishedEvent = {
    ...event(session.info.id, 1),
    content: {
      kind: "attachment.available",
      payload: {
        attachment: {
          ...descriptor,
          artifactId: "image",
          version: 1,
          filename: "image.png",
          mediaType: "image/png",
        },
      },
    },
  };
  await expect(session.append(lease, [available])).rejects.toMatchObject({
    code: "precondition_failed",
  });
  await session.uploadAttachment(
    input.writeSecret,
    descriptor,
    (async function* () {
      yield bytes;
    })(),
  );
  expect(await session.attachmentStatus(input.writeSecret, descriptor)).toBe(
    true,
  );
  await expect(session.openAttachment(hash)).rejects.toMatchObject({
    code: "precondition_failed",
  });
  await session.append(lease, [available]);
  const file = await session.openAttachment(hash);
  expect(await file.readFile()).toEqual(bytes);
  await file.close();
  expect(await session.collectUnreferencedAttachments(Date.now() + 1000)).toBe(
    0,
  );
  const id = session.info.id;
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = await RecordingStore.open(root);
  stores.push(reopened);
  const recovered = await reopened.get(id);
  const recoveredFile = await recovered.openAttachment(hash);
  expect(await recoveredFile.readFile()).toEqual(bytes);
  await recoveredFile.close();
});
it("rejects a reference whose uploaded bytes were collected before commit, without advancing the publisher cursor", async () => {
  const { createHash } = await import("node:crypto");
  const { session, input, lease } = await setup();
  const bytes = Buffer.from("orphan");
  const descriptor = {
    hash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
  await session.uploadAttachment(
    input.writeSecret,
    descriptor,
    (async function* () {
      yield bytes;
    })(),
  );
  await session.collectUnreferencedAttachments(Date.now() + 1000);
  await expect(
    session.append(lease, [
      {
        ...event(session.info.id, 1),
        content: {
          kind: "attachment.available",
          payload: {
            attachment: {
              ...descriptor,
              artifactId: "a",
              version: 1,
              filename: "a.txt",
              mediaType: "text/plain",
            },
          },
        },
      },
    ]),
  ).rejects.toMatchObject({ code: "precondition_failed" });
  expect(session.boundary.sequence).toBe(1);
});
it("rejects plan links to attachment versions that have not been announced", async () => {
  const { session, lease } = await setup();
  const update: PublishedEvent = {
    ...event(session.info.id, 1),
    content: {
      kind: "plan.updated",
      payload: {
        planId: "plan",
        status: "active",
        attachment: { artifactId: "missing", version: 1 },
      },
    },
  };
  const before = session.boundary.sequence;
  await expect(session.append(lease, [update])).rejects.toMatchObject({
    code: "precondition_failed",
  });
  expect(session.boundary.sequence).toBe(before);
});

it("bounds cached sessions, retains owned sessions and reopens evicted durable history", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-bounded-store-"));
  roots.push(root);
  const store = await RecordingStore.open(root, { maxCachedSessions: 2 });
  stores.push(store);
  const input = request();
  const a = await store.create(input);
  const aId = a.info.id;
  const resumed = await a.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 1,
    revision: a.info.revision,
  });
  await a.append(resumed.lease, [event(aId, 1)]);
  const b = await store.create({ ...input, requestId: "b" });
  const again = await store.get(aId);
  expect(again).toBe(a);
  store.release(again);
  await expect(
    store.create({ ...input, requestId: "c" }),
  ).rejects.toMatchObject({ code: "retry_later" });
  store.release(b);
  const c = await store.create({ ...input, requestId: "c" });
  expect(store.cacheSize).toBe(2);
  expect(a.boundary.sequence).toBe(2);
  store.release(a);
  store.release(c);
  const bRestored = await store.get(b.info.id);
  expect(bRestored).not.toBe(b);
  store.release(bRestored);
  const aRestored = await store.get(aId);
  expect(aRestored).not.toBe(a);
  expect(aRestored.boundary.sequence).toBe(2);
  expect(aRestored.info.revision).toBe(a.info.revision);
  const resumedAfterEviction = await aRestored.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 2,
    revision: aRestored.info.revision,
  });
  expect(resumedAfterEviction.ack.throughProducerSeq).toBe(1);
  store.release(aRestored);
  expect(() => store.release(aRestored)).toThrow("ownership");
  expect(store.cacheSize).toBe(2);
});

it("waits for every session cleanup before releasing the directory lock after a close failure", async () => {
  const { root, store, session, input } = await setup();
  stores.splice(stores.indexOf(store), 1);
  const other = await store.create({ ...input, requestId: "other-close" });
  const closeFirst = session.close.bind(session);
  const closeOther = other.close.bind(other);
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  vi.spyOn(session, "close").mockImplementation(async () => {
    await closeFirst();
    throw new Error("Injected close failure");
  });
  const pending = vi.spyOn(other, "close").mockImplementation(async () => {
    await gate;
    await closeOther();
  });
  const closing = store.close();
  expect(store.close()).toBe(closing);
  const rejected = expect(closing).rejects.toThrow(
    "Server store cleanup failed",
  );
  try {
    await expect.poll(() => pending.mock.calls.length).toBe(1);
    await expect(RecordingStore.open(root)).rejects.toMatchObject({
      code: "publisher_busy",
    });
  } finally {
    unblock();
    await rejected;
  }
  const reopened = await RecordingStore.open(root);
  await reopened.close();
  expect(pending).toHaveBeenCalledTimes(1);
});
it("attempts log cleanup even when attachment cleanup fails and does not repeat cleanup", async () => {
  const { store, session } = await setup();
  stores.splice(stores.indexOf(store), 1);
  const internals = session as any;
  const closeBlobs = internals.blobs.close.bind(internals.blobs);
  vi.spyOn(internals.blobs, "close").mockImplementation(async () => {
    await closeBlobs();
    throw new Error("Injected attachment cleanup failure");
  });
  const logClose = vi.spyOn(internals.log, "close");
  const closing = session.close();
  expect(session.close()).toBe(closing);
  await expect(closing).rejects.toThrow("Recording session cleanup failed");
  expect(logClose).toHaveBeenCalledTimes(1);
  await expect(store.close()).rejects.toThrow("Server store cleanup failed");
  expect(logClose).toHaveBeenCalledTimes(1);
});

it("retains published snapshot boundaries across appends and server reopen", async () => {
  const { root, store, input, session, lease } = await setup();
  const { openRecordingSnapshot, initialState, apply } =
    await import("../../packages/playback/src/index.js");
  await session.append(lease, [
    event(session.info.id, 1),
    event(session.info.id, 2, "x".repeat(20000) + "🦊"),
  ]);
  const through = session.info.serverSeq;
  const snapshot = await session.buildSnapshot(through);
  await session.append(lease, [event(session.info.id, 3, "suffix")]);
  const id = session.info.id,
    revision = session.info.revision;
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = await RecordingStore.open(root);
  stores.push(reopened);
  const recovered = await reopened.get(id);
  expect(await recovered.selectSnapshot(through - 1)).toBeNull();
  expect(await recovered.selectSnapshot(recovered.info.serverSeq)).toEqual(
    snapshot,
  );
  const reader = await openRecordingSnapshot(
    snapshot,
    { streamId: id, revision },
    {
      put: async () => {
        throw new Error("read-only");
      },
      read: (ref, offset, length, signal) =>
        recovered.readSnapshotContent(ref, offset, length, signal),
    },
  );
  let restored = (await reader.materialize()) as ReturnType<
    typeof initialState
  >;
  expect(restored.appliedSeq).toBe(through);
  for await (const suffix of recovered.history(
    through,
    recovered.info.serverSeq,
  ))
    restored = apply(restored, suffix);
  let reference = initialState();
  for await (const record of recovered.history(0, recovered.info.serverSeq))
    reference = apply(reference, record);
  expect(restored).toStrictEqual(reference);
});

it("keeps publishing during snapshot writes and drains cancelled snapshot ownership before close", async () => {
  const { root, store, session, lease } = await setup();
  const { TextStore } = await import("../../packages/storage/dist/index.js");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = TextStore.prototype.put;
  const delayed = vi
    .spyOn(TextStore.prototype, "put")
    .mockImplementationOnce(async function (input, signal) {
      const ref = await original.call(this, input, signal);
      entered();
      await gate;
      return ref;
    });
  const build = session.buildSnapshot(session.info.serverSeq);
  const rejected = expect(build).rejects.toThrow("closing");
  try {
    await started;
    await session.append(lease, [event(session.info.id, 1)]);
    expect(session.info.serverSeq).toBe(2);
    const closing = store.close();
    await expect(RecordingStore.open(root)).rejects.toThrow();
    release();
    await rejected;
    await closing;
    stores.splice(stores.indexOf(store), 1);
    const reopened = await RecordingStore.open(root);
    stores.push(reopened);
    const recovered = await reopened.get(session.info.id);
    expect(await recovered.selectSnapshot(2)).toBeNull();
    expect((await recovered.buildSnapshot(2)).serverSeq).toBe(2);
  } finally {
    release();
    delayed.mockRestore();
  }
});

it("rejects a corrupted snapshot catalog while retaining authoritative history", async () => {
  const { session } = await setup();
  const { atomicJson } = await import("../../packages/storage/src/index.js");
  const published = await session.buildSnapshot(1);
  await atomicJson(join(session.directory, "snapshots", "catalog.json"), {
    version: 1,
    streamId: session.info.id,
    revision: session.info.revision,
    entries: [{ ...published, timelineMs: published.timelineMs + 1 }],
  });
  await expect(session.selectSnapshot(1)).rejects.toMatchObject({
    code: "corrupt_storage",
  });
  const history = [];
  for await (const record of session.history(0, 1)) history.push(record);
  expect(history).toHaveLength(1);
  expect(history[0].content.kind).toBe("recording.created");
});

it("automatically checkpoints bounded suffixes, resumes after restart and drains cache eviction", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-auto-snapshot-"));
  roots.push(root);
  const options = {
    maxCachedSessions: 1,
    snapshots: { batchEvents: 3, pollMs: 10, intervalMs: 50 },
  };
  let store = await RecordingStore.open(root, options);
  stores.push(store);
  const input = request();
  let session = await store.create(input);
  const id = session.info.id;
  let { lease } = await session.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 1,
    revision: session.info.revision,
  });
  await session.append(
    lease,
    Array.from({ length: 8 }, (_, index) => event(id, index + 1)),
  );
  await expect
    .poll(async () => (await session.selectSnapshot(9))?.serverSeq, {
      timeout: 15000,
    })
    .toBe(9);
  expect(store.snapshotStatus.failures).toBe(0);
  await store.close();
  store = await RecordingStore.open(root, options);
  stores.push(store);
  session = await store.get(id);
  const reads = vi.spyOn(session, "history");
  ({ lease } = await session.resume(input.writeSecret, {
    publisherId: input.publisherId,
    producerEpoch: input.producerEpoch,
    attempt: 2,
    revision: session.info.revision,
  }));
  await session.append(lease, [event(id, 9)]);
  await expect
    .poll(async () => (await session.selectSnapshot(10))?.serverSeq, {
      timeout: 15000,
    })
    .toBe(10);
  expect(reads.mock.calls).toEqual([[9, 10]]);
  reads.mockRestore();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  vi.spyOn(session, "buildSnapshot").mockImplementation(
    async (_through, signal) => {
      entered();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal!.reason);
          },
          { once: true },
        );
      });
    },
  );
  await session.append(lease, [event(id, 10), event(id, 11), event(id, 12)]);
  await ready;
  // A stuck derivative build cannot block durable publisher receipt.
  expect(
    (await session.append(lease, [event(id, 13)])).throughProducerSeq,
  ).toBe(13);
  store.release(session);
  const next = await store.create({ ...input, requestId: "second" });
  expect(cancelled).toBe(true);
  expect(store.cacheSize).toBe(1);
  expect(store.snapshotStatus.registered).toBe(1);
  store.release(next);
  await store.close();
  expect(store.snapshotStatus.active).toBe(0);
}, 30000);
