import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryContentStore } from "../../apps/web/src/memory-content.js";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  PagedReducer,
  initialPagedState,
} from "../../packages/playback/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const active = () => AbortSignal.timeout(10000);

it("shares filesystem codec identity, Unicode ranges and immutable snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-memory-content-"));
  const disk = await TextStore.open(directory);
  const memory = new MemoryContentStore();
  try {
    const prefix = "x".repeat(16383) + "🦊\ud800";
    const ref = await memory.put(prefix);
    expect(ref).toEqual(await disk.put(prefix));
    const next = await memory.append(ref, "tail".repeat(5000));
    expect(next).toEqual(await disk.put(prefix + "tail".repeat(5000)));
    expect(await memory.read(next, 16382, 8)).toBe(
      (prefix + "tail".repeat(5000)).slice(16382, 16390),
    );
    expect(await memory.read(ref, 16382, 4)).toBe(prefix.slice(16382));
    expect(await memory.trace(next)).toEqual(await disk.trace(next));
    const bytes = await memory.readBlob(ref);
    bytes.fill(0);
    expect(await memory.read(ref, 0, 1)).toBe("x");
    const before = memory.usage;
    await memory.put(prefix);
    expect(memory.usage).toEqual(before);
  } finally {
    await memory.close();
    await disk.close();
    await rm(directory, { recursive: true, force: true });
  }
  expect(memory.usage).toEqual({ bytes: 0, entries: 0 });
});

it("rolls back partial codec writes on byte quota, entry quota and source failure", async () => {
  const memory = new MemoryContentStore(40000);
  const tiny = new MemoryContentStore(40000, 1);
  try {
    const kept = await memory.put("keep");
    const before = memory.usage;
    await expect(
      memory.put("a".repeat(16384) + "b".repeat(16384) + "c".repeat(16384)),
    ).rejects.toMatchObject({ code: "retry_later" });
    expect(memory.usage).toEqual(before);
    await expect(
      memory.append(
        kept,
        (async function* () {
          yield "z".repeat(16384);
          throw new Error("source failed");
        })(),
      ),
    ).rejects.toThrow("source failed");
    expect(memory.usage).toEqual(before);
    expect(await memory.read(kept, 0, 4)).toBe("keep");
    await expect(tiny.put("text")).rejects.toMatchObject({
      code: "retry_later",
    });
    expect(tiny.usage).toEqual({ bytes: 0, entries: 0 });
  } finally {
    await memory.close();
    await tiny.close();
  }
});

it("bounds admissions and cancels a stuck source while clearing all retained bytes", async () => {
  const memory = new MemoryContentStore();
  await memory.put("retained");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = memory.put(
    (async function* () {
      yield "staged".repeat(3000);
      entered();
      await gate;
      yield "late";
    })(),
  );
  const queued = Array.from({ length: 15 }, () => memory.put("queued"));
  const settled = Promise.allSettled([first, ...queued]);
  await expect(memory.put("overflow")).rejects.toMatchObject({
    code: "retry_later",
  });
  await started;
  await memory.close();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
  release();
  await expect(memory.put("closed")).rejects.toThrow("closing");
  expect(memory.usage).toEqual({ bytes: 0, entries: 0 });
});

