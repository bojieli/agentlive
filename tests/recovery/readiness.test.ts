import { afterEach, expect, it, vi } from "vitest";
import { stat, access, statfs } from "node:fs/promises";
import { storageReadiness } from "../../packages/server/src/readiness.js";
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  access: vi.fn(),
  statfs: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
function healthy() {
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(statfs).mockResolvedValue({ bavail: 10n, bsize: 4096n } as any);
}
it("fails closed for exhausted or inaccessible storage and rechecks recovery", async () => {
  healthy();
  const ready = storageReadiness("/private/test");
  expect(await ready()).toBe(true);
  vi.mocked(statfs).mockResolvedValueOnce({ bavail: 0n, bsize: 4096n } as any);
  expect(await ready()).toBe(false);
  vi.mocked(access).mockRejectedValueOnce(new Error("EACCES /private/test"));
  expect(await ready()).toBe(false);
  expect(await ready()).toBe(true);
});
it("bounds caller waits and shares a stalled filesystem probe until it settles", async () => {
  vi.useFakeTimers();
  healthy();
  let release!: (value: any) => void;
  vi.mocked(statfs).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const ready = storageReadiness("/private/test");
  const first = ready(),
    second = ready();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  const third = ready();
  expect(third).toBe(first);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await third).toBe(false);
  expect(statfs).toHaveBeenCalledTimes(1);
  release({ bavail: 1n, bsize: 4096n });
  await vi.advanceTimersByTimeAsync(0);
  expect(await ready()).toBe(true);
  expect(statfs).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not release the shared probe when one check fails and another is still pending", async () => {
  vi.useFakeTimers();
  healthy();
  vi.mocked(access).mockRejectedValueOnce(new Error("unavailable"));
  let release!: (value: any) => void;
  vi.mocked(statfs).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const ready = storageReadiness("/private/test");
  const first = ready();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toBe(false);
  for (let i = 0; i < 1000; i++) expect(ready()).toBe(first);
  expect(statfs).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  release({ bavail: 1n, bsize: 4096n });
  await vi.advanceTimersByTimeAsync(0);
  expect(await ready()).toBe(true);
});
