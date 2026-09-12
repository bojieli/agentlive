import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  cursorSchema,
  errorCodes,
  idSchema,
  ProtocolError,
  type PublishedEvent,
} from "@agentlive/protocol";
import {
  ConnectionLost,
  delay,
  request,
  retryable,
} from "@agentlive/client/transport";
import { PublisherJournal } from "./journal.js";
const ackSchema = z.object({
  producerEpoch: idSchema,
  throughProducerSeq: cursorSchema,
  serverSeq: cursorSchema,
  revision: idSchema,
});
const responseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocolVersion: z.literal(1) }),
  z.object({ type: z.literal("heartbeat"), protocolVersion: z.literal(1) }),
  z.object({
    type: z.literal("resumed"),
    protocolVersion: z.literal(1),
    requestId: idSchema,
    ack: ackSchema,
  }),
  z
    .object({
      type: z.literal("ack"),
      protocolVersion: z.literal(1),
      requestId: idSchema,
    })
    .extend(ackSchema.shape),
  z.object({
    type: z.literal("error"),
    protocolVersion: z.literal(1),
    requestId: idSchema.optional(),
    code: z.enum(errorCodes),
    message: z.string(),
  }),
]);
type Reply = z.infer<typeof responseSchema>;
export type PublisherStatus =
  "connecting" | "publishing" | "live" | "paused" | "reconnecting" | "stopped";
