import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { activityRange } from "../../apps/web/src/activity-range.js";
import { ActivityCard, activityRows } from "../../apps/web/src/activity.js";
import { ActivityFeed } from "../../apps/web/src/activity-feed.js";
import { apply, initialState } from "../../packages/playback/src/index.js";
import type {
  EventContent,
  StoredEvent,
} from "../../packages/protocol/src/index.js";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
it("bounds a large viewport range and retains only one offscreen focus target", () => {
  const range = {
    count: 100_000,
    startIndex: 50_000,
    endIndex: 50_010,
    overscan: 4,
  };
  const indices = activityRange(range, 2);
  expect(indices).toHaveLength(20);
  expect(indices[0]).toBe(2);
  expect(indices.slice(1)).toEqual(
    Array.from({ length: 19 }, (_, index) => 49_996 + index),
  );
  expect(activityRange(range, 50_001)).toHaveLength(19);
  expect(activityRange({ ...range, count: 0 }, 2)).toEqual([]);
  expect(
    activityRange({ count: 2, startIndex: 0, endIndex: 1, overscan: 4 }, 100),
  ).toEqual([0, 1]);
});
it("orders lazy card descriptors and removes hidden objects without losing stable identity", () => {
  let state = initialState();
  const append = (content: EventContent) => {
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: state.appliedSeq + 1,
      timelineMs: state.appliedSeq,
      receivedAt: "2026-09-09T00:00:00Z",
      origin: { type: "server", operationId: String(state.appliedSeq) },
      content,
    };
    state = apply(state, event);
  };
  append({
    kind: "message.started",
    payload: { messageId: "message", role: "user" },
  });
  append({
    kind: "message.text.append",
    payload: { messageId: "message", text: "<script>not markup</script>" },
  });
  append({ kind: "tool.started", payload: { toolId: "tool", name: "Read" } });
  append({
    kind: "agent.updated",
    payload: { agentId: "child/#", name: "Worker", status: "active" },
  });
  const order = (key: string) =>
    ["messages/message", "tools/tool", "agents/child/#"].indexOf(key);
  const rows = activityRows(state, order);
  expect(rows.map((row) => row.key)).toEqual([
    "messages/message",
    "tools/tool",
    "agents/child/#",
  ]);
  const markup = renderToStaticMarkup(
    createElement(ActivityCard, {
      row: rows[0],
      state,
      onAttachment: () => {},
    }),
  );
  expect(markup).toContain("&lt;script&gt;not markup&lt;/script&gt;");
  expect(rows[2]!.anchor).toBe("agents-child%2F%23");
  append({
    kind: "object.visibility",
    payload: { objectType: "tool", objectId: "tool", visible: false },
  });
  expect(activityRows(state, order).map((row) => row.key)).toEqual([
    "messages/message",
    "agents/child/#",
  ]);
  append({
    kind: "object.visibility",
    payload: { objectType: "tool", objectId: "tool", visible: true },
  });
  expect(activityRows(state, order)).toEqual(rows);
});

it("uses the production virtualizer to measure dynamic rows without mounting the full history", () => {
  const { Virtualizer } = require("@tanstack/react-virtual");
  const viewport = new Virtualizer({
    count: 100_000,
    getScrollElement: () => null,
    getItemKey: (index: number) => `message/${index}`,
    estimateSize: () => 100,
    initialRect: { width: 360, height: 600 },
    initialOffset: 500_000,
    overscan: 4,
    rangeExtractor: (range: Parameters<typeof activityRange>[0]) =>
      activityRange(range, 2),
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn: () => {},
  });
  const before = viewport.getVirtualItems();
  expect(before.length).toBeLessThanOrEqual(16);
  expect(before[0].key).toBe("message/2");
  expect(before.some((item: { index: number }) => item.index === 5000)).toBe(
    true,
  );
  expect(viewport.getTotalSize()).toBe(10_000_000);
  viewport.resizeItem(5000, 400);
  const after = viewport.getVirtualItems();
  expect(
    after.find((item: { index: number }) => item.index === 5000).size,
  ).toBe(400);
  expect(viewport.getTotalSize()).toBe(10_000_300);
  expect(after.length).toBeLessThanOrEqual(16);
});

it("gives cards accessible structure without announcing remounted rows", () => {
  let state = initialState();
  const append = (content: EventContent) => {
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: state.appliedSeq + 1,
      timelineMs: state.appliedSeq,
      receivedAt: "2026-09-12T00:00:00Z",
      origin: { type: "server", operationId: String(state.appliedSeq) },
      content,
    };
    state = apply(state, event);
  };
  append({
    kind: "tool.started",
    payload: { toolId: "tool", name: "Read", input: "tool input" },
  });
  append({
    kind: "tool.completed",
    payload: { toolId: "tool", status: "completed", output: "tool output" },
  });
  for (let version = 1; version <= 40; version++)
    append({
      kind: "attachment.available",
      payload: {
        attachment: {
          artifactId: "artifact",
          version,
          hash: "a".repeat(64),
          byteSize: 3,
          filename: "notes.txt",
          mediaType: "text/plain",
        },
      },
    });
  const order = (key: string) =>
    ["tools/tool", "artifacts/artifact"].indexOf(key);
  const rows = activityRows(state, order);
  const card = (index: number) =>
    renderToStaticMarkup(
      createElement(ActivityCard, {
        row: rows[index],
        state,
        onAttachment: () => {},
      }),
    );
  // The session title is a level 2 heading, so a card's own headings must
  // start at level 3: a screen reader's heading list cannot skip a level.
  const tool = card(0);
  expect(tool).toContain('<h3 class="field-heading">Input</h3>');
  expect(tool).toContain('<h3 class="field-heading">Output</h3>');
  expect(tool).not.toMatch(/<h[456]/);
  // A mounted row carries no announcement text: virtual rows remount
  // constantly, and a filled live region would read every one of them.
  const artifact = card(1);
  expect(artifact).toContain("Versions 1–32 of 40");
  expect(artifact).toMatch(
    /<span class="visually-hidden" role="status" aria-atomic="true"><\/span>/,
  );
  expect(artifact).not.toMatch(/role="status"[^>]*>[^<]/);
  expect(artifact).not.toMatch(/aria-live/);
});

it("announces arriving activity outside the scrolling feed", () => {
  let state = initialState();
  const append = (content: EventContent) => {
    const event: StoredEvent = {
      protocolVersion: 1,
      serverSeq: state.appliedSeq + 1,
      timelineMs: state.appliedSeq,
      receivedAt: "2026-09-12T00:00:00Z",
      origin: { type: "server", operationId: String(state.appliedSeq) },
      content,
    };
    state = apply(state, event);
  };
  for (const id of ["one", "two", "three"]) {
    append({
      kind: "message.started",
      payload: { messageId: id, role: "assistant" },
    });
    append({
      kind: "message.text.append",
      payload: { messageId: id, text: `Message ${id}.` },
    });
  }
  const feed = renderToStaticMarkup(
    createElement(ActivityFeed, {
      state,
      following: true,
      onPause: () => {},
      order: () => 0,
      onAttachment: () => {},
    }),
  );
  const viewport = feed.slice(feed.indexOf('class="activity-viewport"'));
  // The feed itself is never a live region: following live replaces its rows
  // continuously, and a screen reader would read the whole recording again.
  expect(viewport).not.toContain("aria-live");
  expect(viewport).not.toContain('role="status"');
  expect(viewport).toContain('role="region"');
  // One empty polite announcement lives beside the feed instead.
  expect(feed).toMatch(
    /<p class="visually-hidden" role="status" aria-atomic="true"><\/p>/,
  );
});
