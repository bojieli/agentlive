import { Hono } from "hono";
import {
  serve,
  upgradeWebSocket,
  type HttpBindings,
  type WebSocketLike,
  type WebSocketServerLike,
} from "@hono/node-server";
import type { WSContext } from "hono/ws";
import { WebSocketServer, type WebSocket } from "ws";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  ProtocolError,
  canonicalJson,
  hashSchema,
  idSchema,
  publisherMessageSchema,
  subscriberMessageSchema,
  contentSchema,
  type ErrorCode,
  type StoredEvent,
} from "@agentlive/protocol";
import { RecordingStore, createSessionSchema } from "./store.js";
import type { RecordingSession, Lease } from "./session.js";

export interface ServerOptions {
  directory: string;
  ownerSecret: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  maxConnections?: number;
  maxSocketBytes?: number;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const token = (header: string | undefined) =>
  header?.startsWith("Bearer ") ? header.slice(7) : "";
function protocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    error instanceof TypeError
  )
    return new ProtocolError("invalid_request", "Invalid protocol request");
  return new ProtocolError("storage_failed", "Storage operation failed");
}
const statusFor = (code: ErrorCode): 400 | 401 | 403 | 404 | 409 | 503 =>
  code === "unauthorized"
    ? 401
    : code === "forbidden"
      ? 403
      : code === "stream_gone"
        ? 404
        : ["retry_later", "storage_failed"].includes(code)
          ? 503
          : [
                "event_conflict",
                "sequence_gap",
                "stale_lease",
                "publisher_busy",
                "revision_changed",
                "precondition_failed",
                "recording_ended",
              ].includes(code)
            ? 409
            : 400;
