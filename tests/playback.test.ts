import { describe, expect, it } from "vitest";
import {
  apply,
  initialState,
  PlaybackClock,
} from "../packages/playback/src/index.js";
import {
  canonicalJson,
  publishedEventSchema,
  type EventContent,
  type StoredEvent,
} from "../packages/protocol/src/index.js";
function record(serverSeq: number, content: EventContent): StoredEvent {
  return {
    protocolVersion: 1,
    serverSeq,
    receivedAt: "2026-09-09T00:00:00Z",
    timelineMs: serverSeq * 100,
    content,
    origin: { type: "server", operationId: `test_${serverSeq}` },
  };
}
describe("playback reconstruction", () => {
  it("reconciles a final message without duplicating streamed text or mutating prior state", () => {
    const started = apply(
      initialState(),
      record(1, {
        kind: "message.started",
        payload: { messageId: "m1", role: "assistant" },
      }),
    );
    const partial = apply(
      started,
      record(2, {
        kind: "message.text.append",
        payload: { messageId: "m1", text: "hello " },
      }),
    );
    const final = apply(
      partial,
      record(3, {
        kind: "message.reconciled",
        payload: { messageId: "m1", text: "hello world" },
      }),
    );
    expect(started.messages.get("m1")?.text).toBe("");
    expect(partial.messages.get("m1")?.text).toBe("hello ");
    expect(final.messages.get("m1")?.text).toBe("hello world");
  });
  it("refuses missing events and missing message lifecycle", () => {
    expect(() =>
      apply(
        initialState(),
        record(2, { kind: "message.completed", payload: { messageId: "m" } }),
      ),
    ).toThrow("contiguous");
    expect(() =>
      apply(
        initialState(),
        record(1, { kind: "message.completed", payload: { messageId: "m" } }),
      ),
    ).toThrow("Missing");
  });
  it("preserves old artifact versions while new versions arrive", () => {
    const attachment = {
      artifactId: "a",
      version: 1,
      hash: "a".repeat(64),
      filename: "image.png",
      mediaType: "image/png",
      byteSize: 12,
    };
    const first = apply(
      initialState(),
      record(1, { kind: "attachment.available", payload: { attachment } }),
    );
    const next = apply(
      first,
      record(2, {
        kind: "attachment.available",
        payload: {
          attachment: { ...attachment, version: 2, hash: "b".repeat(64) },
        },
      }),
    );
    expect(first.artifacts.get("a")?.versions.size).toBe(1);
    expect(next.artifacts.get("a")?.versions.size).toBe(2);
  });
  it("uses Maps for external IDs, including prototype-like names", () => {
    const state = apply(
      initialState(),
      record(1, {
        kind: "message.started",
        payload: { messageId: "__proto__", role: "user" },
      }),
    );
    expect(state.messages.get("__proto__")?.text).toBe("");
  });
  it("preserves playback position while changing speed and pausing", () => {
    const clock = new PlaybackClock();
    clock.setMode("playing-history", 0, 10000);
    expect(clock.time(1000, 10000)).toBe(1000);
    clock.setSpeed(2, 1000, 10000);
    expect(clock.time(2000, 10000)).toBe(3000);
    clock.setMode("paused", 2000, 10000);
    expect(clock.time(5000, 10000)).toBe(3000);
    clock.setMode("following-live", 5000, 10000);
    expect(clock.time(6000, 20000)).toBe(20000);
  });
});
describe("protocol encoding", () => {
  it("uses stable key order and rejects lossy/cyclic JSON", () => {
    expect(canonicalJson({ b: 2, a: [1, "🌧️"] })).toBe(
      canonicalJson({ a: [1, "🌧️"], b: 2 }),
    );
    for (const value of [
      NaN,
      undefined,
      new Date(),
      { a: undefined },
      Array(2),
    ])
      expect(() => canonicalJson(value)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });
  it("rejects server lifecycle events submitted by publishers", () => {
    expect(
      publishedEventSchema.safeParse({
        protocolVersion: 1,
        streamId: "s",
        producerEpoch: "e",
        producerSeq: 1,
        observedAt: "2026-09-09T00:00:00Z",
        clockSegmentId: "c",
        elapsedMs: 0,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "n" },
        content: { kind: "recording.reopened", payload: {} },
      }).success,
    ).toBe(false);
  });
});
it("keeps prior text visible until a complete ordered replacement commits", () => {
  let state = apply(
    initialState(),
    record(1, {
      kind: "message.started",
      payload: { messageId: "m", role: "assistant" },
    }),
  );
  state = apply(
    state,
    record(2, {
      kind: "message.reconciled",
      payload: { messageId: "m", text: "old" },
    }),
  );
  state = apply(
    state,
    record(3, {
      kind: "text.replacement.started",
      payload: { replacementId: "r", target: "message", targetId: "m" },
    }),
  );
  state = apply(
    state,
    record(4, {
      kind: "text.replacement.chunk",
      payload: { replacementId: "r", index: 0, text: "new " },
    }),
  );
  expect(state.messages.get("m")!.text).toBe("old");
  expect(() =>
    apply(
      state,
      record(5, {
        kind: "text.replacement.completed",
        payload: { replacementId: "r", parts: 2 },
      }),
    ),
  ).toThrow("incomplete");
  expect(() =>
    apply(
      state,
      record(5, {
        kind: "text.replacement.chunk",
        payload: { replacementId: "r", index: 2, text: "bad" },
      }),
    ),
  ).toThrow("Invalid text replacement");
  state = apply(
    state,
    record(5, {
      kind: "text.replacement.chunk",
      payload: { replacementId: "r", index: 1, text: "text" },
    }),
  );
  state = apply(
    state,
    record(6, {
      kind: "text.replacement.completed",
      payload: { replacementId: "r", parts: 2 },
    }),
  );
  expect(state.messages.get("m")!.text).toBe("new text");
});
