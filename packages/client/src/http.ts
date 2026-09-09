import { errorCodes, ProtocolError } from "@agentlive/protocol";
export class ConnectionLost extends Error {}
export function originOf(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TypeError("Expected a server origin without credentials or path");
  return url.origin;
}
export async function readText(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    bytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum)
        throw new ProtocolError(
          "invalid_request",
          "Server response exceeds limit",
        );
      text += decoder.decode(item.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  maximum = 2 * 1024 * 1024,
): Promise<{ response: Response; text: string }> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetcher(url, {
    ...init,
    signal: deadline,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  const text = await readText(response, maximum, deadline);
  if (!response.ok) {
    let error: any;
    try {
      error = JSON.parse(text).error;
    } catch {}
    if (errorCodes.includes(error?.code))
      throw new ProtocolError(
        error.code,
        typeof error.message === "string"
          ? error.message
          : "Server rejected request",
      );
    if (response.status === 429 || response.status >= 500)
      throw new ConnectionLost("Server temporarily unavailable");
    throw new ProtocolError(
      "invalid_request",
      `Unexpected HTTP status ${response.status}`,
    );
  }
  return { response, text };
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
export function retryable(error: unknown): boolean {
  return (
    error instanceof ConnectionLost ||
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof ProtocolError &&
      ["retry_later", "storage_failed", "resync_required"].includes(error.code))
  );
}
