import { expect, it } from "vitest";
import { MemoryPagedStore } from "../../apps/web/src/memory-paged-store.js";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import {
  ActivityIndex,
  initialActivityIndex,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
const event = (
  serverSeq: number,
  content: StoredEvent["content"],
): StoredEvent => ({
  protocolVersion: 1,
  serverSeq,
  timelineMs: 10,
  receivedAt: "2026-09-10T00:00:00Z",
  origin: { type: "server", operationId: `event-${serverSeq}` },
  content,
});
const started = (id = "m") =>
  event(1, {
    kind: "message.started",
    payload: { messageId: id, role: "assistant" },
  });

it("runs paired receipt and exact tied historical presentation entirely in memory", async () => {
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  const events = [
    started(),
    event(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "before" },
    }),
    event(3, {
      kind: "message.text.append",
      payload: { messageId: "m", text: " after" },
    }),
  ];
  const history = async function* (after: number, through: number) {
    yield* events.filter(
      (item) => item.serverSeq > after && item.serverSeq <= through,
    );
  };
  try {
    await session.apply(events.slice(0, 2), signal());
    const paused = await session.select(10, history, signal(), 2, true);
    await session.apply(events.slice(2), signal());
    const row = (await paused.rows(0, 1, signal()))[0]!;
    const old = (await paused.load(row, signal()))!.texts.text!;
    expect(await old.read(0, old.units, signal())).toBe("before");
    expect(session.state.appliedSeq).toBe(3);
    const selected = await session.select(10, history, signal(), 2, true);
    expect(selected.sequence).toBe(2);
    const current = (await (
      await session.retainedView(signal())
    ).load(row, signal()))!.texts.text!;
    expect(await current.read(0, current.units, signal())).toBe("before after");
    expect((await store.loadCheckpointBefore(10, 2, signal()))!.serverSeq).toBe(
      2,
    );
    await session.saveView(
      {
        serverSeq: 2,
        timelineMs: 10,
        mode: "paused",
        speed: 3,
        idleCapMs: 100,
      },
      signal(),
    );
    await Promise.all([
      session.setTextPage("messages/m/text", 2, signal()),
      session.setExpansion("tools/t", true, signal()),
    ]);
    expect((await session.loadView(signal()))?.serverSeq).toBe(2);
    expect(await session.loadTextPages(signal())).toEqual([
      ["messages/m/text", 2],
    ]);
    expect(await session.loadExpansions(signal())).toEqual(["tools/t"]);
    const copied = (await store.loadCheckpoint())!;
    copied.ref.hash = "0".repeat(64);
    expect((await store.loadCheckpoint())!.ref.hash).not.toBe(copied.ref.hash);
    await expect(
      session.saveView(
        { serverSeq: 4, timelineMs: 10, mode: "paused", speed: 1 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(
      session.apply(
        [event(5, { kind: "message.completed", payload: { messageId: "m" } })],
        signal(),
      ),
    ).rejects.toThrow();
    expect(session.state.appliedSeq).toBe(3);
  } finally {
    await session.close();
  }
  expect(store.usage).toEqual({ bytes: 0, entries: 0 });
  const fresh = new MemoryPagedStore(binding);
  try {
    expect(await fresh.loadCheckpoint()).toBeNull();
    expect(await fresh.loadTextPages(signal())).toEqual([]);
  } finally {
    await fresh.close();
  }
});

it("rejects divergent writers, mismatched activity roots and cancelled metadata publication", async () => {
  const store = new MemoryPagedStore(binding);
  const a = await BrowserPagedState.openContent(store, binding, signal());
  const b = await BrowserPagedState.openContent(store, binding, signal());
  try {
    const outcomes = await Promise.allSettled([
      a.apply([started("a")], signal()),
      b.apply([started("b")], signal()),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      (
        outcomes.find(
          (item) => item.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ code: "event_conflict" });
    const head = (await store.loadCheckpoint())!;
    expect(await store.publishCheckpoint(null, head, signal())).toEqual(head);
    const wrong = await new ActivityIndex(store).checkpoint(
      initialActivityIndex(),
      binding,
    );
    await expect(
      store.publishCheckpoint(head, { ...head, activity: wrong }, signal()),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const stop = new AbortController();
    stop.abort(new Error("cancel metadata"));
    await expect(store.setTextPage("m", 1, stop.signal)).rejects.toThrow(
      "cancel metadata",
    );
    expect(await store.loadTextPages(signal())).toEqual([]);
    expect(await store.loadCheckpoint()).toEqual(head);
  } finally {
    await a.close();
    await b.close();
  }
});

it("bounds visit inspection metadata and drains it on close", async () => {
  const store = new MemoryPagedStore(binding);
  try {
    for (let index = 0; index < 130; index++) {
      await store.setTextPage(
        `artifacts/${index}/versions`,
        index * 32,
        signal(),
      );
      await store.setExpansion(`tools/${index}`, true, signal());
    }
    const pages = await store.loadTextPages(signal());
    expect(pages).toHaveLength(128);
    expect(pages[0]).toEqual(["artifacts/2/versions", 64]);
    pages.splice(0);
    expect(await store.loadTextPages(signal())).toHaveLength(128);
    expect(await store.loadExpansions(signal())).toHaveLength(128);
    const attachment = {
      artifactId: "a",
      version: 1,
      hash: "a".repeat(64),
      filename: "note.txt",
      mediaType: "text/plain",
      byteSize: 5,
    };
    await store.setAttachmentChoice(attachment, signal());
    attachment.filename = "mutated.txt";
    expect((await store.loadAttachmentChoice(signal()))?.filename).toBe(
      "note.txt",
    );
    const work = Array.from({ length: 16 }, (_, index) =>
      store.setTextPage(`pending/${index}`, index, signal()),
    );
    const settled = Promise.allSettled(work);
    await expect(
      store.setExpansion("overflow", true, signal()),
    ).rejects.toMatchObject({ code: "retry_later" });
    await store.close();
    await settled;
    await expect(store.loadCheckpoint()).rejects.toThrow("closing");
    expect(store.usage).toEqual({ bytes: 0, entries: 0 });
  } finally {
    await store.close();
  }
});

it("closes owned content when an existing checkpoint cannot open under the requested revision", async () => {
  const store = new MemoryPagedStore(binding);
  const session = await BrowserPagedState.openContent(store, binding, signal());
  await session.apply([started()], signal());
  expect(store.usage.bytes).toBeGreaterThan(0);
  await expect(
    BrowserPagedState.openContent(
      store,
      { ...binding, revision: "other" },
      signal(),
    ),
  ).rejects.toThrow();
  expect(store.usage).toEqual({ bytes: 0, entries: 0 });
  await session.close();
});