async function boundedJson(
  request: Request,
  maxBytes = 300 * 1024,
): Promise<unknown> {
  if (!request.body)
    throw new ProtocolError("invalid_request", "Missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new ProtocolError(
          "invalid_request",
          "Request body exceeds limit",
        );
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const integer = (value: string | undefined, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    value === undefined ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ProtocolError(
      "cursor_invalid",
      "Expected a nonnegative integer cursor",
    );
  return Number(value);
};

export async function startServer(options: ServerOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.ownerSecret))
    throw new Error("Owner secret must be 32 random bytes encoded as hex");
  const store = await RecordingStore.open(options.directory);
  const app = new Hono<{ Bindings: HttpBindings }>();
  const ownerHash = digest(options.ownerSecret);
  const isOwner = (secret: string) =>
    !!secret && timingSafeEqual(digest(secret), ownerHash);
  const maximum = options.maxConnections ?? 256;
  const socketLimit = options.maxSocketBytes ?? 2 * 1024 * 1024;
  let origin = options.publicOrigin ?? "";
  let closing = false;
  const tickets = new Map<string, { streamId: string; expires: number }>();
  const readable = (session: RecordingSession, secret: string) => {
    if (session.info.visibility !== "private" || isOwner(secret)) return;
    try {
      session.authorize(secret);
    } catch {
      throw new ProtocolError(
        "forbidden",
        "This recording requires viewing authorization",
      );
    }
  };
  app.use("*", async (c, next) => {
    const supplied = c.req.header("origin");
    if (supplied && supplied !== origin)
      return c.json(
        { error: { code: "forbidden", message: "Origin is not allowed" } },
        403,
      );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    if (closing)
      return c.json(
        { error: { code: "retry_later", message: "Server is closing" } },
        503,
      );
    await next();
  });
  app.onError((error, c) => {
    const failure = protocolError(error);
    return c.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          details: failure.details,
        },
      },
      statusFor(failure.code),
    );
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => c.json({ ready: !closing }));
  app.post("/api/v1/streams", async (c) => {
    if (!isOwner(token(c.req.header("authorization"))))
      throw new ProtocolError("unauthorized", "Owner authorization required");
    const input = createSessionSchema
      .omit({ ownerId: true })
      .parse(await boundedJson(c.req.raw));
    const session = await store.create({ ...input, ownerId: "local" });
    return c.json(
      { streamId: session.info.id, revision: session.info.revision },
      201,
    );
  });
  app.get("/api/v1/streams/:id", async (c) => {
    const session = await store.get(c.req.param("id"));
    readable(session, token(c.req.header("authorization")));
    const {
      id,
      revision,
      title,
      visibility,
      lifecycle,
      serverSeq,
      timelineMs,
      lifecycleSeq,
    } = session.info;
    return c.json({
      id,
      revision,
      title,
      visibility,
      lifecycle,
      serverSeq,
      timelineMs,
      lifecycleSeq,
    });
  });
  app.get("/api/v1/streams/:id/events", async (c) => {
    const session = await store.get(c.req.param("id"));
    readable(session, token(c.req.header("authorization")));
    if (c.req.query("revision") !== session.info.revision)
      throw new ProtocolError("revision_changed", "History revision changed");
    const after = integer(c.req.query("afterServerSeq"), 0);
    const through = integer(c.req.query("throughServerSeq"));
    const limit = integer(c.req.query("limit"), 500);
    if (limit < 1 || limit > 1000)
      throw new ProtocolError(
        "invalid_request",
        "History page limit must be between 1 and 1000",
      );
    const lines: string[] = [];
    let size = 0;
    let next = after;
    for await (const event of session.history(after, through)) {
      const line = canonicalJson(event) + "\n";
      const bytes = Buffer.byteLength(line);
      if (lines.length && size + bytes > 2 * 1024 * 1024) break;
      lines.push(line);
      size += bytes;
      next = event.serverSeq;
      if (lines.length === limit) break;
    }
    c.header("X-AgentLive-Revision", session.info.revision);
    c.header("X-AgentLive-Through", String(through));
    c.header("X-AgentLive-Next-Cursor", String(next));
    c.header("X-AgentLive-Complete", String(next === through));
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return c.body(lines.join(""));
  });
  app.post("/api/v1/streams/:id/attachments", async (c) => {
    const session = await store.get(c.req.param("id"));
    const secret = token(c.req.header("authorization"));
    session.authorize(secret);
    const descriptor = {
      hash: hashSchema.parse(c.req.header("x-attachment-sha256")),
      byteSize: integer(c.req.header("x-attachment-bytes")),
    };
    if (!c.req.raw.body)
      throw new ProtocolError("invalid_request", "Missing upload body");
    const source = Readable.fromWeb(
      c.req.raw.body as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    try {
      const uploaded = await session.uploadAttachment(
        secret,
        descriptor,
        source,
        c.req.raw.signal,
      );
      return c.json(uploaded, 201);
    } finally {
      source.destroy();
    }
  });
  app.get("/api/v1/streams/:id/attachments/:hash/status", async (c) => {
    const session = await store.get(c.req.param("id"));
    const available = await session.attachmentStatus(
      token(c.req.header("authorization")),
      { hash: c.req.param("hash"), byteSize: integer(c.req.query("byteSize")) },
    );
    return c.json({ available });
  });
  app.get("/api/v1/streams/:id/attachments/:hash", async (c) => {
    const session = await store.get(c.req.param("id"));
    readable(session, token(c.req.header("authorization")));
    const hash = hashSchema.parse(c.req.param("hash"));
    const file = await session.openAttachment(hash);
    try {
      const size = (await file.stat()).size;
      const body = Readable.toWeb(
        file.createReadStream({ autoClose: true }),
      ) as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="${hash}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      await file.close();
      throw error;
    }
  });
  for (const action of ["end", "reopen"] as const)
    app.post(`/api/v1/streams/:id/${action}`, async (c) => {
      const session = await store.get(c.req.param("id"));
      const input = z
        .strictObject({
          operationId: idSchema,
          expectedLifecycleSeq: z.number().int().nonnegative(),
          content: contentSchema,
        })
        .parse(await boundedJson(c.req.raw));
      if (
        input.content.kind !==
        (action === "end" ? "recording.ended" : "recording.reopened")
      )
        throw new ProtocolError(
          "invalid_request",
          "Unexpected lifecycle operation",
        );
      const content = input.content as Extract<
        typeof input.content,
        { kind: "recording.ended" | "recording.reopened" }
      >;
      return c.json(
        await session.lifecycle(
          token(c.req.header("authorization")),
          input.operationId,
          input.expectedLifecycleSeq,
          content,
        ),
      );
    });
  app.post("/api/v1/streams/:id/watch-ticket", async (c) => {
    const session = await store.get(c.req.param("id"));
    readable(session, token(c.req.header("authorization")));
    for (const [key, ticket] of tickets)
      if (ticket.expires < Date.now()) tickets.delete(key);
    if (tickets.size >= 1024)
      throw new ProtocolError(
        "retry_later",
        "Too many pending viewing tickets",
      );
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, {
      streamId: session.info.id,
      expires: Date.now() + 60_000,
    });
    return c.json({ ticket, expiresInMs: 60_000 });
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 300 * 1024,
    perMessageDeflate: false,
  });
  function connection(
    publishing: boolean,
    secret: string,
    ticketStream: string | undefined,
  ) {
    let socket: WSContext<WebSocketLike> | undefined;
    let session: RecordingSession | undefined;
    let lease: Lease | undefined;
    let unsubscribe: (() => void) | undefined;
    let queue: Promise<void> = Promise.resolve();
    let queued = 0;
    let ended = false;
    let lastSeen = Date.now();

    const send = (value: unknown) => {
      if (ended || !socket || socket.readyState !== 1) return;
      const serialized = JSON.stringify(value);
      if (
        (socket.raw as WebSocket).bufferedAmount +
          Buffer.byteLength(serialized) >
        socketLimit
      ) {
        cleanup();
        socket.close(1013, "Resume from last contiguous cursor");
        return;
      }
      socket.send(serialized);
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      ended = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    return {
      onOpen(_event: Event, ws: WSContext<WebSocketLike>) {
        socket = ws;
        heartbeat = setInterval(() => {
          if (Date.now() - lastSeen > 60_000) {
            cleanup();
            ws.close(1001, "Heartbeat timeout");
          } else send({ type: "heartbeat", protocolVersion: 1 });
        }, 20_000);
        heartbeat.unref();
        send({ type: "hello", protocolVersion: 1 });
      },
      onClose: cleanup,
      onError: cleanup,
      onMessage(event: MessageEvent, ws: WSContext<WebSocketLike>) {
        if (ended) return;
        if (typeof event.data !== "string" || queued >= 8) {
          ws.close(1008, "Invalid or excessive pending messages");
          return;
        }
        const data = event.data;
        queued++;
        lastSeen = Date.now();
        queue = queue
          .then(async () => {
            if (ended) return;
            let requestId: string | undefined;
            try {
              const raw = JSON.parse(data);
              requestId =
                typeof raw.requestId === "string" ? raw.requestId : undefined;
              if (publishing) {
                const message = publisherMessageSchema.parse(raw);
                if (message.type === "heartbeat") {
                  send({ type: "heartbeat", protocolVersion: 1, requestId });
                  return;
                }
                if (message.type === "resume") {
                  if (session)
                    throw new ProtocolError(
                      "invalid_request",
                      "Use a fresh socket for a new publishing lease",
                    );
                  const target = await store.get(message.streamId);
                  const result = await target.resume(secret, message);
                  if (ended) return;
                  session = target;
                  lease = result.lease;
                  send({
                    type: "resumed",
                    protocolVersion: 1,
                    requestId,
                    ...result,
                  });
                } else {
                  if (!session || !lease)
                    throw new ProtocolError(
                      "unauthorized",
                      "Resume before publishing",
                    );
                  const ack = await session.append(lease, message.events);
                  send({ type: "ack", protocolVersion: 1, requestId, ...ack });
                }
              } else {
                const message = subscriberMessageSchema.parse(raw);
                if (message.type === "heartbeat") {
                  send({ type: "heartbeat", protocolVersion: 1, requestId });
                  return;
                }
                if (message.type === "unsubscribe") {
                  unsubscribe?.();
                  unsubscribe = undefined;
                  session = undefined;
                  send({ type: "unsubscribed", protocolVersion: 1, requestId });
                  return;
                }
                unsubscribe?.();
                unsubscribe = undefined;
                const target = await store.get(message.streamId);
                if (ticketStream !== target.info.id) readable(target, secret);
                if (message.revision !== target.info.revision)
                  throw new ProtocolError(
                    "revision_changed",
                    "Recording revision changed",
                  );
                if (message.afterServerSeq > target.boundary.sequence)
                  throw new ProtocolError(
                    "cursor_invalid",
                    "Cursor exceeds recording history",
                  );
                let ready = false;
                let pendingBytes = 0;
                const pending: StoredEvent[] = [];
                const subscribedSession = await target.subscribe({
                  deliver: (event) => {
                    if (ended) return;
                    if (ready)
                      send({ type: "event", protocolVersion: 1, event });
                    else {
                      pendingBytes += Buffer.byteLength(canonicalJson(event));
                      if (pendingBytes > socketLimit) {
                        cleanup();
                        socket?.close(
                          1013,
                          "Resume from last contiguous cursor",
                        );
                      } else pending.push(event);
                    }
                  },
                  invalidate: (reason) => {
                    send({
                      type: "resync_required",
                      protocolVersion: 1,
                      reason,
                    });
                    socket?.close(1012, "Resubscribe");
                  },
                });
                if (ended) {
                  subscribedSession.unsubscribe();
                  return;
                }
                session = target;
                unsubscribe = subscribedSession.unsubscribe;

                send({
                  type: "subscribed",
                  protocolVersion: 1,
                  requestId,
                  revision: subscribedSession.revision,
                  boundary: subscribedSession.boundary,
                });
                ready = true;
                for (const event of pending)
                  send({ type: "event", protocolVersion: 1, event });
              }
            } catch (error) {
              const failure = protocolError(error);
              send({
                type: "error",
                protocolVersion: 1,
                requestId,
                code: failure.code,
                message: failure.message,
                details: failure.details,
              });
            }
          })
          .finally(() => {
            queued--;
          });
      },
    };
  }
  for (const [path, publishing] of [
    ["/api/v1/publish", true],
    ["/api/v1/watch", false],
  ] as const) {
    app.get(
      path,
      async (c, next) => {
        if (wss.clients.size >= maximum)
          throw new ProtocolError(
            "retry_later",
            "Connection capacity exceeded",
          );
        if (publishing && !token(c.req.header("authorization")))
          throw new ProtocolError(
            "unauthorized",
            "Publishing requires a credential",
          );
        await next();
      },
      upgradeWebSocket((c) => {
        let ticketStream: string | undefined;
        const value = c.req.query("ticket");
        if (value) {
          const ticket = tickets.get(value);
          tickets.delete(value);
          if (!ticket || ticket.expires < Date.now())
            throw new ProtocolError("unauthorized", "Viewing ticket expired");
          ticketStream = ticket.streamId;
        }
        return connection(
          publishing,
          token(c.req.header("authorization")),
          ticketStream,
        );
      }),
    );
  }
  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      fetch: app.fetch,
      hostname: options.host ?? "127.0.0.1",
      port: options.port ?? 7331,
      // ws is the documented runtime backend; its overloaded send types
      // differ from the adapter interface under exactOptionalPropertyTypes.
      websocket: { server: wss as unknown as WebSocketServerLike },
    });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) resolve();
      else {
        server.once("listening", resolve);
        server.once("error", reject);
      }
    });
  } catch (error) {
    wss.close();
    await store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listening address");
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  if (!origin) origin = url;
  let closePromise: Promise<void> | undefined;
  return {
    url,
    store,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const client of wss.clients) client.terminate();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        if ("closeAllConnections" in server) server.closeAllConnections();
        await stopped;
        await store.close();
        wss.close();
      })();
      return closePromise;
    },
  };
}
