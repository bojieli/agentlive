import { it, expect, vi } from "vitest";
import { loadActivityWindow } from "../../apps/web/src/activity-window.js";
import type { ActivityRow } from "../../apps/web/src/activity.js";
const signal = () => AbortSignal.timeout(10000);
it("loads only viewport pages and a distant focused page in a large recording", async () => {
  const rows = vi.fn(
    async (offset: number, limit: number): Promise<ActivityRow[]> =>
      Array.from({ length: Math.min(limit, 500000 - offset) }, (_, index) => ({
        kind: "messages",
        id: String(offset + index),
        key: `messages/${offset + index}`,
        anchor: `messages-${offset + index}`,
      })),
  );
  const view = { rowCount: 500000, rows };
  const window = await loadActivityWindow(view, [64, 96, 64, 499968], signal());
  expect(rows.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    [64, 32],
    [96, 32],
    [499968, 32],
  ]);
  expect(window.size).toBe(96);
  expect(window.get(499999)!.key).toBe("messages/499999");
  const next = await loadActivityWindow(view, [128], signal());
  expect(next.size).toBe(32);
  expect(next.has(64)).toBe(false);
});
it("does not publish a partial window on missing rows or cancellation", async () => {
  await expect(
    loadActivityWindow({ rowCount: 100, rows: async () => [] }, [0], signal()),
  ).rejects.toThrow("missing row range");
  const abort = new AbortController();
  const rows = vi.fn(async () => {
    abort.abort(new Error("window changed"));
    return [];
  });
  await expect(
    loadActivityWindow({ rowCount: 100, rows }, [0, 32], abort.signal),
  ).rejects.toThrow("window changed");
  expect(rows).toHaveBeenCalledOnce();
});
