import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  PagedReducer,
  PagedTerminalRenderer,
  renderTerminalEvent,
  renderTerminalSnapshot,
  OrderedContentMap,
  initialPagedState,
  initialState,
  apply,
  type PagedContent,
} from "../../packages/playback/src/index.js";
import {
  contentSchema,
  type EventContent,
  type StoredEvent,
} from "../../packages/protocol/src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-paged-reducer-"));
  roots.push(root);
  return { root, store: await TextStore.open(root) };
}
const event = (seq: number, content: EventContent): StoredEvent => ({
  protocolVersion: 1,
  serverSeq: seq,
  timelineMs: seq * 10,
  receivedAt: "2026-09-09T00:00:00Z",
  origin: { type: "server", operationId: `event-${seq}` },
  content,
});
const binding = { streamId: "stream", revision: "revision" };
it("matches reference replay for every event kind, pending replacements, and checkpoint continuation", async () => {
  const { root, store } = await setup();
  let current = store;
  try {
    let reducer = new PagedReducer(store),
      state = initialPagedState(),
      reference = initialState();
    const verifyTrace = async () => {
      const checkpoint = await reducer.checkpoint(state, binding);
      const retained = new Set<string>();
      await reducer.trace(checkpoint, binding, async (reference) => {
        // Every emitted reference must actually be a valid codec manifest.
        await current.trace(reference);
        retained.add(reference.hash);
        reference.hash = "0".repeat(64);
      });
      const isolated = new PagedReducer({
        put: async () => {
          throw new Error("No writes during trace recovery");
        },
        append: async () => {
          throw new Error("No appends during trace recovery");
        },
        read: (ref, offset, length, signal) => {
          if (!retained.has(ref.hash))
            throw new Error("Missing traced content");
          return current.read(ref, offset, length, signal);
        },
      });
      expect(
        await isolated.materialize(await isolated.open(checkpoint, binding)),
      ).toStrictEqual(reference);
      expect(retained.has("a".repeat(64))).toBe(false);
    };
    const attachment = {
      artifactId: "artifact",
      version: 1,
      filename: "result",
      hash: "a".repeat(64),
      byteSize: 7,
      mediaType: "text/plain",
    };
    const contents: EventContent[] = [
      { kind: "recording.created", payload: { title: "recording" } },
      {
        kind: "session.started",
        payload: {
          agent: "synthetic",
          nativeSessionId: "native",
          title: "session",
        },
      },
      {
        kind: "agent.updated",
        payload: {
          agentId: "agent",
          nativeSessionId: "native",
          status: "active",
        },
      },
      { kind: "turn.started", payload: { turnId: "turn" } },
      {
        kind: "message.started",
        payload: { messageId: "message", role: "assistant", agentId: "agent" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "message", text: "x".repeat(16383) + "🦊\ud800" },
      },
      {
        kind: "message.reconciled",
        payload: { messageId: "message", text: "reconciled" },
      },
      { kind: "message.completed", payload: { messageId: "message" } },
      { kind: "message.reopened", payload: { messageId: "message" } },
      {
        kind: "object.visibility",
        payload: { objectType: "message", objectId: "message", visible: false },
      },
      {
        kind: "tool.started",
        payload: {
          toolId: "tool",
          name: "shell",
          input: "initial",
          agentId: "agent",
        },
      },
      {
        kind: "tool.arguments.append",
        payload: { toolId: "tool", text: " appended" },
      },
      {
        kind: "tool.arguments.ready",
        payload: { toolId: "tool", input: "ready" },
      },
      {
        kind: "tool.output.append",
        payload: { toolId: "tool", text: "output" },
      },
      {
        kind: "tool.completed",
        payload: {
          toolId: "tool",
          status: "interrupted",
          output: "interrupted output",
        },
      },
      { kind: "tool.reopened", payload: { toolId: "tool" } },
      {
        kind: "object.visibility",
        payload: { objectType: "tool", objectId: "tool", visible: false },
      },
      {
        kind: "file.change.proposed",
        payload: { changeId: "change", path: "file", patch: "proposed" },
      },
      {
        kind: "file.change.applied",
        payload: { changeId: "change", path: "file", patch: "applied" },
      },
      {
        kind: "attachment.pending",
        payload: { artifactId: "artifact", filename: "result" },
      },
      { kind: "attachment.available", payload: { attachment } },
      {
        kind: "object.visibility",
        payload: {
          objectType: "attachment",
          objectId: "artifact",
          visible: false,
        },
      },
      {
        kind: "attachment.unavailable",
        payload: { artifactId: "artifact", reason: "old version unavailable" },
      },
      {
        kind: "attachment.available",
        payload: { attachment: { ...attachment, version: 2 } },
      },
      {
        kind: "reference.resolved",
        payload: {
          messageId: "message",
          sourceReference: "source".repeat(1500),
          artifactId: "artifact",
          version: 1,
        },
      },
      {
        kind: "task.updated",
        payload: {
          taskId: "task",
          taskType: "agent",
          status: "running",
          description: "work",
        },
      },
      {
        kind: "monitor.updated",
        payload: {
          monitorId: "monitor",
          monitorType: "artifact-comments",
          sourceReference: "artifact",
          title: "monitor",
          status: "armed",
        },
      },
      {
        kind: "goal.updated",
        payload: { goalId: "goal", objective: "finish", status: "active" },
      },
      {
        kind: "interaction.updated",
        payload: {
          interactionId: "approval",
          interactionType: "approval",
          status: "pending",
          title: "approve",
          prompt: "continue?",
        },
      },
      {
        kind: "plan.updated",
        payload: {
          planId: "plan",
          status: "active",
          attachment: { artifactId: "artifact", version: 2 },
        },
      },
      {
        kind: "capture.gap",
        payload: { reason: "synthetic gap", recoveredState: true },
      },
      {
        kind: "capture.completeness",
        payload: {
          version: 1,
          reason: "frozen-native-source",
          unfinishedMessages: 1,
          unfinishedTools: 1,
          withheldTextMessages: 1,
        },
      },
      {
        kind: "capture.clock",
        payload: {
          segmentId: "clock",
          wallAnchor: "2026-09-09T00:00:00Z",
          confidence: "monotonic",
        },
      },
      {
        kind: "publisher.epoch.changed",
        payload: { producerEpoch: "epoch", reason: "handoff" },
      },
      { kind: "turn.ended", payload: { turnId: "turn", status: "completed" } },
      { kind: "session.ended", payload: { reason: "done" } },
      {
        kind: "recording.ended",
        payload: { producerEpoch: "epoch", throughProducerSeq: 35 },
      },
      { kind: "recording.reopened", payload: {} },
    ];
    for (const target of [
      "message",
      "tool.input",
      "tool.output",
      "change.patch",
    ] as const)
      contents.push(
        {
          kind: "text.replacement.started",
          payload: {
            replacementId: "replace",
            target,
            targetId:
              target === "message"
                ? "message"
                : target === "change.patch"
                  ? "change"
                  : "tool",
          },
        },
        {
          kind: "text.replacement.chunk",
          payload: { replacementId: "replace", index: 0, text: "new\ud83e" },
        },
        {
          kind: "text.replacement.chunk",
          payload: { replacementId: "replace", index: 1, text: "\udd8a text" },
        },
        {
          kind: "text.replacement.completed",
          payload: { replacementId: "replace", parts: 2 },
        },
      );
    expect(new Set(contents.map((content) => content.kind))).toEqual(
      new Set(contentSchema.options.map((schema) => schema.shape.kind.value)),
    );
    for (const content of contents) {
      const record = event(reference.appliedSeq + 1, content);
      const previous = reference,
        prior = state;
      reference = apply(reference, record);
      state = await reducer.apply(state, record);
      if (
        content.kind === "text.replacement.chunk" &&
        content.payload.index === 0
      ) {
        const checkpoint = await reducer.checkpoint(state, binding);
        await current.close();
        current = await TextStore.open(root);
        reducer = new PagedReducer(current);
        state = await reducer.open(checkpoint, binding);
        await verifyTrace();
        await expect(
          reducer.open(checkpoint, { ...binding, revision: "other" }),
        ).rejects.toMatchObject({ code: "revision_changed" });
      }
      expect(await reducer.materialize(state), content.kind).toStrictEqual(
        reference,
      );
      const renderer = new PagedTerminalRenderer(
        reducer,
        current,
        "https://example.test",
        "stream",
      );
      const collect = async (chunks: AsyncIterable<string>) => {
        let output = "";
        for await (const chunk of chunks) output += chunk;
        return output;
      };
      expect(
        await collect(
          renderer.event(record, state, AbortSignal.timeout(10000), prior),
        ),
        content.kind,
      ).toBe(
        renderTerminalEvent(
          record,
          reference,
          "https://example.test",
          "stream",
          previous,
        ),
      );
      expect(
        await collect(
          renderer.snapshot(
            state,
            AbortSignal.timeout(10000),
            state.timelineMs + 5,
          ),
        ),
        content.kind,
      ).toBe(
        [
          ...renderTerminalSnapshot(
            reference,
            "https://example.test",
            "stream",
            state.timelineMs + 5,
          ),
        ].join(""),
      );
    }
    const batched = await reducer.applyBatch(
      initialPagedState(),
      contents.map((content, index) => event(index + 1, content)),
    );
    expect(await reducer.checkpoint(batched, binding)).toEqual(
      await reducer.checkpoint(state, binding),
    );
    await verifyTrace();
    await expect(reducer.materialize(state, 10)).rejects.toThrow("budget");
  } finally {
    await current.close();
  }
}, 120000);
it("does not load retained text for a new append and preserves the previous state on cancellation", async () => {
  const { store } = await setup();
  try {
    const reducer = new PagedReducer(store);
    let state = initialPagedState();
    state = await reducer.apply(
      state,
      event(1, {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      }),
    );
    state = await reducer.apply(
      state,
      event(2, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "a".repeat(60000) },
      }),
    );
    const before = state,
      message = await reducer.get(state, "messages", "m");
    let reads = 0;
    const watched: PagedContent = {
      put: (text, signal) => store.put(text, signal),
      append: (ref, text, signal) => store.append(ref, text, signal),
      read: (ref, offset, length, signal) => {
        expect(ref.hash).not.toBe(message!.text.hash);
        reads++;
        return store.read(ref, offset, length, signal);
      },
    };
    const next = await new PagedReducer(watched).apply(
      state,
      event(3, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "suffix" },
      }),
    );
    expect(reads).toBeLessThan(20);
    expect((await reducer.get(next, "messages", "m"))!.text.units).toBe(60006);
    expect((await reducer.get(before, "messages", "m"))!.text.units).toBe(
      60000,
    );
    const abort = new AbortController();
    const interrupted = new PagedReducer({
      ...watched,
      put: async (text, signal) => {
        const result = await store.put(text, signal);
        abort.abort(new Error("cancelled reduction"));
        return result;
      },
    });
    await expect(
      interrupted.apply(
        before,
        event(3, { kind: "message.completed", payload: { messageId: "m" } }),
        abort.signal,
      ),
    ).rejects.toThrow("cancelled reduction");
    expect((await reducer.get(before, "messages", "m"))!.completed).toBe(false);
    const retry = await reducer.apply(
      before,
      event(3, { kind: "message.completed", payload: { messageId: "m" } }),
    );
    expect((await reducer.get(retry, "messages", "m"))!.completed).toBe(true);
  } finally {
    await store.close();
  }
});

