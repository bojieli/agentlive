import { z } from "zod";
import {
  cursorSchema,
  idSchema,
  errorCodes,
  storedEventSchema,
  ProtocolError,
  type StoredEvent,
} from "@agentlive/protocol";
import { ConnectionLost, delay, originOf, request, retryable } from "./http.js";
export interface SubscriberCursor {
  streamId: string;
  revision: string;
  serverSeq: number;
}
export type SubscriberStatus =
  "connecting" | "catching-up" | "live" | "reconnecting" | "stopped";
export interface SubscriberOptions {
  serverOrigin: string;
  cursor: SubscriberCursor;
  /** Optional local credential, exchanged for a scoped one-use WebSocket ticket. */
  credential?: string;
  /** Commit state and this cursor atomically; resolution permits advancing receipt. */
  commit: (
    events: readonly StoredEvent[],
    cursor: SubscriberCursor,
  ) => Promise<void>;
  onStatus?: (status: SubscriberStatus) => void;
  maxLiveBytes?: number;
  pageSize?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  fetch?: typeof fetch;
  webSocket?: (url: string) => WebSocket;
}
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocolVersion: z.literal(1) }),
  z.object({ type: z.literal("heartbeat"), protocolVersion: z.literal(1) }),
  z.object({
    type: z.literal("subscribed"),
    protocolVersion: z.literal(1),
    requestId: idSchema,
    revision: idSchema,
    boundary: z.object({ sequence: cursorSchema }),
  }),
  z.object({
    type: z.literal("event"),
    protocolVersion: z.literal(1),
    event: storedEventSchema,
  }),
  z.object({
    type: z.literal("error"),
    protocolVersion: z.literal(1),
    code: z.enum(errorCodes),
    message: z.string(),
  }),
  z.object({
    type: z.literal("resync_required"),
    protocolVersion: z.literal(1),
    reason: z.string(),
  }),
]);
class CommitFailure extends Error {
  constructor(override readonly cause: unknown) {
    super("Subscriber state commit failed");
  }
}
/** One synchronization engine for browser and terminal. Playback follows a separate cursor. */
export class SubscriberClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly options: SubscriberOptions;
  private position: SubscriberCursor;
  private running = false;
  private status: SubscriberStatus | undefined;
  private report(status: SubscriberStatus): void {
    if (status !== this.status) {
      this.status = status;
      this.options.onStatus?.(status);
    }
  }
  private readonly maxLiveBytes: number;
  private readonly pageSize: number;
  constructor(options: SubscriberOptions) {
    this.options = { ...options };
    this.origin = originOf(options.serverOrigin);
    this.position = z
      .object({
        streamId: idSchema,
        revision: idSchema,
        serverSeq: cursorSchema,
      })
      .parse(options.cursor);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.socketFactory = options.webSocket ?? ((url) => new WebSocket(url));
    this.maxLiveBytes = options.maxLiveBytes ?? 2 * 1024 * 1024;
    this.pageSize = options.pageSize ?? 500;
    if (
      !Number.isSafeInteger(this.maxLiveBytes) ||
      this.maxLiveBytes < 1 ||
      !Number.isSafeInteger(this.pageSize) ||
      this.pageSize < 1 ||
      this.pageSize > 1000
    )
      throw new RangeError("Invalid subscriber limits");
    for (const value of [
      options.retryMinMs ?? 250,
      options.retryMaxMs ?? 30_000,
    ])
      if (!Number.isFinite(value) || value < 1)
        throw new RangeError("Invalid reconnect delay");
  }
  get cursor(): SubscriberCursor {
    return { ...this.position };
  }
  private headers(): HeadersInit {
    return this.options.credential
      ? { authorization: `Bearer ${this.options.credential}` }
      : {};
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Subscriber is already running");
    this.running = true;
    let attempt = 0;
    try {
      while (!signal.aborted) {
        this.report(attempt ? "reconnecting" : "connecting");
        try {
          const startedAt = Date.now(),
            before = this.position.serverSeq;
          await this.connect(signal, () => {
            if (
              this.position.serverSeq > before ||
              Date.now() - startedAt >= 30_000
            )
              attempt = 0;
          });
        } catch (error) {
          if (signal.aborted) break;
          if (!retryable(error)) throw error;
          const cap = Math.min(
            this.options.retryMaxMs ?? 30_000,
            (this.options.retryMinMs ?? 250) * 2 ** Math.min(attempt++, 16),
          );
          await delay(cap * (0.5 + Math.random() * 0.5), signal).catch(
            (error) => {
              if (!signal.aborted) throw error;
            },
          );
        }
      }
    } finally {
      this.running = false;
      this.report("stopped");
    }
  }
  private async connect(
    parent: AbortSignal,
    caughtUp: () => void,
  ): Promise<void> {
    const base = `${this.origin}/api/v1/streams/${this.position.streamId}`;
    const ticketResponse = await request(
      this.fetcher,
      base + "/watch-ticket",
      { method: "POST", headers: this.headers() },
      parent,
      4096,
    );
    const ticket = z
      .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(ticketResponse.text)).ticket;
    const socket = this.socketFactory(
      this.origin.replace(/^http/, "ws") + "/api/v1/watch?ticket=" + ticket,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    let notify: () => void = () => {};
    let watermark = this.position.serverSeq;
    let subscribed = false;
    let liveBytes = 0;
    let lastSeen = Date.now();
    let failure: unknown;
    const live = new Map<number, { event: StoredEvent; bytes: number }>();
    const fail = (error: unknown) => {
      if (!controller.signal.aborted) {
        failure = error;
        controller.abort(error);
        notify();
      }
    };
    const send = (value: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    };
    const message = (event: MessageEvent) => {
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).byteLength > 2 * 1024 * 1024
        )
          throw new ProtocolError("invalid_request", "Invalid live frame");
        const result = frameSchema.safeParse(JSON.parse(event.data));
        if (!result.success)
          throw new ProtocolError(
            "version_unsupported",
            "Unsupported server frame",
          );
        const frame = result.data;
        lastSeen = Date.now();
        if (frame.type === "hello") {
          send({
            type: "subscribe",
            protocolVersion: 1,
            requestId: "subscribe",
            streamId: this.position.streamId,
            revision: this.position.revision,
            afterServerSeq: this.position.serverSeq,
          });
        } else if (frame.type === "subscribed") {
          if (subscribed || frame.requestId !== "subscribe")
            throw new ProtocolError(
              "invalid_request",
              "Unexpected subscription boundary",
            );
          if (frame.revision !== this.position.revision)
            throw new ProtocolError(
              "revision_changed",
              "Recording revision changed; cached state must be reset explicitly",
            );
          if (frame.boundary.sequence < this.position.serverSeq)
            throw new ProtocolError(
              "cursor_invalid",
              "Server history is behind committed subscriber state",
            );
          watermark = frame.boundary.sequence;
          subscribed = true;
          notify();
        } else if (frame.type === "event") {
          if (!subscribed)
            throw new ProtocolError(
              "invalid_request",
              "Live event arrived before subscription boundary",
            );
          watermark = Math.max(watermark, frame.event.serverSeq);
          if (
            frame.event.serverSeq > this.position.serverSeq &&
            !live.has(frame.event.serverSeq)
          ) {
            const bytes = new TextEncoder().encode(event.data).byteLength;
            if (liveBytes + bytes > this.maxLiveBytes) {
              live.clear();
              liveBytes = 0;
            }
            if (bytes <= this.maxLiveBytes) {
              live.set(frame.event.serverSeq, { event: frame.event, bytes });
              liveBytes += bytes;
            }
          }
          notify();
        } else if (frame.type === "error")
          fail(new ProtocolError(frame.code, frame.message));
        else if (frame.type === "resync_required")
          fail(new ProtocolError("resync_required", frame.reason));
      } catch (error) {
        fail(
          error instanceof ProtocolError
            ? error
            : new ProtocolError("invalid_request", "Malformed live frame"),
        );
      }
    };
    const closed = () => fail(new ConnectionLost("Live connection closed"));
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", closed);
    const aborted = () => {
      notify();
      socket.close();
    };
    signal.addEventListener("abort", aborted, { once: true });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > 60_000)
        fail(new ConnectionLost("Live heartbeat timed out"));
      else
        send({ type: "heartbeat", protocolVersion: 1, requestId: "heartbeat" });
    }, 20_000);
    const handshake = setTimeout(() => {
      if (!subscribed) fail(new ConnectionLost("Subscription timed out"));
    }, 10_000);
    const wait = () =>
      new Promise<void>((resolve) => {
        notify = resolve;
        if (signal.aborted) resolve();
      });
    try {
      if (signal.aborted) return;
      while (!signal.aborted) {
        if (!subscribed) {
          await wait();
          continue;
        }
        if (this.position.serverSeq === watermark) {
          caughtUp();
          this.report("live");
          await wait();
          continue;
        }
        this.report("catching-up");
        const batch: StoredEvent[] = [];
        let next = this.position.serverSeq + 1;
        while (live.has(next) && batch.length < this.pageSize) {
          const item = live.get(next)!;
          batch.push(item.event);
          next++;
        }
        if (!batch.length) {
          const through = watermark;
          const page = await request(
            this.fetcher,
            `${base}/events?revision=${this.position.revision}&afterServerSeq=${this.position.serverSeq}&throughServerSeq=${through}&limit=${this.pageSize}`,
            { headers: this.headers() },
            signal,
          );
          if (
            page.response.headers.get("x-agentlive-revision") !==
            this.position.revision
          )
            throw new ProtocolError(
              "revision_changed",
              "History page revision changed",
            );
          if (
            page.response.headers.get("x-agentlive-through") !== String(through)
          )
            throw new ProtocolError(
              "invalid_request",
              "History page boundary changed",
            );
          if (!page.text.endsWith("\n"))
            throw new ProtocolError(
              "invalid_request",
              "Incomplete JSONL history page",
            );
          for (const line of page.text.slice(0, -1).split("\n"))
            batch.push(storedEventSchema.parse(JSON.parse(line)));
          if (
            !batch.length ||
            batch.length > this.pageSize ||
            page.response.headers.get("x-agentlive-next-cursor") !==
              String(batch.at(-1)!.serverSeq)
          )
            throw new ProtocolError(
              "invalid_request",
              "Invalid history page cursor",
            );
        }
        let expected = this.position.serverSeq + 1;
        for (const event of batch)
          if (event.serverSeq !== expected++ || event.serverSeq > watermark)
            throw new ProtocolError(
              "sequence_gap",
              "History is not contiguous",
            );
        signal.throwIfAborted();
        const cursor = { ...this.position, serverSeq: batch.at(-1)!.serverSeq };
        try {
          await this.options.commit(batch, { ...cursor });
        } catch (error) {
          throw new CommitFailure(error);
        }
        this.position = cursor;
        for (const [sequence, item] of live)
          if (sequence <= cursor.serverSeq) {
            live.delete(sequence);
            liveBytes -= item.bytes;
          }
      }
      if (failure) throw failure;
    } catch (error) {
      if (error instanceof CommitFailure) throw error;
      if (parent.aborted) return;
      if (failure) throw failure;
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(handshake);
      signal.removeEventListener("abort", aborted);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", closed);
      socket.close();
    }
  }
}
