import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import {
  PagedReducer,
  initialPagedState,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory, IDBObjectStore } = require("fake-indexeddb");
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
const event = (seq: number, content: StoredEvent["content"]): StoredEvent => ({
  protocolVersion: 1,
  serverSeq: seq,
  timelineMs: seq,
  receivedAt: "2026-09-10T00:00:00Z",
  origin: { type: "server", operationId: `op-${seq}` },
  content,
});
const started = (id = "m") =>
  event(1, {
    kind: "message.started",
    payload: { messageId: id, role: "assistant" },
  });
it("reopens the last published root and continues without retaining the event prefix", async () => {
  const factory = new IDBFactory();
  let session = await BrowserPagedState.open(factory, binding, signal());
  try {
    await session.apply(
      [
        started(),
        event(2, {
          kind: "message.text.append",
          payload: { messageId: "m", text: "prefix" },
        }),
      ],
      signal(),
    );
    expect(session.checkpoint!.serverSeq).toBe(2);
    await session.close();
    session = await BrowserPagedState.open(factory, binding, signal());
    expect(session.state.appliedSeq).toBe(2);
    await session.apply(
      [
        event(3, {
          kind: "message.text.append",
          payload: { messageId: "m", text: "suffix" },
        }),
      ],
      signal(),
    );
    const message = await session.get("messages", "m");
    expect(await session.text(message!.text, 0, 12)).toBe("prefixsuffix");
    const root = session.state;
    root.maps.messages = null;
    expect((await session.entries("messages", 0, 1)).length).toBe(1);
  } finally {
    await session.close();
  }
});
it("keeps failed and cancelled batches unpublished", async () => {
  const factory = new IDBFactory();
  let session = await BrowserPagedState.open(factory, binding, signal());
  try {
    await session.apply([started()], signal());
    await expect(
      session.apply(
        [
          event(2, {
            kind: "message.text.append",
            payload: { messageId: "m", text: "abandoned" },
          }),
          event(3, {
            kind: "message.completed",
            payload: { messageId: "missing" },
          }),
        ],
        signal(),
      ),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      session.apply(
        [event(2, { kind: "message.completed", payload: { messageId: "m" } })],
        abort.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(session.state.appliedSeq).toBe(1);
    await session.close();
    session = await BrowserPagedState.open(factory, binding, signal());
    expect(session.state.appliedSeq).toBe(1);
    expect((await session.get("messages", "m"))!.text.units).toBe(0);
  } finally {
    await session.close();
  }
});
it("rejects a divergent concurrent writer and preserves the winning checkpoint", async () => {
  const factory = new IDBFactory(),
    a = await BrowserPagedState.open(factory, binding, signal()),
    b = await BrowserPagedState.open(factory, binding, signal());
  try {
    const outcomes = await Promise.allSettled([
      a.apply([started("a")], signal()),
      b.apply([started("b")], signal()),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        outcomes.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ code: "event_conflict" });
    const winner = outcomes[0]!.status === "fulfilled" ? "a" : "b";
    const reopened = await BrowserPagedState.open(factory, binding, signal());
    try {
      expect((await reopened.get("messages", winner))!.id).toBe(winner);
      expect(
        await reopened.get("messages", winner === "a" ? "b" : "a"),
      ).toBeUndefined();
    } finally {
      await reopened.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
});
it("validates root bindings and boundaries and permits an exact publication retry", async () => {
  const factory = new IDBFactory(),
    store = await BrowserContentStore.open(factory, binding, signal()),
    reducer = new PagedReducer(store);
  try {
    const root = await reducer.apply(initialPagedState(), started());
    const ref = await reducer.checkpoint(root, binding);
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 1,
      ref,
    };
    await expect(
      store.publishCheckpoint(null, { ...head, timelineMs: 2 }),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const foreign = await reducer.checkpoint(root, {
      ...binding,
      revision: "other",
    });
    await expect(
      store.publishCheckpoint(null, { ...head, ref: foreign }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(await store.loadCheckpoint()).toBeNull();
    expect(await store.publishCheckpoint(null, head)).toEqual(head);
    expect(await store.publishCheckpoint(null, head)).toEqual(head);
    const earlier = await reducer.checkpoint(initialPagedState(), binding);
    await expect(
      store.publishCheckpoint(head, {
        ...head,
        serverSeq: 0,
        timelineMs: 0,
        ref: earlier,
      }),
    ).rejects.toMatchObject({ code: "event_conflict" });
    expect(await store.loadCheckpoint()).toEqual(head);
  } finally {
    await store.close();
  }
});

it("rolls back checkpoint publication when cancelled during the root transaction", async () => {
  const factory = new IDBFactory();
  let session = await BrowserPagedState.open(factory, binding, signal());
  const stop = new AbortController();
  const original = IDBObjectStore.prototype.put;
  let intercepted = false;
  try {
    await session.apply([started()], signal());
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = original.call(this, value, key);
        if (
          this.name === "meta" &&
          typeof key === "string" &&
          key.startsWith("root:")
        ) {
          intercepted = true;
          stop.abort(new Error("cancel during publication"));
        }
        return request;
      });
    try {
      await expect(
        session.apply(
          [
            event(2, {
              kind: "message.text.append",
              payload: { messageId: "m", text: "unpublished" },
            }),
          ],
          stop.signal,
        ),
      ).rejects.toThrow("cancel during publication");
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(true);
    expect(session.state.appliedSeq).toBe(1);
    await session.close();
    session = await BrowserPagedState.open(factory, binding, signal());
    expect(session.state.appliedSeq).toBe(1);
    expect((await session.get("messages", "m"))!.text.units).toBe(0);
  } finally {
    await session.close();
  }
});
