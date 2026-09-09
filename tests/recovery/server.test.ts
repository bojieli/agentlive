import { afterEach, expect, it } from "vitest";
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
