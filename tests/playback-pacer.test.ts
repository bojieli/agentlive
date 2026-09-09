import { afterEach, expect, it, vi } from "vitest";
import { PlaybackPacer } from "../packages/playback/src/index.js";
afterEach(() => vi.useRealTimers());
function clock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  return new AbortController();
}
it("preserves recorded timing and rebases speed changes without jumping", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer(2);
  const finished = vi.fn();
  const pending = pacer.waitUntil(1000, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(200);
  expect(finished).not.toHaveBeenCalled();
  pacer.setSpeed(1);
  await vi.advanceTimersByTimeAsync(599);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(finished).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("pauses even already-due events and resumes without consuming paused time", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  const finished = vi.fn();
  const pending = pacer.waitUntil(1000, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(400);
  pacer.setPaused(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(finished).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  pacer.setSpeed(2);
  pacer.setPaused(false);
  await vi.advanceTimersByTimeAsync(299);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  pacer.setPaused(true);
  const due = vi.fn();
  const waiting = pacer.waitUntil(0, abort.signal).then(due);
  await vi.advanceTimersByTimeAsync(0);
  expect(due).not.toHaveBeenCalled();
  pacer.setPaused(false);
  await waiting;
  expect(due).toHaveBeenCalledOnce();
});
it("aborts paused waits and very long gaps without leaked timers", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  const pending = pacer.waitUntil(3_000_000_000, abort.signal);
  const rejected = expect(pending).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(100);
  abort.abort(new Error("stopped"));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  const pausedAbort = new AbortController();
  pacer.setPaused(true);
  const paused = expect(
    pacer.waitUntil(10, pausedAbort.signal),
  ).rejects.toThrow("paused stop");
  pausedAbort.abort(new Error("paused stop"));
  await paused;
});
it("resets to a positioned source and rejects invalid timing controls", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  pacer.reset(5000);
  await pacer.waitUntil(5000, abort.signal);
  expect(() => pacer.setSpeed(0)).toThrow();
  expect(() => pacer.setSpeed(Infinity)).toThrow();
  expect(() => pacer.reset(-1)).toThrow();
  await expect(pacer.waitUntil(NaN, abort.signal)).rejects.toThrow();
});

it("wakes timed waits for immediate catch-up while retaining pause semantics", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  const finished = vi.fn();
  const pending = pacer.waitUntil(60_000, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(100);
  pacer.setPaused(true);
  pacer.setImmediate(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(finished).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  pacer.setPaused(false);
  await pending;
  expect(finished).toHaveBeenCalledOnce();
  pacer.reset(60_000);
  pacer.setImmediate(false);
  const next = vi.fn();
  const waiting = pacer.waitUntil(61_000, abort.signal).then(next);
  await vi.advanceTimersByTimeAsync(999);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});
