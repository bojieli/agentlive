import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProtocolError } from "@agentlive/protocol";
import { prepareOnlineBackup } from "./backup.js";
import type { WriteBarrier } from "./write-barrier.js";

const inputSchema = z.strictObject({
  output: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && !path.includes("\0"), {
      message: "Backup output must be an absolute server-host path",
    }),
  barrierTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

async function boundedText(request: Request, maxBytes: number) {
  if (!request.body)
    throw new ProtocolError("invalid_request", "Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > maxBytes)
        throw new ProtocolError(
          "invalid_request",
          "Request body exceeds limit",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

function describe(error: unknown) {
  if (error instanceof ProtocolError)
    return { code: error.code, message: error.message };
  return {
    code: "storage_failed",
    message:
      error instanceof Error && error.message
        ? error.message.slice(0, 500)
        : "Backup failed",
  };
}

/** Owner-only `POST /api/v1/admin/backup`: an online backup written by the
 * server process to a new directory on the server host. The response is
 * NDJSON: `started`, `progress`/`heartbeat` lines, then exactly one final
 * `backup` or `error` line. Validation, authorization and busy errors are
 * ordinary JSON error responses sent before the stream starts. */
export function adminBackups(options: {
  server: { directory: string; barrier: WriteBarrier };
  ownerSecret: string;
  isOwner: (secret: string) => boolean;
}) {
  const stops = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let closed = false;
  return {
    async handle(request: Request): Promise<Response> {
      const header = request.headers.get("authorization") ?? "";
      if (!header.startsWith("Bearer ") || !options.isOwner(header.slice(7)))
        throw new ProtocolError(
          "unauthorized",
          "Operator owner authorization required",
        );
      if (closed) throw new ProtocolError("retry_later", "Server is closing");
      let input: z.infer<typeof inputSchema>;
      try {
        input = inputSchema.parse(JSON.parse(await boundedText(request, 8192)));
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError("invalid_request", "Invalid backup request");
      }
      const backup = await prepareOnlineBackup({
        server: options.server,
        ownerSecret: options.ownerSecret,
        output: input.output,
      });
      if (closed) {
        await backup.abandon();
        throw new ProtocolError("retry_later", "Server is closing");
      }
      const stop = new AbortController();
      stops.add(stop);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let open = true;
          const write = (value: object) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
            } catch {
              open = false;
            }
          };
          const heartbeat = setInterval(
            () => write({ event: "heartbeat" }),
            10_000,
          );
          heartbeat.unref();
          write({ event: "started", output: backup.output });
          const task = backup
            .run({
              signal: stop.signal,
              ...(input.barrierTimeoutMs === undefined
                ? {}
                : { barrierTimeoutMs: input.barrierTimeoutMs }),
              onPhase: (phase) => write({ event: "progress", phase }),
            })
            .then(
              (result) => write({ event: "backup", mode: "online", ...result }),
              (error) => write({ event: "error", ...describe(error) }),
            )
            .finally(() => {
              clearInterval(heartbeat);
              stops.delete(stop);
              tasks.delete(task);
              if (open)
                try {
                  controller.close();
                } catch {}
              open = false;
            });
          tasks.add(task);
        },
        cancel(reason) {
          // A disconnected operator cancels the backup; the barrier is released.
          stop.abort(reason ?? new Error("Backup client disconnected"));
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    /** Online backups currently running (content-free, for metrics). */
    get active() {
      return tasks.size;
    },
    /** Cancel running backups (deleting partial output) and wait for cleanup. */
    async close() {
      closed = true;
      for (const stop of stops)
        stop.abort(new ProtocolError("retry_later", "Server is closing"));
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
  };
}