export interface PublisherNetworkOptions {
  journal: PublisherJournal;
  ownerCredential?: string;
  title: string;
  visibility: "public" | "unlisted" | "private";
  onStatus?: (status: PublisherStatus) => void;
  fetch?: typeof fetch;
  retryMinMs?: number;
  retryMaxMs?: number;
}
class PublisherSocket {
  private pending:
    | {
        id: string;
        resolve: (reply: Reply) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private failure: unknown;
  private lastSeen = Date.now();
  private heartbeat: ReturnType<typeof setInterval>;
  private constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal,
  ) {
    socket.on("message", (bytes, isBinary) => {
      try {
        if (isBinary)
          throw new ProtocolError(
            "invalid_request",
            "Unexpected binary publisher response",
          );
        const parsed = responseSchema.safeParse(JSON.parse(bytes.toString()));
        if (!parsed.success)
          throw new ProtocolError(
            "version_unsupported",
            "Unsupported publisher response",
          );
        const reply = parsed.data;
        this.lastSeen = Date.now();
        if (reply.type === "hello" || reply.type === "heartbeat") return;
        if (reply.type === "error") {
          this.fail(new ProtocolError(reply.code, reply.message));
          return;
        }
        if (!this.pending || reply.requestId !== this.pending.id)
          throw new ProtocolError(
            "invalid_request",
            "Unexpected publisher response correlation",
          );
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(reply);
      } catch (error) {
        this.fail(
          error instanceof ProtocolError
            ? error
            : new ProtocolError(
                "invalid_request",
                "Malformed publisher response",
              ),
        );
      }
    });
    socket.on("close", () =>
      this.fail(new ConnectionLost("Publisher connection closed")),
    );
    socket.on("error", () =>
      this.fail(new ConnectionLost("Publisher transport failed")),
    );
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > 60_000)
        this.fail(new ConnectionLost("Publisher heartbeat timed out"));
      else if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            protocolVersion: 1,
            requestId: "heartbeat",
          }),
        );
    }, 20_000);
    this.heartbeat.unref();
    signal.addEventListener("abort", this.aborted, { once: true });
    if (signal.aborted) this.aborted();
  }
  private aborted = () =>
    this.fail(this.signal.reason ?? new ConnectionLost("Publisher stopped"));
  static async open(
    origin: string,
    secret: string,
    signal: AbortSignal,
  ): Promise<PublisherSocket> {
    signal.throwIfAborted();
    const socket = new WebSocket(
      origin.replace(/^http/, "ws") + "/api/v1/publish",
      {
        headers: { authorization: `Bearer ${secret}` },
        maxPayload: 64 * 1024,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
        followRedirects: false,
      },
    );
    const client = new PublisherSocket(socket, signal);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("open", opened);
          socket.off("error", failed);
          socket.off("close", failed);
          signal.removeEventListener("abort", aborted);
        };
        const opened = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(
            client.failure ?? new ConnectionLost("Publisher handshake failed"),
          );
        };
        const aborted = () => {
          cleanup();
          reject(signal.reason);
        };
        socket.once("open", opened);
        socket.once("error", failed);
        socket.once("close", failed);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private fail(error: unknown) {
    if (this.failure !== undefined) return;
    this.failure = error;
    clearInterval(this.heartbeat);
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.socket.terminate();
  }
  check(): void {
    if (this.failure !== undefined) throw this.failure;
  }
  call(message: Record<string, unknown>): Promise<Reply> {
    this.check();
    this.signal.throwIfAborted();
    if (this.pending) throw new Error("Publisher request already in flight");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () =>
          this.fail(new ConnectionLost("Publisher acknowledgement timed out")),
        15_000,
      );
      this.pending = { id, resolve, reject, timer };
      this.socket.send(
        JSON.stringify({ ...message, protocolVersion: 1, requestId: id }),
        (error) => {
          if (error) this.fail(new ConnectionLost("Publisher send failed"));
        },
      );
    });
  }
  close(): void {
    this.signal.removeEventListener("abort", this.aborted);
    this.fail(new ConnectionLost("Publisher connection ended"));
  }
}
/** Durable journal owns identity and retries. The transport owns only an expendable lease. */
export class PublisherNetwork {
  private running = false;
  private status: PublisherStatus | undefined;
  private report(status: PublisherStatus): void {
    if (status !== this.status) {
      this.status = status;
      this.options.onStatus?.(status);
    }
  }
  private readonly options: PublisherNetworkOptions;
  constructor(options: PublisherNetworkOptions) {
    this.options = { ...options };
    for (const value of [
      options.retryMinMs ?? 250,
      options.retryMaxMs ?? 30_000,
    ])
      if (!Number.isFinite(value) || value < 1)
        throw new RangeError("Invalid reconnect delay");
  }
  async ensureRemote(signal: AbortSignal): Promise<void> {
    const journal = this.options.journal,
      binding = journal.identity;
    if (binding.pendingCredentialRotation)
      throw new Error(
        "Complete pending publisher credential rotation before publishing",
      );
    if (binding.streamId) return;
    if (!this.options.ownerCredential)
      throw new ProtocolError(
        "unauthorized",
        "Creating a recording requires owner authorization",
      );
    const result = await request(
      this.options.fetch ?? fetch,
      binding.serverOrigin + "/api/v1/streams",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.ownerCredential}`,
          "content-type": "application/json",
        },
        body: canonicalJson({
          requestId: binding.creationRequestId,
          requestedAt: binding.creationTime,
          publisherId: binding.publisherId,
          producerEpoch: binding.producerEpoch,
          writeSecret: binding.writeSecret,
          title: this.options.title,
          visibility: this.options.visibility,
        }),
      },
      signal,
      4096,
    );
    const remote = z
      .object({ streamId: idSchema, revision: idSchema })
      .parse(JSON.parse(result.text));
    await journal.bindRemote(remote.streamId, remote.revision);
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Publisher network is already running");
    this.running = true;
    const journal = this.options.journal;
    let attempt = 0;
    try {
      while (!signal.aborted) {
        if (!journal.identity.sharingEnabled) {
          this.report("paused");
          await delay(100, signal).catch(() => {});
          continue;
        }
        this.report(attempt ? "reconnecting" : "connecting");
        try {
          await this.ensureRemote(signal);
          const identity = journal.identity;
          const connectionAttempt = await journal.nextConnectionAttempt();
          const socket = await PublisherSocket.open(
            identity.serverOrigin,
            identity.writeSecret,
            signal,
          );
          const connectedAt = Date.now();
          try {
            const resumed = await socket.call({
              type: "resume",
              streamId: identity.streamId,
              revision: identity.revision,
              publisherId: identity.publisherId,
              producerEpoch: identity.producerEpoch,
              attempt: connectionAttempt,
            });
            if (resumed.type !== "resumed")
              throw new ProtocolError(
                "invalid_request",
                "Expected resume response",
              );
            await this.acknowledge(resumed.ack);
            while (!signal.aborted && journal.identity.sharingEnabled) {
              socket.check();
              const batch: PublishedEvent[] = [];
              let bytes = 2;
              if (journal.identity.acknowledgedSeq < journal.capturedThrough)
                for await (const event of journal.pending()) {
                  const size =
                    Buffer.byteLength(canonicalJson(event)) +
                    (batch.length ? 1 : 0);
                  if (size + 2 > 256 * 1024)
                    throw new ProtocolError(
                      "invalid_request",
                      "Captured event exceeds publish batch limit",
                    );
                  if (batch.length === 100 || bytes + size > 256 * 1024) break;
                  // Events journaled before the binding existed are bound on
                  // read; nothing may reach the server with a placeholder.
                  if (event.streamId !== identity.streamId)
                    throw new ProtocolError(
                      "invalid_request",
                      "Captured event is not bound to the published recording",
                    );
                  batch.push(event);
                  bytes += size;
                }
              if (!batch.length) {
                if (Date.now() - connectedAt >= 30_000) attempt = 0;
                this.report("live");
                await delay(50, signal);
                continue;
              }
              if (!journal.identity.sharingEnabled) break;
              this.report("publishing");
              const reply = await socket.call({ type: "batch", events: batch });
              if (
                reply.type !== "ack" ||
                reply.throughProducerSeq !== batch.at(-1)!.producerSeq
              )
                throw new ProtocolError(
                  "sequence_gap",
                  "Server did not acknowledge the full batch",
                );
              await this.acknowledge(reply);
              attempt = 0;
            }
          } finally {
            socket.close();
          }
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
  private async acknowledge(ack: z.infer<typeof ackSchema>): Promise<void> {
    const journal = this.options.journal,
      identity = journal.identity;
    if (ack.revision !== identity.revision)
      throw new ProtocolError("revision_changed", "Server revision changed");
    if (ack.producerEpoch !== identity.producerEpoch)
      throw new ProtocolError(
        "event_conflict",
        "Server publisher epoch changed",
      );
    if (
      ack.throughProducerSeq < identity.acknowledgedSeq ||
      ack.throughProducerSeq > journal.capturedThrough
    )
      throw new ProtocolError(
        "sequence_gap",
        "Server and local durable prefixes disagree",
      );
    if (ack.throughProducerSeq !== identity.acknowledgedSeq)
      await journal.acknowledge(ack.throughProducerSeq);
  }
}
