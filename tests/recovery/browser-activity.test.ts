import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { activityRange } from "../../apps/web/src/activity-range.js";
import { ActivityCard, activityRows } from "../../apps/web/src/activity.js";
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
