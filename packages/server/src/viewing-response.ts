const sliceBytes = 64 * 1024;
/** Stop emitting response bytes when the authorization lifetime ends. */
export function viewingResponse(
  response: Response,
  access: { signal: AbortSignal; close(): void },
): Response {
  if (!response.body) {
    access.close();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let remainder: Uint8Array | undefined;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    access.signal.removeEventListener("abort", abort);
    access.close();
  };
  const abort = () => {
    if (finished) return;
    controller.error(access.signal.reason);
    void reader.cancel(access.signal.reason).catch(() => {});
    cleanup();
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        access.signal.addEventListener("abort", abort, { once: true });
        if (access.signal.aborted) abort();
      },
      async pull() {
        try {
          access.signal.throwIfAborted();
          if (!remainder) {
            const next = await reader.read();
            if (finished) return;
            access.signal.throwIfAborted();
            if (next.done) {
              controller.close();
              cleanup();
              return;
            }
            remainder = next.value;
          }
          // Bound each emitted chunk so authorization is rechecked during large
          // in-memory bodies, not only between source chunks.
          const chunk = remainder.subarray(0, sliceBytes);
          remainder =
            chunk.byteLength < remainder.byteLength
              ? remainder.subarray(chunk.byteLength)
              : undefined;
          controller.enqueue(chunk);
        } catch (error) {
          if (!finished) {
            controller.error(error);
            cleanup();
            void reader.cancel(error).catch(() => {});
          }
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
