import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { BrowserPagedState } from "../../apps/web/src/paged-state.js";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import {
  ActivityIndex,
  initialActivityIndex,
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

async function legacy(factory: IDBFactory) {
  const store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(store);
    const root = await reducer.apply(initialPagedState(), started());
    await store.publishCheckpoint(null, {
      format: "agentlive.paged-state",
      serverSeq: 1,
      timelineMs: 1,
      ref: await reducer.checkpoint(root, binding),
    });
  } finally {
    await store.close();
  }
}
async function* history(...events: StoredEvent[]) {
  yield* events;
}

it("upgrades a legacy checkpoint only after a complete matching history and reopens paired rows", async () => {
  const factory = new IDBFactory();
  await legacy(factory);
  let session = await BrowserPagedState.open(factory, binding, signal());
  try {
    const old = session.checkpoint;
    expect(session.needsActivityRebuild).toBe(true);
    expect((await session.get("messages", "m"))!.id).toBe("m");
    await expect(
      session.rebuildActivity(history(), signal()),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    await expect(
      session.rebuildActivity(history(started("other")), signal()),
    ).rejects.toMatchObject({ code: "event_conflict" });
    expect(session.checkpoint).toEqual(old);
    await expect(
      session.apply(
        [event(2, { kind: "message.completed", payload: { messageId: "m" } })],
        signal(),
      ),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    await session.rebuildActivity(history(started()), signal());
    expect(session.checkpoint!.ref).toEqual(old!.ref);
    expect(session.checkpoint!.activity).toBeDefined();
    await session.close();
    session = await BrowserPagedState.open(factory, binding, signal());
    expect(session.needsActivityRebuild).toBe(false);
    expect(session.view().rowCount).toBe(1);
    expect(
      (await session.view().rows(0, 32, signal())).map((row) => row.key),
    ).toEqual(["messages/m"]);
    expect(await session.view().position("messages/m", signal())).toBe(0);
    await session.apply(
      [event(2, { kind: "message.completed", payload: { messageId: "m" } })],
      signal(),
    );
    expect(session.checkpoint!.serverSeq).toBe(2);
  } finally {
    await session.close();
  }
});

it("cancels a stalled legacy history read without waiting for iterator cleanup", async () => {
  const factory = new IDBFactory();
  await legacy(factory);
  const session = await BrowserPagedState.open(factory, binding, signal());
  const stop = new AbortController();
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const returned = vi.fn(
    () => new Promise<IteratorResult<StoredEvent>>(() => {}),
  );
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reading();
          return new Promise<IteratorResult<StoredEvent>>(() => {});
        },
        return: returned,
      };
    },
  };
  try {
    const task = session.rebuildActivity(source, stop.signal);
    await entered;
    stop.abort(new Error("stop rebuild"));
    await expect(task).rejects.toThrow("stop rebuild");
    expect(returned).toHaveBeenCalledOnce();
    expect(session.needsActivityRebuild).toBe(true);
    await session.rebuildActivity(history(started()), signal());
    expect(session.needsActivityRebuild).toBe(false);
  } finally {
    await session.close();
  }
});

