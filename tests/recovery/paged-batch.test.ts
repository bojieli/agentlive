import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
import {
  PagedReducer,
  ActivityIndex,
  initialPagedState,
  initialActivityIndex,
} from "../../packages/playback/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const event = (content: EventContent, index: number): StoredEvent => ({
  protocolVersion: 1,
  content,
  serverSeq: index + 1,
  timelineMs: index,
  receivedAt: "2026-09-10T00:00:00Z",
  origin: { type: "server", operationId: `op-${index}` },
});
const binding = { streamId: "batch", revision: "revision" };
it("preserves exact state/activity checkpoint identity while avoiding intermediate append roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-batch-"));
  const single = await TextStore.open(join(directory, "single"));
  const batched = await TextStore.open(join(directory, "batch"));
  try {
    const contents: EventContent[] = [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
      ...Array.from({ length: 31 }, (_, i): EventContent => ({
        kind: "message.text.append",
        payload: {
          messageId: "m",
          text:
            i === 4
              ? "\ud83e"
              : i === 5
                ? "\udd8a"
                : i === 7
                  ? ""
                  : "chunk\n".repeat(8),
        },
      })),
      { kind: "message.completed", payload: { messageId: "m" } },
      {
        kind: "tool.started",
        payload: { toolId: "tool", name: "Synthetic", input: "" },
      },
      ...Array.from({ length: 8 }, (): EventContent => ({
        kind: "tool.arguments.append",
        payload: { toolId: "tool", text: "arg" },
      })),
      ...Array.from({ length: 8 }, (): EventContent => ({
        kind: "tool.output.append",
        payload: { toolId: "tool", text: "out" },
      })),
      {
        kind: "tool.completed",
        payload: { toolId: "tool", status: "completed" },
      },
    ];
    const events = contents.map(event);
    const slow = new PagedReducer(single),
      fast = new PagedReducer(batched);
    const oldIndex = new ActivityIndex(single),
      newIndex = new ActivityIndex(batched);
    let expected = initialPagedState(),
      expectedRows = initialActivityIndex();
    let middle;
    for (const stored of events) {
      expected = await slow.apply(expected, stored);
      expectedRows = await oldIndex.apply(expectedRows, stored, expected, slow);
      if (stored.serverSeq === 13)
        middle = await slow.checkpoint(expected, binding);
    }
    let rows = initialActivityIndex();
    const grouped: number[] = [];
    const observer = async (
      state: typeof expected,
      group: readonly StoredEvent[],
    ) => {
      grouped.push(group.length);
      rows =
        group.length > 1
          ? newIndex.advanceAppends(rows, group, state)
          : await newIndex.apply(rows, group[0]!, state, fast);
    };
    const prefix = await fast.applyBatch(
      initialPagedState(),
      events.slice(0, 13),
      undefined,
      observer,
    );
    expect(await fast.checkpoint(prefix, binding)).toEqual(middle);
    const actual = await fast.applyBatch(
      prefix,
      events.slice(13),
      undefined,
      observer,
    );
    expect(await fast.checkpoint(actual, binding)).toEqual(
      await slow.checkpoint(expected, binding),
    );
    expect(await newIndex.checkpoint(rows, binding)).toEqual(
      await oldIndex.checkpoint(expectedRows, binding),
    );
    expect(await fast.materialize(actual)).toEqual(
      await slow.materialize(expected),
    );
    expect(grouped.some((size) => size > 10)).toBe(true);
    expect(batched.usage.storedBytes).toBeLessThan(
      single.usage.storedBytes / 3,
    );
    await expect(
      fast.applyBatch(actual, [
        event(
          {
            kind: "message.text.append",
            payload: { messageId: "m", text: "invalid" },
          },
          actual.appliedSeq,
        ),
      ]),
    ).rejects.toMatchObject({ code: "event_conflict" });
  } finally {
    await single.close();
    await batched.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
it("validates the entire batch before writing, bounds admission and cancels between completed groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-batch-reject-"));
  const store = await TextStore.open(directory);
  const reducer = new PagedReducer(store);
  try {
    const events = [
      event(
        {
          kind: "message.started",
          payload: { messageId: "m", role: "assistant" },
        },
        0,
      ),
      event(
        {
          kind: "message.text.append",
          payload: { messageId: "m", text: "text" },
        },
        1,
      ),
    ];
    await expect(
      reducer.applyBatch(initialPagedState(), [
        events[0]!,
        { ...events[1]!, serverSeq: 3 },
      ]),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    await expect(
      reducer.applyBatch(initialPagedState(), [
        { ...events[0]!, timelineMs: 2 },
        events[1]!,
      ]),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await expect(
      reducer.applyBatch(initialPagedState(), Array(257).fill(events[0])),
    ).rejects.toThrow("event limit");
    await expect(
      reducer.applyBatch(initialPagedState(), [
        event(
          {
            kind: "message.reconciled",
            payload: { messageId: "m", text: "x".repeat(1048576) },
          },
          0,
        ),
      ]),
    ).rejects.toThrow("byte limit");
    expect(store.usage.storedBytes).toBe(0);
    const stop = new AbortController(),
      initial = initialPagedState();
    await expect(
      reducer.applyBatch(initial, events, stop.signal, async () => {
        stop.abort(new Error("replace batch"));
      }),
    ).rejects.toThrow("replace batch");
    expect(initial).toEqual(initialPagedState());
    expect((await reducer.applyBatch(initial, events)).appliedSeq).toBe(2);
    expect(() =>
      new ActivityIndex(store).advanceAppends(
        initialActivityIndex(),
        [events[0]!],
        initial,
      ),
    ).toThrow("only contain text appends");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
