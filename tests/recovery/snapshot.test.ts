import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  createSnapshot,
  SnapshotReader,
  initialState,
  apply,
} from "../../packages/playback/src/index.js";
import type {
  RecordingState,
  SnapshotContent,
} from "../../packages/playback/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const binding = { streamId: "recording", revision: "revision" };
async function storage() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-snapshot-"));
  roots.push(root);
  return { root, store: await TextStore.open(root) };
}
it("restores nested maps, in-progress replacements and exact large text after reopen", async () => {
  const { root, store } = await storage();
  const state = initialState();
  state.appliedSeq = 8;
  state.timelineMs = 25;
  state.messages.set("message", {
    id: "message",
    role: "assistant",
    text: "x".repeat(65535) + "🦊\ud800",
    completed: false,
  });
  state.replacements.set("replacement", {
    target: "message",
    targetId: "message",
    chunks: ["a".repeat(40000), "b"],
    length: 40001,
  });
  state.artifacts.set("artifact", {
    filename: "result",
    pending: false,
    versions: new Map([
      [
        1,
        {
          artifactId: "artifact",
          version: 1,
          hash: "a".repeat(64),
          filename: "result",
          mediaType: "text/plain",
          byteSize: 3,
        },
      ],
    ]),
  });
  state.tasks.set("task", {
    taskId: "task",
    taskType: "process",
    status: "running",
    description: "description",
    agentId: undefined,
  });
  const ref = await createSnapshot(state, binding, store);
  await store.close();
  const reopened = await TextStore.open(root);
  try {
    const snapshot = await SnapshotReader.open(ref, binding, reopened);
    expect(snapshot.manifest.serverSeq).toBe(8);
    expect(await snapshot.materialize()).toStrictEqual(state);
    await expect(
      SnapshotReader.open(ref, { ...binding, revision: "other" }, reopened),
    ).rejects.toThrow("binding");
    await expect(snapshot.materialize(100)).rejects.toThrow("budget");
    const restored = (await snapshot.materialize()) as RecordingState;
    const event = {
      protocolVersion: 1 as const,
      serverSeq: 9,
      timelineMs: 26,
      receivedAt: "2026-09-09T00:00:00Z",
      origin: { type: "server" as const, operationId: "suffix" },
      content: {
        kind: "message.text.append" as const,
        payload: { messageId: "message", text: "suffix" },
      },
    };
    expect(apply(restored, event)).toEqual(apply(state, event));
  } finally {
    await reopened.close();
  }
});
it("reads a small ordered range from a multi-level map without hydrating unrelated text", async () => {
  const { store } = await storage();
  try {
    const state = initialState();
    for (let i = 0; i < 1100; i++)
      state.messages.set(`m${i}`, {
        id: `m${i}`,
        role: "assistant",
        text: "large ".repeat(5000),
        completed: true,
      });
    const ref = await createSnapshot(state, binding, store);
    let reads = 0,
      largest = 0;
    const counted: SnapshotContent = {
      put: (text, signal) => store.put(text, signal),
      read: (ref, offset, length, signal) => {
        reads++;
        largest = Math.max(largest, length);
        return store.read(ref, offset, length, signal);
      },
    };
    const snapshot = await SnapshotReader.open(ref, binding, counted);
    const root = await snapshot.entries(snapshot.manifest.state, 0, 32);
    const messages = root.find(([key]) => key === "messages")![1];
    reads = 0;
    const selected = await snapshot.entries(messages, 1023, 3);
    expect(selected.map(([key]) => key)).toEqual(["m1023", "m1024", "m1025"]);
    expect(reads).toBeLessThan(12);
    expect(largest).toBeLessThanOrEqual(32768);
    const message = await snapshot.entries(selected[0]![1], 0, 32);
    const text = message.find(([key]) => key === "text")![1];
    expect(typeof text).toBe("object");
    expect(await snapshot.text(text, 7, 11)).toBe(
      "large ".repeat(5000).slice(7, 18),
    );
  } finally {
    await store.close();
  }
}, 60000);
it("cancels snapshot creation without returning a publishable root", async () => {
  const { store } = await storage();
  try {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      createSnapshot(initialState(), binding, store, abort.signal),
    ).rejects.toThrow("cancelled");
  } finally {
    await store.close();
  }
});

it("rejects a mismatched state boundary and an unsupported snapshot version", async () => {
  const { store } = await storage();
  try {
    const ref = await createSnapshot(initialState(), binding, store);
    const manifest = JSON.parse(await store.read(ref, 0, ref.units));
    const wrong = await store.put(
      JSON.stringify({ ...manifest, serverSeq: 9 }),
    );
    await expect(SnapshotReader.open(wrong, binding, store)).rejects.toThrow(
      "boundary",
    );
    const tree = await store.put(
      JSON.stringify({
        kind: "branch",
        children: [
          { ref: manifest.state.ref, count: manifest.state.count - 1 },
        ],
      }),
    );
    const wrongTree = await store.put(
      JSON.stringify({ ...manifest, state: { ...manifest.state, ref: tree } }),
    );
    await expect(
      SnapshotReader.open(wrongTree, binding, store),
    ).rejects.toThrow("count mismatch");
    const future = await store.put(
      JSON.stringify({ ...manifest, reducerVersion: 2 }),
    );
    await expect(
      SnapshotReader.open(future, binding, store),
    ).rejects.toMatchObject({ code: "version_unsupported" });
  } finally {
    await store.close();
  }
});

it("does not return a root when cancelled after an accepted content write", async () => {
  const { store } = await storage();
  try {
    const abort = new AbortController();
    const content: SnapshotContent = {
      read: (ref, offset, length, signal) =>
        store.read(ref, offset, length, signal),
      put: async (text, signal) => {
        const ref = await store.put(text, signal);
        abort.abort(new Error("cancelled after write"));
        return ref;
      },
    };
    await expect(
      createSnapshot(initialState(), binding, content, abort.signal),
    ).rejects.toThrow("cancelled after write");
    expect(store.usage.storedBytes).toBeGreaterThan(0);
    const ref = await createSnapshot(initialState(), binding, store);
    expect(
      (await SnapshotReader.open(ref, binding, store)).manifest.serverSeq,
    ).toBe(0);
  } finally {
    await store.close();
  }
});

it("verifies empty container references during range reads and materialization", async () => {
  const { store } = await storage();
  try {
    const ref = await createSnapshot(initialState(), binding, store);
    const broken = await store.put(
      JSON.stringify({ kind: "leaf", entries: [["unexpected", null]] }),
    );
    let emptyHash: string | undefined;
    const content: SnapshotContent = {
      put: (text, signal) => store.put(text, signal),
      read: (reference, offset, length, signal) =>
        reference.hash === emptyHash
          ? Promise.reject(new Error("Missing empty container"))
          : store.read(reference, offset, length, signal),
    };
    const snapshot = await SnapshotReader.open(ref, binding, content);
    const root = await snapshot.entries(snapshot.manifest.state, 0, 32);
    const messages = root.find(([key]) => key === "messages")![1];
    if (!messages || typeof messages !== "object" || messages.kind !== "map")
      throw new Error("Expected messages map");
    await expect(
      snapshot.entries({ ...messages, ref: broken }, 0, 0),
    ).rejects.toThrow("leaf");
    emptyHash = messages.ref.hash;
    await expect(snapshot.entries(messages, 0, 0)).rejects.toThrow(
      "Missing empty container",
    );
    await expect(snapshot.materialize()).rejects.toThrow(
      "Missing empty container",
    );
  } finally {
    await store.close();
  }
});
