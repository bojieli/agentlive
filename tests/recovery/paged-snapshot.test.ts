import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingSnapshots } from "../../packages/server/src/snapshots.js";
import { TextStore, atomicJson } from "../../packages/storage/src/index.js";
import {
  createSnapshot,
  initialState,
  apply,
  openRecordingSnapshot,
  PagedSnapshotReader,
} from "../../packages/playback/src/index.js";
import type { StoredEvent } from "../../packages/protocol/src/index.js";
const binding = { streamId: "stream", revision: "revision" };
const events: StoredEvent[] = [
  {
    kind: "message.started",
    payload: { messageId: "message", role: "assistant" },
  },
  {
    kind: "message.text.append",
    payload: { messageId: "message", text: "prefix" },
  },
  {
    kind: "message.text.append",
    payload: { messageId: "message", text: "suffix" },
  },
].map((content, index) => ({
  protocolVersion: 1,
  serverSeq: index + 1,
  timelineMs: index * 10,
  receivedAt: "2026-09-09T00:00:00Z",
  origin: { type: "server", operationId: `op-${index}` },
  content,
})) as StoredEvent[];

it("resumes paged snapshot generation from only the published suffix after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-paged-snapshot-"));
  let snapshots = new RecordingSnapshots(directory, binding);
  try {
    const first = await snapshots.build(2, async function* (after) {
      expect(after).toBe(0);
      yield* events.slice(0, 2);
    });
    expect(first.format).toBe("agentlive.paged-state");
    await snapshots.close();
    snapshots = new RecordingSnapshots(directory, binding);
    const next = await snapshots.build(3, async function* (after) {
      expect(after).toBe(2);
      yield events[2]!;
    });
    const content = {
      put: async () => {
        throw new Error("read-only");
      },
      read: (ref: any, offset: number, length: number, signal?: AbortSignal) =>
        snapshots.read(ref, offset, length, signal),
    };
    const reader = await openRecordingSnapshot(next, binding, content);
    expect(reader).toBeInstanceOf(PagedSnapshotReader);
    expect(await reader.materialize()).toStrictEqual(
      events.reduce(apply, initialState()),
    );
    expect(await snapshots.select(2)).toEqual(first);
    await expect(
      snapshots.build(4, async function* () {}),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    expect(await snapshots.select(4)).toEqual(next);
    if (!(reader instanceof PagedSnapshotReader))
      throw new Error("Expected paged reader");
    const mutated = reader.state;
    mutated.maps.messages = null;
    expect((await reader.get("messages", "message"))!.text.units).toBe(12);
    await expect(
      openRecordingSnapshot(
        { ...next, timelineMs: next.timelineMs + 1 },
        binding,
        content,
      ),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    await expect(
      openRecordingSnapshot({ ...next, format: undefined }, binding, content),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
  } finally {
    await snapshots.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps legacy catalogs readable and publishes later checkpoints in paged format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-legacy-snapshot-"));
  const store = await TextStore.open(directory);
  const state = events.slice(0, 2).reduce(apply, initialState());
  const ref = await createSnapshot(state, binding, store);
  await store.close();
  const legacy = { serverSeq: 2, timelineMs: 10, ref };
  await atomicJson(join(directory, "catalog.json"), {
    version: 1,
    ...binding,
    entries: [legacy],
  });
  const snapshots = new RecordingSnapshots(directory, binding);
  try {
    expect(await snapshots.select(2)).toEqual(legacy);
    const content = {
      put: async () => {
        throw new Error("read-only");
      },
      read: (ref: any, offset: number, length: number, signal?: AbortSignal) =>
        snapshots.read(ref, offset, length, signal),
    };
    expect(
      await (
        await openRecordingSnapshot(legacy, binding, content)
      ).materialize(),
    ).toStrictEqual(state);
    const next = await snapshots.build(3, async function* (after) {
      expect(after).toBe(0);
      yield* events;
    });
    expect(next.format).toBe("agentlive.paged-state");
    expect(
      await (await openRecordingSnapshot(next, binding, content)).materialize(),
    ).toStrictEqual(events.reduce(apply, initialState()));
    await expect(
      openRecordingSnapshot(
        { ...legacy, format: "agentlive.paged-state" },
        binding,
        content,
      ),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
  } finally {
    await snapshots.close();
    await rm(directory, { recursive: true, force: true });
  }
});
