import { z } from "zod";
import { errorCodes, ProtocolError } from "@agentlive/protocol";
import { ConnectionLost, originOf, readText } from "./http.js";

const resultSchema = z.object({
  event: z.literal("backup"),
  mode: z.literal("online"),
  output: z.string(),
  recordings: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  barrierMs: z.number().int().nonnegative(),
});
export type OnlineBackupResult = z.infer<typeof resultSchema>;

function failure(code: unknown, message: unknown): Error {
  return errorCodes.includes(code as (typeof errorCodes)[number])
    ? new ProtocolError(
        code as (typeof errorCodes)[number],
        typeof message === "string" ? message : "Server backup failed",
      )
    : new Error("Server backup failed");
}

/** Ask a running server (owner credential) to write an online backup into a
 * new directory on the server host. Waits for the final NDJSON result line. */
export async function requestOnlineBackup(options: {
  serverOrigin: string;
  credential: string;
  output: string;
  barrierTimeoutMs?: number;
  signal: AbortSignal;
  onProgress?: (event: { event: string; phase?: string }) => void;
  fetch?: typeof fetch;
}): Promise<OnlineBackupResult> {
  const response = await (options.fetch ?? fetch)(
    `${originOf(options.serverOrigin)}/api/v1/admin/backup`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        output: options.output,
        ...(options.barrierTimeoutMs === undefined
          ? {}
          : { barrierTimeoutMs: options.barrierTimeoutMs }),
      }),
      signal: options.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const text = await readText(response, 64 * 1024, options.signal).catch(
      () => "",
    );
    let error: { code?: unknown; message?: unknown } | undefined;
    try {
      error = JSON.parse(text).error;
    } catch {}
    if (error && errorCodes.includes(error.code as never))
      throw failure(error.code, error.message);
    if (response.status >= 500)
      throw new ConnectionLost("Server temporarily unavailable");
    throw new ProtocolError(
      "invalid_request",
      `Unexpected HTTP status ${response.status}`,
    );
  }
  if (!response.body) throw new Error("Server backup response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 64 * 1024)
        throw new Error("Server backup progress line exceeds limit");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event?.event === "backup") return resultSchema.parse(event);
        if (event?.event === "error") throw failure(event.code, event.message);
        if (typeof event?.event === "string") options.onProgress?.(event);
      }
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throw new ConnectionLost("Server backup ended without a result");
}
