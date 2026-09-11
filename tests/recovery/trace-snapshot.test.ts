import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
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
