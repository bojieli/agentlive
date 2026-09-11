import { expect, it, vi } from "vitest";
import { operationSignal } from "../../apps/web/src/operation-signal.js";
it("disposes timers and parent listeners after normal completion", () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener"),
      remove = vi.spyOn(parent.signal, "removeEventListener");
    for (let i = 0; i < 1000; i++) {
      const operation = operationSignal([parent.signal], 10000);
      operation.dispose();
      expect(operation.signal.aborted).toBe(false);
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(add).toHaveBeenCalledTimes(1000);
    expect(remove).toHaveBeenCalledTimes(1000);
  } finally {
    vi.useRealTimers();
  }
});
it("preserves cancellation reasons and deadline expiry", () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const operation = operationSignal([parent.signal], 10);
    parent.abort(new Error("cancelled"));
    expect(() => operation.signal.throwIfAborted()).toThrow("cancelled");
    operation.dispose();
    const expired = operationSignal([], 10);
    vi.advanceTimersByTime(10);
    expect(expired.signal.reason.name).toBe("TimeoutError");
    expired.dispose();
    const late = operationSignal([parent.signal], 10);
    expect(late.signal.reason).toBe(parent.signal.reason);
    late.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