it("rejects invalid lifecycle transitions without changing the prior root", async () => {
  const { store } = await setup();
  try {
    const reducer = new PagedReducer(store);
    let state = initialPagedState();
    await expect(
      reducer.apply(
        state,
        event(2, {
          kind: "message.completed",
          payload: { messageId: "missing" },
        }),
      ),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    await expect(
      reducer.apply(
        state,
        event(1, {
          kind: "message.completed",
          payload: { messageId: "missing" },
        }),
      ),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    state = await reducer.apply(
      state,
      event(1, {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      }),
    );
    state = await reducer.apply(
      state,
      event(2, { kind: "message.completed", payload: { messageId: "m" } }),
    );
    await expect(
      reducer.apply(
        state,
        event(3, {
          kind: "message.text.append",
          payload: { messageId: "m", text: "late" },
        }),
      ),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await expect(
      reducer.apply(
        state,
        event(3, {
          kind: "reference.resolved",
          payload: {
            messageId: "m",
            sourceReference: "missing",
            artifactId: "missing",
            version: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    expect((await reducer.materialize(state)).messages.get("m")).toMatchObject({
      text: "",
      completed: true,
    });
  } finally {
    await store.close();
  }
});

it("rejects an artifact descriptor stored under a different identity or version", async () => {
  const { store } = await setup();
  try {
    const reducer = new PagedReducer(store),
      map = new OrderedContentMap(store);
    const descriptor = {
      artifactId: "artifact",
      version: 1,
      filename: "result",
      hash: "a".repeat(64),
      byteSize: 7,
      mediaType: "text/plain",
    };
    const state = await reducer.apply(
      initialPagedState(),
      event(1, {
        kind: "attachment.available",
        payload: { attachment: descriptor },
      }),
    );
    const artifact = await reducer.get(state, "artifacts", "artifact");
    for (const mismatch of [{ artifactId: "other" }, { version: 2 }]) {
      const versions = await map.set(
        artifact!.versions,
        1,
        await store.put(JSON.stringify({ ...descriptor, ...mismatch })),
      );
      const artifacts = await map.set(
        state.maps.artifacts,
        "artifact",
        await store.put(JSON.stringify({ ...artifact, versions })),
      );
      const corrupted = { ...state, maps: { ...state.maps, artifacts } };
      await expect(
        reducer.trace(
          await reducer.checkpoint(corrupted, binding),
          binding,
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
      await expect(reducer.materialize(corrupted)).rejects.toMatchObject({
        code: "corrupt_storage",
      });
      await expect(
        reducer.artifactVersion(corrupted, "artifact", 1),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
      await expect(
        reducer.artifactVersions(corrupted, "artifact", 0, 32),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
    }
    expect(
      (await reducer.materialize(state)).artifacts
        .get("artifact")!
        .versions.get(1),
    ).toEqual(descriptor);
  } finally {
    await store.close();
  }
});

it("does not interpret user JSON as content links and fails incomplete or cancelled traces", async () => {
  const { store } = await setup();
  try {
    const reducer = new PagedReducer(store);
    const fake = { hash: "f".repeat(64), byteSize: 100, units: 20 };
    const state = await reducer.applyBatch(initialPagedState(), [
      event(1, {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      }),
      event(2, {
        kind: "message.text.append",
        payload: { messageId: "m", text: JSON.stringify(fake) },
      }),
    ]);
    const checkpoint = await reducer.checkpoint(state, binding);
    const refs = new Set<string>();
    await reducer.trace(checkpoint, binding, async (ref) => {
      refs.add(ref.hash);
      await store.trace(ref);
    });
    expect(refs.has(fake.hash)).toBe(false);
    let calls = 0;
    await expect(
      reducer.trace(checkpoint, { ...binding, revision: "other" }, async () => {
        calls++;
      }),
    ).rejects.toMatchObject({ code: "revision_changed" });
    expect(calls).toBe(0);
    const abort = new AbortController();
    await expect(
      reducer.trace(
        checkpoint,
        binding,
        async () => {
          calls++;
          abort.abort(new Error("trace cancelled"));
        },
        abort.signal,
      ),
    ).rejects.toThrow("trace cancelled");
    expect(calls).toBe(1);
    await expect(
      reducer.trace(checkpoint, binding, async () => {
        throw new Error("mark failed");
      }),
    ).rejects.toThrow("mark failed");
  } finally {
    await store.close();
  }
});