it("rejects activity roots from another boundary or revision before atomic publication", async () => {
  const factory = new IDBFactory();
  const store = await BrowserContentStore.open(factory, binding, signal());
  try {
    const reducer = new PagedReducer(store),
      index = new ActivityIndex(store);
    const state = await reducer.apply(initialPagedState(), started());
    const rows = await index.apply(
      initialActivityIndex(),
      started(),
      state,
      reducer,
    );
    const head = {
      format: "agentlive.paged-state" as const,
      serverSeq: 1,
      timelineMs: 1,
      ref: await reducer.checkpoint(state, binding),
    };
    const wrongBoundary = await index.checkpoint(
      initialActivityIndex(),
      binding,
    );
    await expect(
      store.publishCheckpoint(null, { ...head, activity: wrongBoundary }),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const wrongRevision = await index.checkpoint(rows, {
      ...binding,
      revision: "other",
    });
    await expect(
      store.publishCheckpoint(null, { ...head, activity: wrongRevision }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(await store.loadCheckpoint()).toBeNull();
    const paired = { ...head, activity: await index.checkpoint(rows, binding) };
    await store.publishCheckpoint(null, paired);
    expect(await store.publishCheckpoint(null, paired)).toEqual(paired);
    await expect(store.publishCheckpoint(paired, head)).rejects.toMatchObject({
      code: "event_conflict",
    });
    expect(await store.loadCheckpoint()).toEqual(paired);
  } finally {
    await store.close();
  }
});

it("keeps receipt progressing during a stalled seek and aborts the seek independently", async () => {
  const state = await BrowserPagedState.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  try {
    await state.apply(
      [
        started(),
        event(2, {
          kind: "message.text.append",
          payload: { messageId: "m", text: "two" },
        }),
      ],
      signal(),
    );
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stop = new AbortController();
    const source = (_after: number, _through: number) => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            entered();
            return new Promise<IteratorResult<StoredEvent>>(() => {});
          },
          return() {
            return new Promise<IteratorResult<StoredEvent>>(() => {});
          },
        };
      },
    });
    const selection = state.select(1, source, stop.signal);
    await reading;
    await state.apply(
      [event(3, { kind: "message.completed", payload: { messageId: "m" } })],
      signal(),
    );
    expect(state.checkpoint!.serverSeq).toBe(3);
    stop.abort(new Error("replace seek"));
    await expect(selection).rejects.toThrow("replace seek");
    const latest = await state.select(3, () => history(), signal());
    expect(latest.sequence).toBe(3);
    await expect(
      state.select(0, () => history(), signal()),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    expect(state.checkpoint!.serverSeq).toBe(3);
  } finally {
    await state.close();
  }
});

it("restores an exact paused prefix when later events share its timestamp", async () => {
  const factory = new IDBFactory();
  let state = await BrowserPagedState.open(factory, binding, signal());
  const events = [
    started(),
    {
      ...event(2, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "later tie" },
      }),
      timelineMs: 1,
    },
  ];
  try {
    await state.apply(events, signal());
    await state.saveView(
      { serverSeq: 1, timelineMs: 1, speed: 2, mode: "paused" },
      signal(),
    );
    await expect(
      state.saveView(
        { serverSeq: 3, timelineMs: 1, speed: 2, mode: "paused" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    await state.close();
    state = await BrowserPagedState.open(factory, binding, signal());
    const saved = (await state.loadView(signal()))!;
    const view = await state.select(
      saved.timelineMs,
      (after, through) => history(...events.slice(after, through)),
      signal(),
      saved.serverSeq,
    );
    expect(view.sequence).toBe(1);
    const row = (await view.rows(0, 1, signal()))[0]!;
    expect((await view.load(row, signal()))!.texts.text!.units).toBe(0);
    expect(state.state.appliedSeq).toBe(2);
  } finally {
    await state.close();
  }
});

it("reopens seek landmarks and requests only their missing suffix", async () => {
  const factory = new IDBFactory();
  let state = await BrowserPagedState.open(factory, binding, signal());
  const events = [
    started(),
    {
      ...event(2, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "checkpoint" },
      }),
      timelineMs: 10001,
    },
    {
      ...event(3, {
        kind: "message.text.append",
        payload: { messageId: "m", text: " suffix" },
      }),
      timelineMs: 10002,
    },
    {
      ...event(4, {
        kind: "message.text.append",
        payload: { messageId: "m", text: " future" },
      }),
      timelineMs: 20001,
    },
  ];
  try {
    for (const item of events) await state.apply([item], signal());
    await state.close();
    state = await BrowserPagedState.open(factory, binding, signal());
    const requests: number[][] = [];
    const selected = await state.select(
      10002,
      (after, through) => {
        requests.push([after, through]);
        return history(...events.slice(after, through));
      },
      signal(),
      undefined,
      true,
    );
    expect(requests).toEqual([[2, 4]]);
    expect(selected.sequence).toBe(3);
    const row = (await selected.rows(0, 1, signal()))[0]!;
    const source = (await selected.load(row, signal()))!.texts.text!;
    expect(await source.read(0, source.units, signal())).toBe(
      "checkpoint suffix",
    );
    expect(state.checkpoint!.serverSeq).toBe(4);
    // An exact saved prefix never includes later objects at the same time.
    const earlier = await state.select(
      10001,
      (_after, _through) => history(),
      signal(),
      2,
    );
    expect(earlier.sequence).toBe(2);
    await state.close();
    state = await BrowserPagedState.open(factory, binding, signal());
    const restored = await state.select(
      10002,
      () => {
        throw new Error("Saved seek should not download history");
      },
      signal(),
      3,
    );
    expect(restored.sequence).toBe(3);
    expect(state.checkpoint!.serverSeq).toBe(4);
  } finally {
    await state.close();
  }
});

