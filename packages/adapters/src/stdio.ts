import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
const envelope = z.object({
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export interface RpcNotification {
  method: string;
  params: unknown;
}
export interface StdioOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  onNotification: (message: RpcNotification) => Promise<void>;
  /** Operator-side request handling, never supplied by broadcast viewers. */
  onRequest?: (message: RpcNotification) => Promise<unknown>;
  maxFrameBytes?: number;
  maxNotificationBytes?: number;
}
/** Owned child process, bounded JSONL framing, correlated RPC, serialized notifications. */
export class StdioRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = Buffer.alloc(0);
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private notificationError: unknown;
  private transportError: unknown;
  private sequence = 0;
  private operatorRequests = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly exited: Promise<void>;
  private readonly options: StdioOptions;
  readonly captureFailure: Promise<unknown>;
  private reportCaptureFailure!: (error: unknown) => void;
  constructor(options: StdioOptions) {
    this.options = { ...options };
    for (const limit of [
      options.maxFrameBytes ?? 4 * 1024 * 1024,
      options.maxNotificationBytes ?? 8 * 1024 * 1024,
    ])
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError("Invalid transport limits");
    this.captureFailure = new Promise((resolve) => {
      this.reportCaptureFailure = resolve;
    });
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    // Drain diagnostics without broadcasting or retaining local credentials and paths.
    this.child.stderr.resume();
    this.child.stdin.on("error", () =>
      this.fail(new Error("Agent input pipe failed")),
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.on("error", () =>
      this.fail(new Error("Agent output pipe failed")),
    );
    this.child.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => {
        if (!this.closed)
          this.fail(
            new Error(
              this.buffer.length
                ? "Agent exited with an incomplete frame"
                : "Agent process exited",
            ),
          );
        resolve();
      });
    });
  }
  private failCapture(error: unknown) {
    if (this.notificationError === undefined) {
      this.notificationError = error;
      this.reportCaptureFailure(error);
    }
  }
  private fail(error: unknown) {
    if (this.transportError !== undefined) return;
    this.transportError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closed) this.failCapture(error);
  }
  private receive(chunk: Buffer) {
    if (this.transportError !== undefined || this.closed) return;
    const maximum = this.options.maxFrameBytes ?? 4 * 1024 * 1024;
    let start = 0;
    try {
      for (let i = 0; i < chunk.length; i++)
        if (chunk[i] === 10) {
          const size = this.buffer.length + i - start;
          if (size > maximum) throw new Error("Agent frame exceeds limit");
          const line = Buffer.concat([this.buffer, chunk.subarray(start, i)]);
          this.buffer = Buffer.alloc(0);
          start = i + 1;
          if (line.length)
            this.dispatch(
              envelope.parse(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(line),
                ),
              ),
              line.length,
            );
        }
      if (this.buffer.length + chunk.length - start > maximum)
        throw new Error("Agent frame exceeds limit");
      if (start < chunk.length)
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(start)]);
    } catch (error) {
      this.fail(error);
    }
  }
  private dispatch(message: z.infer<typeof envelope>, bytes: number) {
    if (message.method) {
      const notification = {
        method: message.method,
        params: message.params ?? {},
      };
      if (message.id !== undefined) {
        const id = message.id;
        if (this.operatorRequests >= 32) {
          this.send({
            id,
            error: {
              code: -32000,
              message: "Too many pending operator requests",
            },
          });
          return;
        }
        this.operatorRequests++;
        void Promise.resolve()
          .then(() => {
            if (!this.options.onRequest)
              throw new Error("Operator request handler is unavailable");
            return this.options.onRequest(notification);
          })
          .then(
            (result) => this.send({ id, result }),
            () =>
              this.send({
                id,
                error: {
                  code: -32601,
                  message: "Operator request is unsupported",
                },
              }),
          )
          .catch(() => {})
          .finally(() => {
            this.operatorRequests--;
          });
        return;
      }
      if (this.notificationError !== undefined) return;
      if (
        this.queuedBytes + bytes >
        (this.options.maxNotificationBytes ?? 8 * 1024 * 1024)
      ) {
        this.failCapture(
          new Error(
            "Agent capture queue exceeded limit; source recovery is required",
          ),
        );
        return;
      }
      this.queuedBytes += bytes;
      this.queue = this.queue
        .then(async () => {
          if (this.notificationError === undefined)
            await this.options.onNotification(notification);
        })
        .catch((error) => this.failCapture(error))
        .finally(() => {
          this.queuedBytes -= bytes;
        });
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            `Agent RPC failed (${message.error.code}): ${message.error.message}`,
          ),
        );
      else pending.resolve(message.result);
    }
  }
  private send(message: unknown): void {
    if (this.closed || this.transportError !== undefined)
      throw this.transportError ?? new Error("Agent transport closed");
    const line = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(line) > 4 * 1024 * 1024 ||
      this.child.stdin.writableLength > 4 * 1024 * 1024
    )
      throw new Error("Agent input exceeds limit");
    this.child.stdin.write(line);
  }
  notify(method: string, params: unknown = {}): void {
    this.send({ method, params });
  }
  call(
    method: string,
    params: unknown = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.pending.size >= 32)
      return Promise.reject(new Error("Too many agent RPC requests"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async drain(): Promise<void> {
    await this.queue;
    if (this.notificationError !== undefined) throw this.notificationError;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.fail(new Error("Agent transport closed"));
    this.child.stdin.end();
    this.closePromise = (async () => {
      const kill = () => {
        try {
          if (process.platform === "win32") this.child.kill("SIGKILL");
          else if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(kill, 2000);
      try {
        await this.exited;
        await this.queue;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closePromise;
  }
}
