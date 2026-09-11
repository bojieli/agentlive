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

it("steps exactly one event across tied timestamps and stays paused across long gaps", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  pacer.setPaused(true);
  pacer.step();
  expect(await pacer.waitUntil(60000, abort.signal)).toBe("step");
  expect(pacer.paused).toBe(true);
  const completed = vi.fn();
  const tied = pacer.waitUntil(60000, abort.signal).then(completed);
  await vi.advanceTimersByTimeAsync(100000);
  expect(completed).not.toHaveBeenCalled();
  pacer.step();
  await tied;
  expect(completed).toHaveBeenCalledWith("step");
  pacer.setPaused(false);
  const next = vi.fn();
  const pending = pacer.waitUntil(61000, abort.signal).then(next);
  await vi.advanceTimersByTimeAsync(999);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(next).toHaveBeenCalledWith("play");
  expect(vi.getTimerCount()).toBe(0);
});
it("retains queued steps across source anchoring, discards them on seek/resume, and cancels waits", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  pacer.step();
  pacer.step();
  pacer.reset(0);
  expect(await pacer.waitUntil(0, abort.signal)).toBe("step");
  expect(await pacer.waitUntil(0, abort.signal)).toBe("step");
  pacer.step();
  pacer.seek(0);
  const rejected = expect(pacer.waitUntil(0, abort.signal)).rejects.toThrow(
    "cancel step",
  );
  abort.abort(new Error("cancel step"));
  await rejected;
  pacer.step();
  pacer.setPaused(false);
  pacer.setPaused(true);
  const second = new AbortController(),
    finished = vi.fn();
  const waiting = pacer.waitUntil(0, second.signal).then(finished);
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).not.toHaveBeenCalled();
  pacer.step();
  await waiting;
  expect(finished).toHaveBeenCalledWith("step");
});

it("caps each recorded idle gap before speed scaling while preserving short gaps and pause time", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer(2);
  pacer.setIdleCap(1000);
  pacer.reset(100);
  const finished = vi.fn();
  const first = pacer.waitUntil(60100, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(200);
  pacer.setPaused(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(finished).not.toHaveBeenCalled();
  pacer.setPaused(false);
  await vi.advanceTimersByTimeAsync(299);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await first;
  expect(finished).toHaveBeenCalledWith("play");
  const short = vi.fn();
  const next = pacer.waitUntil(60500, abort.signal).then(short);
  await vi.advanceTimersByTimeAsync(199);
  expect(short).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await next;
  pacer.setPaused(true);
  pacer.step();
  expect(await pacer.waitUntil(120000, abort.signal)).toBe("step");
  pacer.setPaused(false);
  const afterStep = vi.fn();
  const pending = pacer.waitUntil(240000, abort.signal).then(afterStep);
  await vi.advanceTimersByTimeAsync(499);
  expect(afterStep).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("allows zero idle cap without dropping tied events and validates the cap", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  expect(() => pacer.setIdleCap(-1)).toThrow("Idle cap");
  expect(() => pacer.setIdleCap(Infinity)).toThrow("Idle cap");
  pacer.setIdleCap(0);
  for (const time of [0, 10000, 10000, 1e9])
    expect(await pacer.waitUntil(time, abort.signal)).toBe("play");
  pacer.setIdleCap(undefined);
  pacer.reset(0);
  const finished = vi.fn();
  const pending = pacer.waitUntil(100, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(99);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
});

it("updates a pending idle cap and removes skipped time on cancellation without altering a later reset", async () => {
  const abort = clock();
  const pacer = new PlaybackPacer();
  const finished = vi.fn();
  const pending = pacer.waitUntil(60000, abort.signal).then(finished);
  await vi.advanceTimersByTimeAsync(200);
  pacer.setIdleCap(1000);
  await vi.advanceTimersByTimeAsync(799);
  expect(finished).not.toHaveBeenCalled();
  pacer.setIdleCap(undefined);
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).not.toHaveBeenCalled();
  pacer.setIdleCap(500);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(finished).toHaveBeenCalledWith("play");
  pacer.reset(0);
  pacer.setPaused(true);
  const cancelled = new AbortController();
  const rejected = expect(
    pacer.waitUntil(60000, cancelled.signal),
  ).rejects.toThrow("cancel wait");
  cancelled.abort(new Error("cancel wait"));
  await rejected;
  pacer.setIdleCap(undefined);
  pacer.setPaused(false);
  const next = vi.fn();
  const short = pacer.waitUntil(100, abort.signal).then(next);
  await vi.advanceTimersByTimeAsync(99);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await short;
  pacer.setIdleCap(10);
  pacer.setPaused(true);
  const old = new AbortController();
  const discarded = expect(pacer.waitUntil(60000, old.signal)).rejects.toThrow(
    "seek",
  );
  pacer.reset(500);
  old.abort(new Error("seek"));
  await discarded;
  pacer.setIdleCap(undefined);
  pacer.setPaused(false);
  expect(await pacer.waitUntil(500, abort.signal)).toBe("play");
  expect(vi.getTimerCount()).toBe(0);
});