it("imports verified paged checkpoints, extends them and rejects corrupt lazy blobs atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-memory-reducer-"));
  const disk = await TextStore.open(directory);
  const memory = new MemoryContentStore(undefined, undefined, (ref, signal) =>
    disk.readBlob(ref, signal),
  );
  const bad = new MemoryContentStore(
    undefined,
    undefined,
    async (ref, signal) => {
      const bytes = new Uint8Array(await disk.readBlob(ref, signal));
      bytes[0] ^= 1;
      return bytes;
    },
  );
  try {
    const binding = { streamId: "stream", revision: "revision" };
    const event = (serverSeq: number, content: EventContent): StoredEvent => ({
      protocolVersion: 1,
      serverSeq,
      timelineMs: serverSeq * 10,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `event-${serverSeq}` },
      content,
    });
    const reducer = new PagedReducer(disk);
    const root = await reducer.applyBatch(initialPagedState(), [
      event(1, {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      }),
      event(2, {
        kind: "message.text.append",
        payload: { messageId: "m", text: "prefix" },
      }),
    ]);
    const checkpoint = await reducer.checkpoint(root, binding);
    const local = new PagedReducer(memory);
    const opened = await local.open(checkpoint, binding, active());
    const suffix = event(3, {
      kind: "message.text.append",
      payload: { messageId: "m", text: " suffix" },
    });
    const extended = await local.apply(opened, suffix);
    expect(await local.checkpoint(extended, binding)).toEqual(
      await reducer.checkpoint(await reducer.apply(root, suffix), binding),
    );
    const message = await local.get(extended, "messages", "m", active());
    expect(await memory.read(message!.text, 0, message!.text.units)).toBe(
      "prefix suffix",
    );
    const old = await local.get(opened, "messages", "m", active());
    expect(await memory.read(old!.text, 0, old!.text.units)).toBe("prefix");
    await expect(
      new PagedReducer(bad).open(checkpoint, binding, active()),
    ).rejects.toMatchObject({ code: "corrupt_storage" });
    expect(bad.usage).toEqual({ bytes: 0, entries: 0 });
  } finally {
    await memory.close();
    await bad.close();
    await disk.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("discards partial imports and ignores a loader result returned after cancellation", async () => {
  const source = new MemoryContentStore();
  const ref = await source.put("page".repeat(5000));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = new MemoryContentStore(
    undefined,
    undefined,
    async (input) => {
      entered();
      await gate;
      return source.readBlob(input);
    },
  );
  let reads = 0;
  const corrupt = new MemoryContentStore(
    undefined,
    undefined,
    async (input) => {
      const bytes = await source.readBlob(input);
      if (++reads === 2) bytes[0] ^= 1;
      return bytes;
    },
  );
  try {
    await expect(corrupt.read(ref, 0, 10)).rejects.toMatchObject({
      code: "corrupt_storage",
    });
    expect(reads).toBe(2);
    expect(corrupt.usage).toEqual({ bytes: 0, entries: 0 });
    const stop = new AbortController();
    const pending = delayed.read(ref, 0, 10, stop.signal);
    const rejected = expect(pending).rejects.toThrow("cancel import");
    await started;
    stop.abort(new Error("cancel import"));
    await rejected;
    release();
    expect(await delayed.read(ref, 0, 10)).toBe("pagepagepa");
    await delayed.close();
    expect(delayed.usage).toEqual({ bytes: 0, entries: 0 });
  } finally {
    release();
    await delayed.close();
    await corrupt.close();
    await source.close();
  }
});

it("stores arbitrary imported bytes exactly in compact form", async () => {
  const cases = [
    Uint8Array.from({ length: 256 }, (_, index) => index),
    new TextEncoder().encode("plain ascii blob"),
    new TextEncoder().encode('"🦊 é \ud800"'),
    Uint8Array.from({ length: 20000 }, (_, index) => (index * 131) & 255),
  ];
  const refs = await Promise.all(
    cases.map(async (bytes) => ({
      hash: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
      byteSize: bytes.length,
      units: 0,
    })),
  );
  let loads = 0;
  const memory = new MemoryContentStore(undefined, undefined, async (ref) => {
    loads++;
    return cases[refs.findIndex((item) => item.hash === ref.hash)]!;
  });
  try {
    for (const [index, ref] of refs.entries()) {
      expect(await memory.readBlob(ref, active())).toEqual(cases[index]);
      const stored = await memory.readBlob(ref, active());
      expect(stored).toEqual(cases[index]);
      stored.fill(7);
      expect(await memory.readBlob(ref, active())).toEqual(cases[index]);
    }
    expect(loads).toBe(cases.length);
    expect(memory.usage).toEqual({
      bytes: cases.reduce((sum, bytes) => sum + bytes.length, 0),
      entries: cases.length,
    });
  } finally {
    await memory.close();
  }
});
