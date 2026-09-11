/** Release deadline timers and parent listeners when short operations settle. */
export function operationSignal(
  parents: readonly AbortSignal[],
  timeoutMs: number,
) {
  const controller = new AbortController();
  const abort = (event: Event) =>
    controller.abort((event.target as AbortSignal).reason);
  for (const parent of parents) {
    if (parent.aborted) {
      controller.abort(parent.reason);
      break;
    }
    parent.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Operation timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener("abort", abort);
    },
  };
}
