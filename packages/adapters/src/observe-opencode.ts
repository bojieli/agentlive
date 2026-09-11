import {
  request,
  originOf,
  delay,
  retryable,
  ConnectionLost,
} from "@agentlive/client/transport";
import { idSchema } from "@agentlive/protocol";
import {
  parseOpenCodeSnapshot,
  type OpenCodeSnapshot,
} from "./opencode-history.js";
export interface OpenCodeObserveOptions {
  serverOrigin: string;
  nativeSessionId: string;
  password?: string;
  username?: string;
  signal: AbortSignal;
  /** Complete current native history; resolve only after normalized effects are durable. */
  commit(snapshot: OpenCodeSnapshot): Promise<void>;
  onStatus?: (
    status: "connecting" | "observing" | "reconnecting" | "stopped",
  ) => void;
  fetch?: typeof fetch;
  pollMs?: number;
  retryMs?: number;
  /** Finish after a snapshot whose fetch begins after this request is observed. */
  finishRequested?: () => boolean;
}
class CaptureFailure extends Error {
  constructor(override readonly cause: unknown) {
    super("OpenCode snapshot capture failed");
  }
}
/** SSE invalidates snapshots; periodic history reconciliation repairs missing notifications. No native DB access. */
export async function observeOpenCodeSession(
  options: OpenCodeObserveOptions,
): Promise<void> {
  const origin = originOf(options.serverOrigin);
  const id = idSchema.parse(options.nativeSessionId);
  const fetcher = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? 2000;
  const retryMs = options.retryMs ?? 250;
  if (
    ![pollMs, retryMs].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 60000,
    )
  )
    throw new RangeError("Invalid OpenCode observation interval");
  const headers = options.password
    ? {
        authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`,
      }
    : {};
  let reconnecting = false;
  let status:
    "connecting" | "observing" | "reconnecting" | "stopped" | undefined;
  const report = (next: NonNullable<typeof status>) => {
    if (status !== next) {
      status = next;
      options.onStatus?.(next);
    }
  };
  try {
    while (!options.signal.aborted) {
      report(reconnecting ? "reconnecting" : "connecting");
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let reading: Promise<void> | undefined;
      let streamFailure: unknown;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const headerTimer = setTimeout(
          () =>
            controller.abort(
              new ConnectionLost("OpenCode SSE connection timed out"),
            ),
          15000,
        );
        let response: Response;
        try {
          response = await fetcher(origin + "/event", {
            headers,
            signal,
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
          });
        } finally {
          clearTimeout(headerTimer);
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 500 || response.status === 429)
            throw new ConnectionLost(
              "OpenCode event stream temporarily unavailable",
            );
          throw new Error(
            `OpenCode event subscription failed (${response.status})`,
          );
        }
        if (
          !response.body ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        ) {
          await response.body?.cancel();
          throw new Error("OpenCode did not return an event stream");
        }
        reader = response.body.getReader();
        let generation = 1;
        reading = (async () => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let pending = "";
          let data: string[] = [];
          let frameBytes = 0;
          const line = (value: string) => {
            if (!value) {
              if (data.length) {
                const event = JSON.parse(data.join("\n"));
                if (
                  !event ||
                  typeof event !== "object" ||
                  typeof event.type !== "string"
                )
                  throw new Error("Malformed OpenCode event");
                if (
                  event.type !== "server.heartbeat" &&
                  event.type !== "server.connected"
                )
                  generation++;
              }
              data = [];
              frameBytes = 0;
              return;
            }
            frameBytes += Buffer.byteLength(value);
            if (frameBytes > 2 * 1024 * 1024)
              throw new Error("OpenCode event frame exceeds limit");
            if (value.startsWith("data:"))
              data.push(value.slice(5).replace(/^ /, ""));
          };
          while (true) {
            idleTimer = setTimeout(
              () =>
                controller.abort(
                  new ConnectionLost("OpenCode event stream stalled"),
                ),
              60000,
            );
            const chunk = await reader!.read();
            clearTimeout(idleTimer);
            if (chunk.done)
              throw new ConnectionLost("OpenCode event stream ended");
            for (let offset = 0; offset < chunk.value.length; offset += 65536) {
              try {
                pending += decoder.decode(
                  chunk.value.subarray(offset, offset + 65536),
                  { stream: true },
                );
              } catch {
                throw new Error("OpenCode event stream contains invalid UTF-8");
              }
              let end;
              while ((end = pending.indexOf("\n")) !== -1) {
                line(pending.slice(0, end).replace(/\r$/, ""));
                pending = pending.slice(end + 1);
              }
              if (Buffer.byteLength(pending) + frameBytes > 2 * 1024 * 1024)
                throw new Error("OpenCode event frame exceeds limit");
            }
          }
        })().catch((error) => {
          streamFailure = error;
          controller.abort(error);
        });
        let committed = 0;
        let nextPoll = 0;
        while (!signal.aborted) {
          const finishing = options.finishRequested?.() ?? false;
          if (
            finishing ||
            generation !== committed ||
            performance.now() >= nextPoll
          ) {
            const boundary = generation;
            const info = JSON.parse(
              (
                await request(
                  fetcher,
                  `${origin}/session/${id}`,
                  { headers },
                  signal,
                  1024 * 1024,
                )
              ).text,
            );
            const messages = JSON.parse(
              (
                await request(
                  fetcher,
                  `${origin}/session/${id}/message`,
                  { headers },
                  signal,
                  64 * 1024 * 1024,
                )
              ).text,
            );
            const snapshot = parseOpenCodeSnapshot({ info, messages });
            if (snapshot.info.id !== id)
              throw new Error("OpenCode returned a different native session");
            try {
              await options.commit(snapshot);
            } catch (error) {
              throw new CaptureFailure(error);
            }
            if (finishing) return;
            committed = boundary;
            nextPoll = performance.now() + pollMs;
            report("observing");
            reconnecting = false;
          }
          await delay(Math.min(100, pollMs), signal);
        }
        if (streamFailure) throw streamFailure;
      } catch (error) {
        if (error instanceof CaptureFailure) throw error;
        if (options.signal.aborted) break;
        const failure =
          streamFailure ??
          (controller.signal.aborted ? controller.signal.reason : error);
        if (!retryable(failure)) throw failure;
        reconnecting = true;
      } finally {
        controller.abort();
        if (idleTimer) clearTimeout(idleTimer);
        await reader?.cancel().catch(() => {});
        await reading;
        reader?.releaseLock();
      }
      if (!options.signal.aborted)
        await delay(retryMs, options.signal).catch((error) => {
          if (!options.signal.aborted) throw error;
        });
    }
  } finally {
    report("stopped");
  }
}
