import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
import { MemoryContentStore } from "../../apps/web/src/memory-content.js";
import {
  PagedReducer,
  ActivityIndex,
  initialPagedState,
  initialActivityIndex,
  tracePairedSnapshot,
} from "../../packages/playback/src/index.js";
import type {
  SnapshotDescriptor,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
it("traces coherent paired snapshots and reopens solely from their marked codec blobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-paired-trace-"));
  const source = await TextStore.open(join(directory, "source"));
  const binding = { streamId: "stream", revision: "revision" };
  let target: TextStore | undefined;
  try {
    const reducer = new PagedReducer(source),
      activity = new ActivityIndex(source);
    let state = initialPagedState(),
      rows = initialActivityIndex();
    const oldRows = await activity.checkpoint(rows, binding);
    const events: StoredEvent[] = [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
      {
        kind: "message.text.append",
        payload: { messageId: "m", text: "preserved" },
      },
      {
        kind: "capture.gap",
        payload: { reason: "known gap", recoveredState: false },
      },
    ].map((content, index) => ({
      protocolVersion: 1,
      serverSeq: index + 1,
      timelineMs: index,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `event-${index}` },
      content,
    })) as StoredEvent[];
    for (const event of events) {
      state = await reducer.apply(state, event);
      rows = await activity.apply(rows, event, state, reducer);
    }
    const descriptor: SnapshotDescriptor = {
      format: "agentlive.paged-state",
      serverSeq: state.appliedSeq,
      timelineMs: state.timelineMs,
      ref: await reducer.checkpoint(state, binding),
      activity: await activity.checkpoint(rows, binding),
    };
    const blobs = new Map<string, Uint8Array>();
    await tracePairedSnapshot(source, descriptor, binding, async (ref) => {
      for (const blob of await source.trace(ref))
        blobs.set(blob.hash, await source.readBlob(blob));
    });
    target = await TextStore.open(
      join(directory, "target"),
      undefined,
      async (ref) => {
        const bytes = blobs.get(ref.hash);
        if (!bytes) throw new Error("Untraced blob requested");
        return bytes;
      },
    );
    const copyReducer = new PagedReducer(target),
      copyActivity = new ActivityIndex(target);
    expect(
      await copyReducer.materialize(
        await copyReducer.open(descriptor.ref, binding),
      ),
    ).toEqual(await reducer.materialize(state));
    expect(
      await copyActivity.entries(
        await copyActivity.open(descriptor.activity!, binding),
        0,
        32,
      ),
    ).toEqual(await activity.entries(rows, 0, 32));
    await target.close();
    target = await TextStore.open(join(directory, "target"));
    const offline = new PagedReducer(target);
    expect(
      (
        await offline.materialize(await offline.open(descriptor.ref, binding))
      ).messages.get("m")!.text,
    ).toBe("preserved");
    for (const invalid of [
      { ...descriptor, activity: oldRows },
      { ...descriptor, timelineMs: 999 },
      { ...descriptor, serverSeq: 999 },
    ]) {
      let called = false;
      await expect(
        tracePairedSnapshot(source, invalid, binding, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ code: "corrupt_storage" });
      expect(called).toBe(false);
    }
    const { activity: _, ...unpaired } = descriptor;
    await expect(
      tracePairedSnapshot(source, unpaired, binding, async () => {}),
    ).rejects.toMatchObject({ code: "invalid_request" });
  } finally {
    await target?.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("skips only reused subtrees and still reaches every newer dependency", async () => {
  const store = new MemoryContentStore(64 * 1024 * 1024, 262144);
  const binding = { streamId: "stream", revision: "revision" };
  try {
    const reducer = new PagedReducer(store),
      activity = new ActivityIndex(store);
    let state = initialPagedState(),
      rows = initialActivityIndex(),
      seq = 0;
    const attachment = {
      artifactId: "artifact",
      version: 1,
      filename: "result",
      hash: "a".repeat(64),
      byteSize: 7,
      mediaType: "text/plain",
    };
    const apply = async (contents: StoredEvent["content"][]) => {
      for (const content of contents) {
        const event = {
          protocolVersion: 1,
          serverSeq: ++seq,
          timelineMs: seq,
          receivedAt: "2026-09-10T00:00:00Z",
          origin: { type: "server", operationId: `reuse-${seq}` },
          content,
        } as StoredEvent;
        state = await reducer.apply(state, event);
        rows = await activity.apply(rows, event, state, reducer);
      }
      return {
        format: "agentlive.paged-state",
        serverSeq: state.appliedSeq,
        timelineMs: state.timelineMs,
        ref: await reducer.checkpoint(state, binding),
        activity: await activity.checkpoint(rows, binding),
      } satisfies SnapshotDescriptor;
    };
    const messages = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => [
        {
          kind: "message.started",
          payload: { messageId: `m-${from + index}`, role: "assistant" },
        },
        {
          kind: "message.text.append",
          payload: { messageId: `m-${from + index}`, text: `text ${index}` },
        },
      ]).flat() as StoredEvent["content"][];
    // Enough rows for multi-level indexes, plus nested versions, chunks and gaps.
    const first = await apply([
      ...messages(0, 90),
      {
        kind: "attachment.pending",
        payload: { artifactId: "artifact", filename: "result" },
      },
      { kind: "attachment.available", payload: { attachment } },
      {
        kind: "text.replacement.started",
        payload: { replacementId: "r", target: "message", targetId: "m-1" },
      },
      {
        kind: "text.replacement.chunk",
        payload: { replacementId: "r", index: 0, text: "chunk zero" },
      },
      {
        kind: "capture.gap",
        payload: { reason: "first gap", recoveredState: false },
      },
    ]);
    const second = await apply([
      ...messages(90, 130),
      {
        kind: "message.text.append",
        payload: { messageId: "m-3", text: " more" },
      },
      {
        kind: "attachment.available",
        payload: { attachment: { ...attachment, version: 2 } },
      },
      {
        kind: "text.replacement.chunk",
        payload: { replacementId: "r", index: 1, text: " chunk one" },
      },
      {
        kind: "capture.gap",
        payload: { reason: "second gap", recoveredState: true },
      },
    ]);
    const closure = async (
      descriptor: SnapshotDescriptor,
      reuse?: (ref: { hash: string }, scope: string) => boolean,
    ) => {
      const blobs = new Set<string>(),
        emitted = new Set<string>(),
        scopes = new Set<string>();
      await tracePairedSnapshot(
        store,
        descriptor,
        binding,
        async (ref) => {
          emitted.add(ref.hash);
          for (const blob of await store.trace(ref)) blobs.add(blob.hash);
        },
        undefined,
        reuse &&
          ((ref, scope) => {
            scopes.add(scope.replace(/\/(byKey|byOrder).*/, ""));
            return reuse(ref, scope);
          }),
      );
      return { blobs, emitted, scopes };
    };
    const old = await closure(first);
    const full = await closure(second);
    // Generational model: blobs retained with the earlier closure are skipped.
    const young = await closure(second, (ref) => old.blobs.has(ref.hash));
    for (const blob of full.blobs)
      expect(old.blobs.has(blob) || young.blobs.has(blob)).toBe(true);
    expect(young.emitted.size).toBeLessThan(full.emitted.size / 2);
    expect([...young.scopes].sort()).toEqual(
      expect.arrayContaining([
        "activity/root",
        "activity/seen",
        "activity/visible",
        "reducer/artifacts",
        "reducer/replacements",
        "reducer/messages",
        "reducer/gaps",
        "reducer/root",
      ]),
    );
    // Pass-local model: a second root skips subtrees walked for the first.
    const walked = new Set<string>();
    const pass = (ref: { hash: string }, scope: string) => {
      const key = `${scope}\n${ref.hash}`;
      if (walked.has(key)) return true;
      walked.add(key);
      return false;
    };
    const head = await closure(second, pass);
    expect(head.blobs).toEqual(full.blobs);
    const shared = await closure(first, pass);
    for (const blob of old.blobs)
      expect(full.blobs.has(blob) || shared.blobs.has(blob)).toBe(true);
    expect(shared.emitted.size).toBeLessThan(old.emitted.size);
    // Reuse never hides corruption in newly walked structure.
    await expect(
      tracePairedSnapshot(
        store,
        { ...second, serverSeq: 1 },
        binding,
        async () => {},
        undefined,
        () => true,
      ),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
  } finally {
    await store.close();
  }
});
