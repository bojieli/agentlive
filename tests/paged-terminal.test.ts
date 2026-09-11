import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../packages/storage/src/index.js";
import {
  PagedReducer,
  PagedTerminalRenderer,
  initialPagedState,
  initialState,
  apply,
  renderTerminalEvent,
} from "../packages/playback/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../packages/protocol/src/index.js";
it("streams long text with bounded reads and intact UTF-8 output, and stops reading after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-paged-terminal-"));
  const store = await TextStore.open(directory);
  try {
    const text =
      "x".repeat(4095) +
      "🦊\u001b[2J\r\u202e\n" +
      "y".repeat(70000) +
      "\nend\ud800";
    const contents: EventContent[] = [
      {
        kind: "message.started",
        payload: { messageId: "m", role: "assistant" },
      },
      { kind: "message.text.append", payload: { messageId: "m", text } },
      { kind: "message.completed", payload: { messageId: "m" } },
    ];
    let root = initialPagedState(),
      reference = initialState();
    const reducer = new PagedReducer(store);
    vi.spyOn(reducer, "materialize").mockRejectedValue(
      new Error("Must not materialize"),
    );
    const records = contents.map((content, index): StoredEvent => ({
      protocolVersion: 1,
      content,
      serverSeq: index + 1,
      timelineMs: index,
      receivedAt: "2026-09-10T00:00:00Z",
      origin: { type: "server", operationId: `op-${index}` },
    }));
    for (const event of records) {
      root = await reducer.apply(root, event);
      reference = apply(reference, event);
    }
    let reads = 0;
    const renderer = new PagedTerminalRenderer(
      reducer,
      {
        put: () => {
          throw new Error("Renderer must not write");
        },
        append: () => {
          throw new Error("Renderer must not append");
        },
        read: (ref, offset, length, signal) => {
          expect(length).toBeLessThanOrEqual(4096);
          reads++;
          return store.read(ref, offset, length, signal);
        },
      },
      "https://example.test",
      "stream",
    );
    const buffers: Buffer[] = [];
    for await (const chunk of renderer.event(
      records[2]!,
      root,
      AbortSignal.timeout(10000),
    )) {
      expect(chunk.length).toBeLessThanOrEqual(32768);
      buffers.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(buffers)).toEqual(
      Buffer.from(
        renderTerminalEvent(
          records[2]!,
          reference,
          "https://example.test",
          "stream",
        ),
      ),
    );
    expect(reads).toBeGreaterThan(10);
    const stop = new AbortController();
    const output = renderer.event(records[2]!, root, stop.signal);
    await output.next(); // heading
    await output.next(); // first page fetched, indentation emitted
    stop.abort(new Error("stop output"));
    // Already loaded text may be yielded; no further content read is permitted.
    const before = reads;
    await expect(
      (async () => {
        for await (const _chunk of output) {
        }
      })(),
    ).rejects.toThrow("stop output");
    expect(reads).toBe(before);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
