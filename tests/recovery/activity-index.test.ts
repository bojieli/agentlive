import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { BrowserContentStore } from "../../apps/web/src/content-store.js";
import {
  ActivityIndex,
  initialActivityIndex,
  PagedReducer,
  initialPagedState,
  type ActivityIndexRoot,
} from "../../packages/playback/src/index.js";
import type {
  StoredEvent,
  EventContent,
} from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { IDBFactory } = require("fake-indexeddb");
const binding = {
  serverOrigin: "http://localhost:7331",
  streamId: "stream",
  revision: "revision",
};
const signal = () => AbortSignal.timeout(10000);
const event = (seq: number, content: EventContent): StoredEvent => ({
  protocolVersion: 1,
  serverSeq: seq,
  timelineMs: seq,
  receivedAt: "2026-09-10T00:00:00Z",
  origin: { type: "server", operationId: `event-${seq}` },
  content,
});
async function keys(index: ActivityIndex, root: ActivityIndexRoot) {
  const result: string[] = [];
  for (let offset = 0; offset < (root.visible?.count ?? 0); offset += 32)
    result.push(
      ...(await index.entries(root, offset, 32)).map((row) => row.key),
    );
  return result;
}
it("preserves first mentions, artifact introductions and trailing gap order across reopen", async () => {
  const factory = new IDBFactory();
  let store = await BrowserContentStore.open(factory, binding, signal());
  try {
    let reducer = new PagedReducer(store),
      state = initialPagedState(),
      index = new ActivityIndex(store),
      root = initialActivityIndex();
    const contents: EventContent[] = [
      {
        kind: "message.started",
        payload: { messageId: "m", agentId: "a", role: "assistant" },
      },
      {
        kind: "attachment.available",
        payload: {
          attachment: {
            artifactId: "file",
            version: 1,
            filename: "file",
            hash: "a".repeat(64),
            mediaType: "text/plain",
            byteSize: 1,
          },
        },
      },
      {
        kind: "agent.updated",
        payload: { agentId: "a", nativeSessionId: "native", status: "active" },
      },
      { kind: "capture.gap", payload: { reason: "gap", recoveredState: true } },
      {
        kind: "message.started",
        payload: { messageId: "later", role: "user" },
      },
    ];
    for (const content of contents) {
      const next = event(state.appliedSeq + 1, content);
      state = await reducer.apply(state, next);
      root = await index.apply(root, next, state, reducer);
    }
    expect(await keys(index, root)).toEqual([
      "messages/m",
      "agents/a",
      "artifacts/file",
      "messages/later",
      "gaps/0",
    ]);
    const checkpoint = await index.checkpoint(root, binding),
      stateRef = await reducer.checkpoint(state, binding);
    await store.close();
    store = await BrowserContentStore.open(factory, binding, signal());
    reducer = new PagedReducer(store);
    index = new ActivityIndex(store);
    state = await reducer.open(stateRef, binding);
    root = await index.open(checkpoint, binding);
    const hide = event(6, {
      kind: "object.visibility",
      payload: { objectType: "message", objectId: "m", visible: false },
    });
    state = await reducer.apply(state, hide);
    const hidden = await index.apply(root, hide, state, reducer);
    expect((await keys(index, hidden))[0]).toBe("agents/a");
    expect(await index.position(hidden, "messages/m")).toBeUndefined();
    expect(await index.position(hidden, "agents/a")).toBe(0);
    const show = event(7, {
      kind: "object.visibility",
      payload: { objectType: "message", objectId: "m", visible: true },
    });
    state = await reducer.apply(state, show);
    const restored = await index.apply(hidden, show, state, reducer);
    expect(await keys(index, restored)).toEqual(await keys(index, root));
    await expect(
      index.entries({ ...hidden, visible: root.visible }, 0, 32),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    for (const selected of [root, hidden, restored]) {
      const ref = await index.checkpoint(selected, binding);
      const retained = new Set<string>();
      await index.trace(ref, binding, async (ref) => {
        await store.trace(ref);
        retained.add(ref.hash);
        ref.hash = "0".repeat(64);
      });
      const reader = new ActivityIndex({
        put: async () => {
          throw new Error("No writes during trace recovery");
        },
        read: (ref, offset, length, signal) => {
          if (!retained.has(ref.hash))
            throw new Error("Missing traced reference");
          return store.read(ref, offset, length, signal);
        },
      });
      const reopened = await reader.open(ref, binding);
      expect(await keys(reader, reopened)).toEqual(await keys(index, selected));
      expect(await reader.position(reopened, "messages/m")).toBe(
        await index.position(selected, "messages/m"),
      );
      expect(retained.has("a".repeat(64))).toBe(false);
    }
    const inconsistent = await index.checkpoint(
      { ...hidden, visible: root.visible },
      binding,
    );
    await expect(
      index.trace(inconsistent, binding, async () => {}),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    const missingGap = await index.checkpoint(
      { ...root, gaps: root.gaps + 1 },
      binding,
    );
    await expect(
      index.trace(missingGap, binding, async () => {}),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    let calls = 0;
    await expect(
      index.trace(checkpoint, { ...binding, revision: "other" }, async () => {
        calls++;
      }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(calls).toBe(0);
    const cancel = new AbortController();
    await expect(
      index.trace(
        checkpoint,
        binding,
        async () => {
          calls++;
          cancel.abort(new Error("trace cancelled"));
        },
        cancel.signal,
      ),
    ).rejects.toThrow("trace cancelled");
    expect(calls).toBe(1);
    await expect(
      index.trace(checkpoint, binding, async () => {
        throw new Error("mark failed");
      }),
    ).rejects.toThrow("mark failed");
    await expect(
      index.open(checkpoint, { ...binding, revision: "other" }),
    ).rejects.toMatchObject({ code: "revision_changed" });
  } finally {
    await store.close();
  }
});
it("pages a larger row index and leaves its previous root intact after cancellation", async () => {
  const store = await BrowserContentStore.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  try {
    const reducer = new PagedReducer(store),
      index = new ActivityIndex(store);
    let state = initialPagedState(),
      root = initialActivityIndex();
    for (let i = 0; i < 45; i++) {
      const next = event(i + 1, {
        kind: "message.started",
        payload: { messageId: `m${i}`, role: "assistant" },
      });
      state = await reducer.apply(state, next);
      root = await index.apply(root, next, state, reducer);
    }
    expect((await index.entries(root, 30, 5)).map((row) => row.id)).toEqual([
      "m30",
      "m31",
      "m32",
      "m33",
      "m34",
    ]);
    expect(await index.position(root, "messages/m32")).toBe(32);
    expect(await index.position(root, "messages/missing")).toBeUndefined();
    await expect(index.entries(root, 0, 33)).rejects.toThrow();
    const next = event(46, {
        kind: "message.started",
        payload: { messageId: "new", role: "user" },
      }),
      nextState = await reducer.apply(state, next),
      stop = new AbortController();
    let writes = 0;
    const interrupted = new ActivityIndex({
      read: store.read.bind(store),
      put: async (text, signal) => {
        const ref = await store.put(text, signal);
        if (++writes === 2) stop.abort(new Error("cancel index"));
        return ref;
      },
    });
    await expect(
      interrupted.apply(root, next, nextState, reducer, stop.signal),
    ).rejects.toThrow("cancel index");
    expect((await keys(index, root)).length).toBe(45);
    const final = await index.apply(root, next, nextState, reducer);
    expect((await index.entries(final, 45, 1))[0]!.id).toBe("new");
    await expect(index.apply(root, next, state, reducer)).rejects.toMatchObject(
      { code: "sequence_gap" },
    );
  } finally {
    await store.close();
  }
});

it("advances through text deltas without reading or rewriting the row index", async () => {
  const store = await BrowserContentStore.open(
    new IDBFactory(),
    binding,
    signal(),
  );
  try {
    const reducer = new PagedReducer(store),
      index = new ActivityIndex(store);
    const start = event(1, {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    });
    let state = await reducer.apply(initialPagedState(), start);
    const root = await index.apply(
      initialActivityIndex(),
      start,
      state,
      reducer,
    );
    const delta = event(2, {
      kind: "message.text.append",
      payload: { messageId: "m", text: "suffix" },
    });
    state = await reducer.apply(state, delta);
    const noIO = new ActivityIndex({
      read: async () => {
        throw new Error("Unexpected index read");
      },
      put: async () => {
        throw new Error("Unexpected index write");
      },
    });
    const advanced = await noIO.apply(root, delta, state, reducer);
    expect(advanced).toEqual({ ...root, appliedSeq: 2 });
    expect(await keys(index, advanced)).toEqual(["messages/m"]);
  } finally {
    await store.close();
  }
});