it("publishes a seek landmark atomically with its receipt head", async () => {
  const factory = new IDBFactory();
  const state = await BrowserPagedState.open(factory, binding, signal());
  const store = await BrowserContentStore.open(factory, binding, signal());
  const stop = new AbortController();
  const original = IDBObjectStore.prototype.put;
  try {
    await state.apply([started()], signal());
    const old = await store.loadCheckpointBefore(10001, 2, signal());
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const result = original.call(this, value, key);
        if (
          this.name === "meta" &&
          typeof key === "string" &&
          key.startsWith("seek:")
        )
          stop.abort(new Error("cancel landmark"));
        return result;
      });
    try {
      await expect(
        state.apply(
          [
            {
              ...event(2, {
                kind: "message.completed",
                payload: { messageId: "m" },
              }),
              timelineMs: 10001,
            },
          ],
          stop.signal,
        ),
      ).rejects.toThrow("cancel landmark");
    } finally {
      spy.mockRestore();
    }
    expect((await store.loadCheckpoint())!.serverSeq).toBe(1);
    expect(await store.loadCheckpointBefore(10001, 2, signal())).toEqual(old);
  } finally {
    await state.close();
    await store.close();
  }
});
it("cancels historical seek publication without moving receipt or retaining a partial landmark", async () => {
  const factory = new IDBFactory();
  const state = await BrowserPagedState.open(factory, binding, signal());
  const store = await BrowserContentStore.open(factory, binding, signal());
  const events = [
    started(),
    event(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "middle" },
    }),
    event(3, { kind: "message.completed", payload: { messageId: "m" } }),
  ];
  const stop = new AbortController();
  const original = IDBObjectStore.prototype.put;
  try {
    await state.apply(events, signal());
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
          key.startsWith("seek:")
        )
          stop.abort(new Error("cancel selected checkpoint"));
        return request;
      });
    try {
      await expect(
        state.select(
          2,
          (after, through) => history(...events.slice(after, through)),
          stop.signal,
          undefined,
          true,
        ),
      ).rejects.toThrow("cancel selected checkpoint");
    } finally {
      spy.mockRestore();
    }
    expect(await store.loadCheckpointBefore(2, 2, signal())).toBeNull();
    expect((await store.loadCheckpoint())!.serverSeq).toBe(3);
    const selected = await state.select(
      2,
      (after, through) => history(...events.slice(after, through)),
      signal(),
      undefined,
      true,
    );
    expect(selected.sequence).toBe(2);
    expect((await store.loadCheckpointBefore(2, 2, signal()))!.serverSeq).toBe(
      2,
    );
    expect(state.checkpoint!.serverSeq).toBe(3);
  } finally {
    await state.close();
    await store.close();
  }
});
