import { reportInputSchema, reportDecisionSchema } from "./reports.js";
import { ViewingGrants } from "./viewing-grants.js";
import { Accounts } from "./accounts.js";
import { AccountSessions } from "./account-sessions.js";
import { OidcLogin } from "./oidc-login.js";
import { hostedAuth } from "./hosted-auth.js";
import { viewingResponse } from "./viewing-response.js";
import { TransferAuthority } from "./transfer-authority.js";
import { adminBackups } from "./admin-backup.js";
import {
  quotaLimitsSchema,
  storageLimitsSchema,
  type QuotaLimits,
  type StorageLimits,
} from "./quotas.js";
import type { StatfsProbe } from "./free-space.js";
import { RequestMetrics, renderMetrics } from "./metrics.js";
import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import { getCookie } from "hono/cookie";
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
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import {
  writeArchive,
  openArchive,
  type ArchiveMetadata,
} from "@agentlive/storage";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  ProtocolError,
  canonicalJson,
  migrationOriginSchema,
  hashSchema,
  snapshotLeaseTokenSchema,
  idSchema,
  publisherMessageSchema,
  subscriberMessageSchema,
  contentSchema,
  reduceCompletenessNotice,
  type ErrorCode,
  type StoredEvent,
} from "@agentlive/protocol";
import { RecordingStore, createSessionSchema } from "./store.js";
import { storageReadiness } from "./readiness.js";
import { OverloadMonitor, type OverloadLimits } from "./overload.js";
import type { RecordingSession, Lease } from "./session.js";

export interface ServerOptions {
  directory: string;
  ownerSecret: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  hosted?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    cookiePassword: string;
    fetch?: import("openid-client").CustomFetch;
  };
  /** Hosted per-account limits; absent fields are unlimited. The local owner is never limited. */
  quotas?: QuotaLimits;
  /**
   * Server-wide storage limits for every writer, including the local owner:
   * `maxStoredBytes` caps committed event log plus attachment bytes of all
   * recordings; `minFreeBytes` refuses growth that would leave less free space on
   * the server filesystem. `statfs` replaces the filesystem probe (tests/embedding).
   */
  storage?: StorageLimits & { statfs?: StatfsProbe };
  /**
   * Enables `GET /metrics` (Prometheus text). Scrapes authenticate with the owner
   * credential or, when set, this separate bearer token. Absent: no route.
   */
  metrics?: { token?: string };
  maxConnections?: number;
  /**
   * When the process is past its fan-out capacity — the event loop lagging, or a
   * large aggregate of queued socket bytes — the server reports not-ready and
   * refuses *new* viewer connections instead of quietly queueing them.
   */
  overload?: OverloadLimits;
  maxCachedSessions?: number;
  snapshots?: import("./snapshot-scheduler.js").SnapshotScheduleOptions;
  maxSocketBytes?: number;
  shutdownTimeoutMs?: number;
}
export class ShutdownTimeoutError extends Error {
  readonly code = "shutdown_timeout";
  constructor(readonly timeoutMs: number) {
    super(
      `Server shutdown exceeded ${timeoutMs}ms; cleanup continues with store ownership retained`,
    );
    this.name = "ShutdownTimeoutError";
  }
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
    : code === "forbidden" || code === "quota_exceeded"
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
  if (options.hosted) {
    const publicUrl = new URL(options.publicOrigin ?? "http://invalid");
    if (
      publicUrl.protocol !== "https:" ||
      publicUrl.origin !== options.publicOrigin
    )
      throw new Error("Hosted mode requires an explicit HTTPS publicOrigin");
  }
  if (!/^[a-f0-9]{64}$/.test(options.ownerSecret))
    throw new Error("Owner secret must be 32 random bytes encoded as hex");
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 2_147_483_647
  )
    throw new Error(
      "shutdownTimeoutMs must be an integer from 1 to 2147483647",
    );
  if (
    options.quotas !== undefined &&
    !quotaLimitsSchema.safeParse(options.quotas).success
  )
    throw new Error("Invalid per-account quota configuration");
  if (options.storage !== undefined) {
    const { statfs, ...limits } = options.storage;
    if (
      !storageLimitsSchema.safeParse(limits).success ||
      (statfs !== undefined && typeof statfs !== "function")
    )
      throw new Error(
        "Invalid server storage limit configuration: maxStoredBytes must be an integer from 4096 to 2^50 and minFreeBytes from 0 to 2^50",
      );
  }
  const metricsToken = options.metrics?.token;
  if (
    metricsToken !== undefined &&
    !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(metricsToken)
  )
    throw new Error(
      "Metrics token must be 32 to 512 URL-safe or base64 characters",
    );
  const store = await RecordingStore.open(options.directory, {
    ...(options.quotas === undefined ? {} : { quotas: options.quotas }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.maxCachedSessions === undefined
      ? {}
      : { maxCachedSessions: options.maxCachedSessions }),
    ...(options.snapshots === undefined
      ? {}
      : { snapshots: options.snapshots }),
  });
  let grants: ViewingGrants;
  let accounts: Accounts | undefined;
  let accountSessions: AccountSessions | undefined;
  let login: OidcLogin | undefined;
  const closeHosted = async () => {
    try {
      await accountSessions?.close();
    } finally {
      await accounts?.close();
    }
  };
  try {
    grants = await ViewingGrants.open(
      join(options.directory, "viewing-grants.json"),
      store.barrier,
    );
  } catch (error) {
    await store.close();
    throw error;
  }
  try {
    if (options.hosted) {
      accounts = await Accounts.open(
        join(options.directory, "accounts"),
        store.barrier,
      );
      accountSessions = await AccountSessions.open(
        join(options.directory, "account-sessions.json"),
        accounts,
        options.hosted.cookiePassword,
        store.barrier,
      );
      login = await OidcLogin.discover({
        ...options.hosted,
        accounts,
        redirectUri: options.publicOrigin + "/auth/callback",
      });
    }
  } catch (error) {
    await closeHosted();
    await grants.close();
    await store.close();
    throw error;
  }
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: {
      session: RecordingSession;
      accountId: string | undefined;
      /** Present only for cookie-authenticated browser account sessions. */
      accountSessionActive: (() => boolean) | undefined;
      /** Aborts when the request's read authorization or recording access ends. */
      transferSignal: AbortSignal | undefined;
    };
  }>();
  // In-flight transfers authorized by revocable principals; see transfer-authority.ts.
  const transfers = new TransferAuthority();
  // Open viewing sockets recheck their authorization at the same revocation points.
  const socketChecks = new Set<() => void>();
  const revalidateTransfers = () => {
    transfers.revalidate();
    for (const check of [...socketChecks]) check();
  };
  accountSessions?.onRevoke(revalidateTransfers);
  /** Hosted moderation: a disabled account's recordings are suspended whole. They accept
   * no publishing and are not served or listed until the account is enabled again; only
   * the operator credential can still read them, to review the reported content. The
   * local owner ("local") has no account record and a standalone server has no account
   * store, so neither is ever suspended. */
  const suspended = (ownerId: string) => accounts?.isDisabled(ownerId) ?? false;
  store.setOwnerSuspension(suspended);
  accounts?.onStatusChange((id) => {
    // Anonymous public read lifetimes are not in the transfer registry; end them here.
    if (suspended(id)) store.suspendOwner(id);
    revalidateTransfers();
  });
  const ownerHash = digest(options.ownerSecret);
  const isOwner = (secret: string) =>
    !!secret && timingSafeEqual(digest(secret), ownerHash);
  const maximum = options.maxConnections ?? 256;
  const socketLimit = options.maxSocketBytes ?? 2 * 1024 * 1024;
  const overload = new OverloadMonitor(options.overload);
  let origin = options.publicOrigin ?? "";
  let closing = false;
  const requests = new Set<Promise<void>>();
  const connections = new Set<() => Promise<void>>();
  const connectionErrors: unknown[] = [];
  const tickets = new Map<
    string,
    {
      streamId: string;
      expires: number;
      grantToken?: string;
      accountCookie?: string;
    }
  >();
  const readable = (
    session: RecordingSession,
    secret: string,
    accountId?: string,
  ) => {
    session.assertAvailable();
    // The operator reads any recording, including a suspended one, to review it.
    if (isOwner(secret)) return;
    if (suspended(session.info.ownerId))
      throw new ProtocolError(
        "forbidden",
        "Recording is unavailable while its owner account is disabled",
      );
    accountId ??= accountSessions?.authenticateDevice(secret)?.account.id;
    if (
      session.info.visibility !== "private" ||
      (accountId !== undefined && session.info.ownerId === accountId) ||
      grants.authorize(secret, session.info.id, session.info.revision)
    )
      return;
    try {
      session.authorize(secret);
    } catch {
      throw new ProtocolError(
        "forbidden",
        "This recording requires viewing authorization",
      );
    }
  };
  // Content-free request accounting by registered route template (never the raw
  // path, which carries recording IDs), method and status class.
  const metrics = new RequestMetrics();
  app.use("*", async (c, next) => {
    try {
      await next();
    } finally {
      let route = "unmatched";
      try {
        const matched = matchedRoutes(c).filter(
          (candidate) => candidate.method !== "ALL",
        );
        route = matched[matched.length - 1]?.path ?? route;
      } catch {}
      metrics.record(c.req.method, route, c.res?.status ?? 500);
    }
  });
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
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    requests.add(done);
    try {
      await next();
    } finally {
      requests.delete(done);
      finished();
    }
  });
  app.use("/api/*", async (c, next) => {
    const device = accountSessions?.authenticateDevice(
      token(c.req.header("authorization")),
    );
    if (device) c.set("accountId", device.account.id);
    // Explicit bearer authorization takes precedence; never silently fall back
    // from an invalid bearer credential to a privileged browser session.
    if (accountSessions && !c.req.header("authorization")) {
      const cookie = getCookie(c, "__Host-agentlive-session");
      const principal = cookie
        ? await accountSessions.authenticate(cookie)
        : undefined;
      if (principal) {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
          (c.req.header("origin") !== origin ||
            !AccountSessions.validCsrf(
              principal.csrf,
              c.req.header("x-csrf-token"),
            ))
        )
          throw new ProtocolError(
            "forbidden",
            "Cookie-authenticated mutations require same-origin CSRF authorization",
          );
        c.set("accountId", principal.account.id);
        c.set("accountSessionActive", principal.isActive);
      }
    }
    await next();
  });
  if (login && accountSessions)
    app.route(
      "/auth",
      hostedAuth({
        origin: options.publicOrigin!,
        login,
        sessions: accountSessions,
      }),
    );
  app.get("/api/v1/auth-config", (c) =>
    c.json({ mode: options.hosted ? "hosted" : "standalone" }),
  );
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
  /** Authorization lifetime of a stream request. Grant tokens keep the grant's own
   * lifetime and anonymous reads end when the recording becomes private. Reads by
   * other credentials (accounts, devices, publisher keys) are rechecked with the
   * route's read rule whenever a revocable principal or recording access changes. */
  const streamAuthorization = (
    session: RecordingSession,
    secret: string,
    method: string,
    signal: AbortSignal,
    accountId: string | undefined,
    accountSessionActive: (() => boolean) | undefined,
  ): { signal: AbortSignal; close(): void } | undefined => {
    if (grants.authorize(secret, session.info.id, session.info.revision))
      return grants.acquire(
        secret,
        session.info.id,
        session.info.revision,
        signal,
      );
    if (method !== "GET") return undefined;
    if (!secret && accountId === undefined)
      return session.acquirePublicRead(signal);
    return transfers.register(() => {
      try {
        // A device credential is re-resolved from its bearer token; a browser
        // session contributes its account only while its ledger entry is live.
        readable(
          session,
          secret,
          accountSessionActive?.() ? accountId : undefined,
        );
        return true;
      } catch {
        return false;
      }
    }, signal);
  };
  app.use("/api/v1/streams/:id", async (c, next) => {
    const session = await store.get(c.req.param("id")!);
    c.set("session", session);
    const secret = token(c.req.header("authorization"));
    let access: { signal: AbortSignal; close(): void } | undefined;
    let responseOwnsSession = false;
    let recordingAccess: { signal: AbortSignal; close(): void } | undefined;
    try {
      recordingAccess = session.acquireRead(c.req.raw.signal);
      access = streamAuthorization(
        session,
        secret,
        c.req.method,
        c.req.raw.signal,
        c.get("accountId"),
        c.get("accountSessionActive"),
      );
      const authorization = access;
      const recording = recordingAccess;
      access = {
        signal: authorization
          ? AbortSignal.any([authorization.signal, recording.signal])
          : recording.signal,
        close() {
          authorization?.close();
          recording.close();
        },
      };
      c.set("transferSignal", access.signal);
      await next();
      if (access) {
        if (access.signal.aborted) {
          await c.res.body?.cancel(access.signal.reason).catch(() => {});
          access.signal.throwIfAborted();
        }
        const lifetime = access;
        responseOwnsSession = true;
        let released = false;
        c.res = viewingResponse(c.res, {
          signal: lifetime.signal,
          close() {
            lifetime.close();
            if (!released) {
              released = true;
              store.release(session);
            }
          },
        });
      }
    } catch (error) {
      access?.close();
      recordingAccess?.close();
      throw error;
    } finally {
      if (!responseOwnsSession) store.release(session);
    }
  });
  app.use("/api/v1/streams/:id/*", async (c, next) => {
    if (c.get("session")) {
      await next();
      return;
    }
    const session = await store.get(c.req.param("id")!);
    c.set("session", session);
    const secret = token(c.req.header("authorization"));
    let access: { signal: AbortSignal; close(): void } | undefined;
    let responseOwnsSession = false;
    let recordingAccess: { signal: AbortSignal; close(): void } | undefined;
    try {
      recordingAccess = session.acquireRead(c.req.raw.signal);
      access = streamAuthorization(
        session,
        secret,
        c.req.method,
        c.req.raw.signal,
        c.get("accountId"),
        c.get("accountSessionActive"),
      );
      const authorization = access;
      const recording = recordingAccess;
      access = {
        signal: authorization
          ? AbortSignal.any([authorization.signal, recording.signal])
          : recording.signal,
        close() {
          authorization?.close();
          recording.close();
        },
      };
      c.set("transferSignal", access.signal);
      await next();
      if (access) {
        if (access.signal.aborted) {
          await c.res.body?.cancel(access.signal.reason).catch(() => {});
          access.signal.throwIfAborted();
        }
        const lifetime = access;
        responseOwnsSession = true;
        let released = false;
        c.res = viewingResponse(c.res, {
          signal: lifetime.signal,
          close() {
            lifetime.close();
            if (!released) {
              released = true;
              store.release(session);
            }
          },
        });
      }
    } catch (error) {
      access?.close();
      recordingAccess?.close();
      throw error;
    } finally {
      if (!responseOwnsSession) store.release(session);
    }
  });
  app.get("/artifact-interactive", async (c) => {
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(
      await readFile(
        new URL("./web/artifact-interactive.html", import.meta.url),
      ),
    );
  });
  app.get("/artifact-preview", async (c) => {
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(
      await readFile(new URL("./web/artifact-preview.html", import.meta.url)),
    );
  });
  for (const [route, filename, mime] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    [
      "/artifact-preview.js",
      "artifact-preview.js",
      "text/javascript; charset=utf-8",
    ],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/app.css", "app.css", "text/css; charset=utf-8"],
    ["/favicon.svg", "favicon.svg", "image/svg+xml"],
  ] as const) {
    app.get(route, async (c) => {
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      c.header("Referrer-Policy", "no-referrer");
      c.header("Content-Type", mime);
      try {
        return c.body(
          await readFile(new URL(`./web/${filename}`, import.meta.url)),
        );
      } catch {
        return c.text(
          "Browser assets are unavailable. Build or reinstall AgentLive.",
          503,
        );
      }
    });
  }
  // Short share links; access keys never appear in the URL.
  app.get("/s/:id", (c) => {
    const parsed = idSchema.safeParse(c.req.param("id"));
    if (!parsed.success) return c.text("Not found", 404);
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(`/?stream=${encodeURIComponent(parsed.data)}`, 302);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  // Transfers stage inside the server directory rather than the system
  // temporary directory: the bytes then share the filesystem the free-space
  // floor measures and the operator monitors, and a crash cannot strand them
  // somewhere nothing cleans up. Cleared once at startup.
  const staging = join(options.directory, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const checkStorage = storageReadiness(options.directory);
  app.get("/readyz", async (c) => {
    // Below the configured free-space floor the server refuses growth, so it
    // reports not-ready; reads keep working.
    const [storageReady, spaceReady] = await Promise.all([
      checkStorage(),
      store.quotas.freeSpace?.ready() ?? true,
    ]);
    // Past its delivery capacity the server is still correct but behind, so it
    // stops asking for new viewers instead of accepting them into a queue.
    const capacity = overload.state;
    const ready =
      !closing && storageReady && spaceReady && !capacity.overloaded;
    return c.json(
      {
        ready,
        ...(capacity.overloaded
          ? { overloaded: true, overloadedForMs: capacity.forMs }
          : {}),
      },
      ready ? 200 : 503,
    );
  });
  let activeImports = 0;
  app.post("/api/v1/imports", async (c) => {
    const ownerId =
      c.get("accountId") ??
      (isOwner(token(c.req.header("authorization"))) ? "local" : undefined);
    if (!ownerId)
      throw new ProtocolError("unauthorized", "Owner authorization required");
    const importRequestId = c.req.header("idempotency-key");
    if (importRequestId !== undefined) idSchema.parse(importRequestId);
    if (!c.req.raw.body)
      throw new ProtocolError("invalid_request", "Archive body is required");
    // Reject an over-quota account before receiving the archive body; the store
    // rechecks the measured size authoritatively before installation.
    store.quotas.precheckRecording(ownerId);
    if (activeImports >= 2)
      throw new ProtocolError("retry_later", "Import capacity is busy");
    const secret = token(c.req.header("authorization"));
    const accountSessionActive = c.get("accountSessionActive");
    // Logout, device revocation or account disable aborts an in-flight import
    // before it commits; the operator credential is not revocable at runtime.
    const importing = transfers.register(
      () =>
        accountSessionActive
          ? accountSessionActive()
          : isOwner(secret) ||
            accountSessions?.authenticateDevice(secret)?.account.id === ownerId,
      c.req.raw.signal,
    );
    const signal = importing.signal;
    activeImports++;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(staging, "upload-"));
      const path = join(directory, "recording.agentlive");
      let bytes = 0;
      // Never stage more than this owner could ever be admitted for: an
      // over-quota account cannot spend the archive ceiling in staging bytes.
      const admissible = store.quotas.admissibleBytes(ownerId);
      const ceiling = Math.min(9 * 1024 ** 3, admissible ?? Number.MAX_VALUE);
      const bounded = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(
            bytes > ceiling
              ? new ProtocolError(
                  bytes > 9 * 1024 ** 3 ? "invalid_request" : "quota_exceeded",
                  bytes > 9 * 1024 ** 3
                    ? "Archive upload exceeds limit"
                    : "Archive upload exceeds the remaining storage quota",
                )
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(c.req.raw.body as any),
        bounded,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      let archive;
      try {
        archive = await openArchive(path, signal);
      } catch {
        signal.throwIfAborted();
        throw new ProtocolError("invalid_request", "Invalid recording archive");
      }
      try {
        const session = await store.importArchive(
          archive,
          ownerId,
          signal,
          importRequestId,
        );
        try {
          return c.json(
            {
              streamId: session.info.id,
              revision: session.info.revision,
              lifecycle: session.info.lifecycle,
            },
            201,
          );
        } finally {
          store.release(session);
        }
      } finally {
        await archive.close();
      }
    } catch (error) {
      // Report lost authorization rather than a generic abort/storage failure.
      signal.throwIfAborted();
      throw error;
    } finally {
      importing.close();
      activeImports--;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  let activeExports = 0;
  app.get("/api/v1/streams/:id/export", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    if (activeExports >= 2)
      throw new ProtocolError("retry_later", "Export capacity is busy");
    activeExports++;
    let directory: string | undefined;
    let transferred = false;
    const cleanup = async () => {
      activeExports--;
      if (directory) await rm(directory, { recursive: true, force: true });
    };
    try {
      directory = await mkdtemp(join(staging, "download-"));
      const info = await session.exportBoundary();
      const metadata: ArchiveMetadata = {
        format: "agentlive.recording",
        version: 1,
        protocolVersion: 1,
        reducerVersion: 1,
        exportedAt: new Date().toISOString(),
        recording: {
          ...(origin ? { serverOrigin: origin } : {}),
          streamId: info.id,
          revision: info.revision,
          title: info.title,
          createdAt: info.createdAt,
          throughServerSeq: info.serverSeq,
          timelineMs: info.timelineMs,
          lifecycle: info.lifecycle,
        },
        provenance: {
          ...(info.archiveOrigin ? { archiveOrigin: info.archiveOrigin } : {}),
          ...(info.migrationOrigin
            ? { migrationOrigin: info.migrationOrigin }
            : {}),
          agent: null,
          sourceVersion: null,
          adapterVersion: null,
          capabilities: [],
          completeness:
            info.lifecycle === "ended" ? "ended-recording" : "captured-prefix",
          gapCount: 0,
        },
      };
      const events = async function* () {
        for await (const event of session.history(0, info.serverSeq)) {
          if (event.content.kind === "session.started")
            metadata.provenance.agent = event.content.payload.agent;
          if (event.content.kind === "capture.gap")
            metadata.provenance.gapCount++;
          const notice = reduceCompletenessNotice(
            metadata.provenance.completenessNotice,
            event,
          );
          if (notice) metadata.provenance.completenessNotice = notice;
          else delete metadata.provenance.completenessNotice;
          yield event;
        }
      };
      const path = join(directory, "recording.agentlive");
      await writeArchive(
        path,
        metadata,
        events(),
        async (hash) => (await session.openAttachment(hash)).createReadStream(),
        c.get("transferSignal") ?? c.req.raw.signal,
      );
      const stream = createReadStream(path);
      stream.once("close", () => {
        void cleanup().catch(() => {});
      });
      transferred = true;
      c.header("Content-Type", "application/octet-stream");
      c.header(
        "Content-Disposition",
        'attachment; filename="recording.agentlive"',
      );
      return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
    } catch (error) {
      c.get("transferSignal")?.throwIfAborted();
      throw error;
    } finally {
      if (!transferred) await cleanup();
    }
  });
  app.get("/api/v1/public-recordings", async (c) => {
    const rawLimit = c.req.query("limit");
    if (rawLimit !== undefined && !/^[1-9][0-9]{0,2}$/.test(rawLimit))
      throw new ProtocolError("invalid_request", "Invalid listing limit");
    const after = c.req.query("after");
    return c.json(
      await store.listPublic({
        ...(after ? { after } : {}),
        ...(rawLimit ? { limit: Number(rawLimit) } : {}),
        signal: c.req.raw.signal,
      }),
    );
  });
  app.get("/api/v1/streams", async (c) => {
    const ownerId =
      c.get("accountId") ??
      (isOwner(token(c.req.header("authorization"))) ? "local" : undefined);
    if (!ownerId)
      throw new ProtocolError("unauthorized", "Owner authorization required");
    const rawLimit = c.req.query("limit");
    if (rawLimit !== undefined && !/^[1-9][0-9]{0,2}$/.test(rawLimit))
      throw new ProtocolError("invalid_request", "Invalid listing limit");
    const after = c.req.query("after");
    return c.json(
      await store.list({
        ownerId,
        ...(after === undefined ? {} : { after }),
        ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
      }),
    );
  });
  app.post("/api/v1/streams", async (c) => {
    const ownerId =
      c.get("accountId") ??
      (isOwner(token(c.req.header("authorization"))) ? "local" : undefined);
    if (!ownerId)
      throw new ProtocolError("unauthorized", "Owner authorization required");
    const input = createSessionSchema
      .omit({ ownerId: true })
      .parse(await boundedJson(c.req.raw));
    const session = await store.create({ ...input, ownerId });
    try {
      return c.json(
        { streamId: session.info.id, revision: session.info.revision },
        201,
      );
    } finally {
      store.release(session);
    }
  });
  app.post("/api/v1/streams/:id/reports", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    const input = reportInputSchema.parse(await boundedJson(c.req.raw, 8192));
    return c.json(
      await store.reports.submit(
        input,
        session.info.id,
        session.info.revision,
        c.get("accountId"),
      ),
      201,
    );
  });
  // Operator-only online backup to a new server-host directory (admin-backup.ts).
  const backups = adminBackups({
    server: store,
    ownerSecret: options.ownerSecret,
    isOwner,
  });
  app.post("/api/v1/admin/backup", (c) => backups.handle(c.req.raw));
  if (options.metrics) {
    const tokenHash =
      metricsToken === undefined ? undefined : digest(metricsToken);
    app.get("/metrics", (c) => {
      const secret = token(c.req.header("authorization"));
      if (
        !isOwner(secret) &&
        !(tokenHash && secret && timingSafeEqual(digest(secret), tokenHash))
      ) {
        c.header("WWW-Authenticate", 'Bearer realm="agentlive-metrics"');
        throw new ProtocolError(
          "unauthorized",
          "Metrics authorization required",
        );
      }
      const totals = store.quotas.totals;
      const memory = process.memoryUsage();
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return c.body(
        renderMetrics({
          uptimeSeconds: metrics.uptimeSeconds,
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
          },
          recordings: {
            live: totals.recordings,
            open: totals.activeRecordings,
            removed: store.removedRecordings,
          },
          cachedSessions: store.cacheSize,
          cachedSessionCapacity: store.cacheCapacity,
          sockets: { ...metrics.sockets },
          websocketHandlerErrors: metrics.websocketHandlerErrors,
          httpInFlight: requests.size,
          transfers: transfers.size,
          imports: activeImports,
          exports: activeExports,
          storedBytes: totals.storedBytes,
          reservedBytes: totals.reservedBytes,
          maxStoredBytes: store.quotas.storageLimits.maxStoredBytes,
          freeSpace: store.quotas.freeSpace?.status,
          accountLimits: store.quotas.publicLimits,
          accounts: totals.accounts,
          quotaRejections: totals.rejections,
          snapshots: store.snapshotStatus,
          delivery: overload.state,
          backupsInProgress: backups.active,
          writeBarrierPaused: store.barrier.paused,
          requests: metrics.requests,
        }),
      );
    });
  }
  const operatorAccounts = (secret: string) => {
    if (!isOwner(secret))
      throw new ProtocolError(
        "unauthorized",
        "Operator authorization required",
      );
    if (!accounts)
      throw new ProtocolError("stream_gone", "Hosted accounts are not enabled");
    return accounts;
  };
  app.get("/api/v1/admin/accounts", (c) => {
    const after = c.req.query("after");
    if (after !== undefined) z.uuid().parse(after);
    const page = operatorAccounts(token(c.req.header("authorization"))).list(
      after,
      integer(c.req.query("limit"), 50),
    );
    return c.json({
      accounts: page.accounts.map((account) => ({
        ...account,
        usage: store.quotas.usage(account.id),
      })),
      nextAfter: page.nextAfter,
      limits: store.quotas.publicLimits,
    });
  });
  // The signed-in account's own usage (browser session or device credential).
  app.get("/api/v1/account/usage", (c) => {
    if (!accounts)
      throw new ProtocolError("stream_gone", "Hosted accounts are not enabled");
    const accountId = c.get("accountId");
    if (accountId === undefined)
      throw new ProtocolError("unauthorized", "Account authorization required");
    return c.json({
      accountId,
      usage: store.quotas.usage(accountId),
      limits: store.quotas.publicLimits,
    });
  });
  app.post("/api/v1/admin/accounts/:id/status", async (c) => {
    const target = operatorAccounts(token(c.req.header("authorization")));
    const id = z.uuid().parse(c.req.param("id"));
    const input = z
      .strictObject({
        disabled: z.boolean(),
        expectedVersion: z.number().int().positive().safe(),
      })
      .parse(await boundedJson(c.req.raw, 4096));
    // Disabling notifies the transfer registry and open sockets via onStatusChange.
    return c.json(
      await target.setDisabled(id, input.expectedVersion, input.disabled),
    );
  });
  app.get("/api/v1/reports", async (c) => {
    if (!isOwner(token(c.req.header("authorization"))))
      throw new ProtocolError(
        "unauthorized",
        "Operator authorization required",
      );
    return c.json(
      await store.reports.list(
        c.req.query("after"),
        integer(c.req.query("limit"), 50),
      ),
    );
  });
  app.post("/api/v1/reports/:id/decision", async (c) => {
    if (!isOwner(token(c.req.header("authorization"))))
      throw new ProtocolError(
        "unauthorized",
        "Operator authorization required",
      );
    const input = reportDecisionSchema.parse(
      await boundedJson(c.req.raw, 8192),
    );
    return c.json(
      await store.reports.decide(c.req.param("id"), input, (removal) =>
        store.remove({ ...removal, operator: true }),
      ),
    );
  });
  // Separate from stream-loading middleware so durable removal retries work.
  app.post("/api/v1/recordings/:id/removal", async (c) => {
    const input = z
      .strictObject({
        revision: idSchema,
        operationId: idSchema,
        expectedServerSeq: z.number().int().nonnegative().safe().optional(),
      })
      .parse(await boundedJson(c.req.raw, 4096));
    return c.json(
      await store.remove({
        id: c.req.param("id"),
        ...input,
        ...(c.get("accountId") !== undefined
          ? { ownerId: c.get("accountId")! }
          : {}),
        operator: isOwner(token(c.req.header("authorization"))),
      }),
    );
  });
  app.post("/api/v1/streams/:id/migration-origin", async (c) => {
    const session = c.get("session");
    const operator = isOwner(token(c.req.header("authorization")));
    const accountId = c.get("accountId");
    if (
      !operator &&
      !(accountId !== undefined && accountId === session.info.ownerId)
    )
      throw new ProtocolError(
        "unauthorized",
        "Recording owner authorization required",
      );
    const input = z
      .strictObject({ revision: idSchema, origin: migrationOriginSchema })
      .parse(await boundedJson(c.req.raw, 4096));
    // Validate the source before entering the target queue; opposite lineage requests
    // must not hold one session queue while waiting for the other.
    if (input.origin.externalSource?.serverOrigin === origin)
      throw new ProtocolError(
        "invalid_request",
        "Use local lineage for this server origin",
      );
    if (!session.info.migrationOrigin && !input.origin.externalSource) {
      const source = await store.get(input.origin.sourceStreamId);
      try {
        if (!operator && source.info.ownerId !== accountId)
          throw new ProtocolError(
            "unauthorized",
            "Source recording owner authorization required",
          );
        const boundary = await source.exportBoundary();
        if (
          boundary.revision !== input.origin.sourceRevision ||
          boundary.lifecycle !== "ended"
        )
          throw new ProtocolError(
            "precondition_failed",
            "Migration source revision or lifecycle changed",
          );
      } finally {
        store.release(source);
      }
    }
    const savedOrigin = await session.setMigrationOrigin(
      input.revision,
      input.origin,
    );
    return c.json({ revision: session.info.revision, origin: savedOrigin });
  });
  app.get("/api/v1/streams/:id/visibility", (c) => {
    const session = c.get("session");
    if (
      !isOwner(token(c.req.header("authorization"))) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === session.info.ownerId
      )
    )
      throw new ProtocolError(
        "unauthorized",
        "Recording owner authorization required",
      );
    return c.json(session.visibilityState);
  });
  app.post("/api/v1/streams/:id/visibility", async (c) => {
    const session = c.get("session");
    if (
      !isOwner(token(c.req.header("authorization"))) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === session.info.ownerId
      )
    )
      throw new ProtocolError(
        "unauthorized",
        "Recording owner authorization required",
      );
    const input = z
      .strictObject({
        revision: idSchema,
        operationId: idSchema,
        expectedVersion: z.number().int().nonnegative().safe(),
        visibility: z.enum(["public", "unlisted", "private"]),
      })
      .parse(await boundedJson(c.req.raw, 4096));
    const changed = await session.changeVisibility(input);
    revalidateTransfers();
    return c.json(changed);
  });
  app.get("/api/v1/streams/:id/publisher-credential", (c) => {
    if (
      !isOwner(token(c.req.header("authorization"))) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === c.get("session").info.ownerId
      )
    )
      throw new ProtocolError("unauthorized", "Owner authorization required");
    return c.json(c.get("session").publisherCredentialState);
  });
  app.post("/api/v1/streams/:id/publisher-credential", async (c) => {
    if (
      !isOwner(token(c.req.header("authorization"))) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === c.get("session").info.ownerId
      )
    )
      throw new ProtocolError("unauthorized", "Owner authorization required");
    const input = z
      .strictObject({
        operationId: z.string(),
        revision: z.string(),
        expectedVersion: z.number().int().nonnegative().safe(),
        replacementSecret: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .parse(await boundedJson(c.req.raw, 4096));
    const changed = await c.get("session").changePublisherCredential(input);
    revalidateTransfers();
    return c.json(changed);
  });
  const manageGrants = (
    session: RecordingSession,
    secret: string,
    accountId?: string,
  ) => {
    if (
      !isOwner(secret) &&
      !(accountId !== undefined && session.info.ownerId === accountId)
    )
      session.authorize(secret);
  };
  app.post("/api/v1/streams/:id/viewing-grants", async (c) => {
    const session = c.get("session");
    manageGrants(
      session,
      token(c.req.header("authorization")),
      c.get("accountId"),
    );
    const input = z
      .strictObject({
        label: z.string().max(200),
        expiresAt: z.number().int().nonnegative().safe(),
      })
      .parse(await boundedJson(c.req.raw, 4096));
    return c.json(
      await grants.issue({
        ...input,
        streamId: session.info.id,
        revision: session.info.revision,
      }),
      201,
    );
  });
  app.get("/api/v1/streams/:id/viewing-grants", (c) => {
    const session = c.get("session");
    manageGrants(
      session,
      token(c.req.header("authorization")),
      c.get("accountId"),
    );
    return c.json({ grants: grants.list(session.info.id) });
  });
  app.delete("/api/v1/streams/:id/viewing-grants/:grantId", async (c) => {
    const session = c.get("session");
    manageGrants(
      session,
      token(c.req.header("authorization")),
      c.get("accountId"),
    );
    return c.json({
      revoked: await grants.revoke(session.info.id, c.req.param("grantId")),
    });
  });
  app.get("/api/v1/streams/:id/publisher-state", (c) => {
    const session = c.get("session");
    session.authorize(token(c.req.header("authorization")));
    const { revision, publisherId, producerEpoch, serverSeq } = session.info;
    // Content-free: an event sequence and a reducer code. A publisher that emitted an
    // unreducible event learns it here instead of from a stalled viewer.
    const snapshotBlocked = session.snapshotBlocked;
    return c.json({
      revision,
      publisherId,
      producerEpoch,
      serverSeq,
      ...(snapshotBlocked ? { snapshotBlocked } : {}),
    });
  });
  app.get("/api/v1/streams/:id", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
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
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
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
    const transferSignal = c.get("transferSignal") ?? c.req.raw.signal;
    for await (const event of session.history(after, through)) {
      transferSignal.throwIfAborted();
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
  app.post("/api/v1/streams/:id/snapshots", async (c) => {
    const session = c.get("session");
    const secret = token(c.req.header("authorization"));
    if (
      !isOwner(secret) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === session.info.ownerId
      )
    )
      session.authorize(secret);
    const input = z
      .strictObject({
        revision: idSchema,
        throughServerSeq: z.number().int().nonnegative().safe(),
      })
      .parse(await boundedJson(c.req.raw));
    if (input.revision !== session.info.revision)
      throw new ProtocolError("revision_changed", "Snapshot revision changed");
    const snapshot = await session.buildSnapshot(
      input.throughServerSeq,
      c.req.raw.signal,
    );
    return c.json(
      { streamId: session.info.id, revision: session.info.revision, snapshot },
      201,
    );
  });
  app.get("/api/v1/streams/:id/snapshots", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    if (c.req.query("revision") !== session.info.revision)
      throw new ProtocolError("revision_changed", "Snapshot revision changed");
    const snapshot = await session.selectSnapshot(
      integer(c.req.query("throughServerSeq")),
      c.get("transferSignal") ?? c.req.raw.signal,
      c.req.query("timelineMs") === undefined
        ? undefined
        : z.coerce
            .number()
            .finite()
            .nonnegative()
            .parse(c.req.query("timelineMs")),
    );
    return c.json({
      streamId: session.info.id,
      revision: session.info.revision,
      snapshot,
    });
  });
  app.post("/api/v1/streams/:id/snapshot-leases", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    const input = z
      .strictObject({
        revision: idSchema,
        throughServerSeq: z.number().int().nonnegative().safe(),
        timelineMs: z.number().finite().nonnegative().optional(),
      })
      .parse(await boundedJson(c.req.raw));
    if (input.revision !== session.info.revision)
      throw new ProtocolError(
        "revision_changed",
        "Snapshot lease revision changed",
      );
    const lease = await session.selectSnapshotLeased(
      input.throughServerSeq,
      c.req.raw.signal,
      input.timelineMs,
    );
    return c.json(
      { streamId: session.info.id, revision: session.info.revision, lease },
      201,
    );
  });
  app.post("/api/v1/streams/:id/snapshot-leases/:lease/renew", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    const input = z
      .strictObject({ revision: idSchema })
      .parse(await boundedJson(c.req.raw));
    if (input.revision !== session.info.revision)
      throw new ProtocolError(
        "revision_changed",
        "Snapshot lease revision changed",
      );
    const lease = await session.renewSnapshotLease(
      snapshotLeaseTokenSchema.parse(c.req.param("lease")),
      c.req.raw.signal,
    );
    return c.json({
      streamId: session.info.id,
      revision: session.info.revision,
      lease,
    });
  });
  app.delete("/api/v1/streams/:id/snapshot-leases/:lease", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    if (c.req.query("revision") !== session.info.revision)
      throw new ProtocolError(
        "revision_changed",
        "Snapshot lease revision changed",
      );
    await session.releaseSnapshotLease(
      snapshotLeaseTokenSchema.parse(c.req.param("lease")),
      c.req.raw.signal,
    );
    return c.body(null, 204);
  });
  app.get("/api/v1/streams/:id/snapshot-blobs/:hash", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    if (c.req.query("revision") !== session.info.revision)
      throw new ProtocolError(
        "revision_changed",
        "Snapshot blob revision changed",
      );
    const ref = {
      hash: hashSchema.parse(c.req.param("hash")),
      byteSize: integer(c.req.query("byteSize")),
      units: integer(c.req.query("units")),
    };
    if (ref.byteSize < 1 || ref.byteSize > 1048576 || ref.units > 67108864)
      throw new ProtocolError(
        "invalid_request",
        "Invalid snapshot blob reference",
      );
    const bytes = await session.readSnapshotBlob(
      ref,
      c.get("transferSignal") ?? c.req.raw.signal,
      c.req.query("lease"),
    );
    return c.json({ base64: bytes.toString("base64") });
  });
  app.get("/api/v1/streams/:id/snapshot-content/:hash", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
    if (c.req.query("revision") !== session.info.revision)
      throw new ProtocolError(
        "revision_changed",
        "Snapshot content revision changed",
      );
    const ref = {
      hash: hashSchema.parse(c.req.param("hash")),
      byteSize: integer(c.req.query("byteSize")),
      units: integer(c.req.query("units")),
    };
    const offset = integer(c.req.query("offset")),
      length = integer(c.req.query("length"));
    if (
      ref.byteSize < 1 ||
      ref.byteSize > 1048576 ||
      ref.units > 67108864 ||
      length > 65536 ||
      offset > ref.units ||
      length > ref.units - offset
    )
      throw new ProtocolError(
        "invalid_request",
        "Invalid snapshot content range",
      );
    const text = await session.readSnapshotContent(
      ref,
      offset,
      length,
      c.get("transferSignal") ?? c.req.raw.signal,
      c.req.query("lease"),
    );
    // JSON preserves exact UTF-16 units, including slices through a surrogate pair.
    return c.json({ text });
  });
  app.post("/api/v1/streams/:id/attachments", async (c) => {
    const session = c.get("session");
    const secret = token(c.req.header("authorization"));
    session.authorize(secret);
    const descriptor = {
      hash: hashSchema.parse(c.req.header("x-attachment-sha256")),
      byteSize: integer(c.req.header("x-attachment-bytes")),
    };
    if (!c.req.raw.body && descriptor.byteSize !== 0)
      throw new ProtocolError("invalid_request", "Missing upload body");
    const source = c.req.raw.body
      ? Readable.fromWeb(
          c.req.raw
            .body as import("node:stream/web").ReadableStream<Uint8Array>,
        )
      : Readable.from([]);
    // Rotation/revocation of the publisher credential aborts staging promptly;
    // installation independently rechecks the credential.
    const upload = transfers.register(() => {
      try {
        session.authorize(secret);
        return true;
      } catch {
        return false;
      }
    }, c.req.raw.signal);
    try {
      const uploaded = await session.uploadAttachment(
        secret,
        descriptor,
        source,
        upload.signal,
      );
      return c.json(uploaded, 201);
    } finally {
      upload.close();
      source.destroy();
    }
  });
  app.get("/api/v1/streams/:id/attachments/:hash/status", async (c) => {
    const session = c.get("session");
    const available = await session.attachmentStatus(
      token(c.req.header("authorization")),
      { hash: c.req.param("hash"), byteSize: integer(c.req.query("byteSize")) },
    );
    return c.json({ available });
  });
  app.get("/api/v1/streams/:id/attachments/:hash", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
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
      const session = c.get("session");
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
  app.post("/api/v1/streams/:id/share", async (c) => {
    if (
      !isOwner(token(c.req.header("authorization"))) &&
      !(
        c.get("accountId") !== undefined &&
        c.get("accountId") === c.get("session").info.ownerId
      )
    )
      throw new ProtocolError(
        "unauthorized",
        "Sharing an import requires owner authorization",
      );
    const input = z
      .strictObject({ visibility: z.enum(["public", "unlisted", "private"]) })
      .parse(await boundedJson(c.req.raw));
    const session = c.get("session");
    await session.shareEnded(input.visibility);
    revalidateTransfers();
    return c.json({ visibility: session.info.visibility });
  });
  app.post("/api/v1/streams/:id/watch-ticket", async (c) => {
    const session = c.get("session");
    readable(session, token(c.req.header("authorization")), c.get("accountId"));
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
      ...(c.get("accountId") && !c.req.header("authorization")
        ? { accountCookie: getCookie(c, "__Host-agentlive-session")! }
        : {}),
      ...(token(c.req.header("authorization"))
        ? { grantToken: token(c.req.header("authorization")) }
        : {}),
    });
    return c.json({ ticket, expiresInMs: 60_000 });
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 300 * 1024,
    perMessageDeflate: false,
  });
  // Bytes the process has queued but not yet written: one slow socket is shed by
  // `socketLimit`, many sockets each just under it are only visible in the sum.
  overload.observeBuffered(() => {
    let total = 0;
    for (const client of wss.clients) total += client.bufferedAmount;
    return total;
  });
  function connection(
    publishing: boolean,
    secret: string,
    ticketStream: string | undefined,
    accountCookie?: string,
  ) {
    let socket: WSContext<WebSocketLike> | undefined;
    let session: RecordingSession | undefined;
    let lease: Lease | undefined;
    let unsubscribe: (() => void) | undefined;
    let queue: Promise<void> = Promise.resolve();
    let queued = 0;
    let ended = false;
    let lastSeen = Date.now();
    let viewing: ReturnType<ViewingGrants["acquire"]> | undefined;
    let cancelViewing: (() => void) | undefined;
    let accountActive: (() => boolean) | undefined;
    let authorizeView: (() => void) | undefined;
    /** Set once a publisher holds a lease; throws when the owning account is disabled. */
    let authorizePublish: (() => void) | undefined;
    const role = publishing ? "publisher" : "viewer";
    let counted = false;

    const recheck = () => {
      if (ended || !socket) return;
      try {
        authorizeView?.();
        authorizePublish?.();
      } catch {
        cleanup();
        socket.close(
          1008,
          publishing
            ? "Publishing authorization ended"
            : "Viewing authorization ended",
        );
        return;
      }
      if (accountActive && !accountActive()) {
        cleanup();
        socket.close(1008, "Account viewing authorization ended");
      }
    };
    socketChecks.add(recheck);
    const send = (value: unknown) => {
      try {
        authorizeView?.();
      } catch {
        cleanup();
        socket?.close(1008, "Viewing authorization ended");
        return;
      }
      if (accountActive && !accountActive()) {
        cleanup();
        socket?.close(1008, "Account viewing authorization ended");
        return;
      }
      if (
        ended ||
        viewing?.signal.aborted ||
        !socket ||
        socket.readyState !== 1
      )
        return;
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
    const releaseSession = () => {
      authorizeView = undefined;
      authorizePublish = undefined;
      if (cancelViewing)
        viewing?.signal.removeEventListener("abort", cancelViewing);
      cancelViewing = undefined;
      viewing?.close();
      viewing = undefined;
      if (session) store.release(session);
      session = undefined;
      lease = undefined;
    };
    let drained: Promise<void> | undefined;
    const drain = (): Promise<void> => {
      if (drained) return drained;
      ended = true;
      socketChecks.delete(recheck);
      clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
      if (counted) {
        counted = false;
        metrics.sockets[role]--;
      }
      drained = queue.then(releaseSession, (error) => {
        releaseSession();
        throw error;
      });
      void drained.then(
        () => {
          connections.delete(drain);
        },
        (error) => {
          connectionErrors.push(error);
          connections.delete(drain);
        },
      );
      return drained;
    };
    connections.add(drain);
    const cleanup = () => {
      void drain();
    };
    return {
      onOpen(_event: Event, ws: WSContext<WebSocketLike>) {
        socket = ws;
        if (ended || closing) {
          ws.close(1001, "Server is closing");
          return;
        }
        counted = true;
        metrics.sockets[role]++;
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
        if (ended || closing) return;
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
            let acquired: RecordingSession | undefined;
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
                  const target = (acquired = await store.get(message.streamId));
                  const result = await target.resume(secret, message);
                  if (ended) return;
                  session = target;
                  acquired = undefined;
                  lease = result.lease;
                  authorizePublish = () => target.assertPublishable();
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
                  releaseSession();
                  send({ type: "unsubscribed", protocolVersion: 1, requestId });
                  return;
                }
                unsubscribe?.();
                unsubscribe = undefined;
                releaseSession();
                const target = (acquired = await store.get(message.streamId));
                const devicePrincipal =
                  accountSessions?.authenticateDevice(secret);
                if (devicePrincipal) accountActive = devicePrincipal.isActive;
                if (accountCookie) {
                  const principal =
                    await accountSessions?.authenticate(accountCookie);
                  if (!principal || ticketStream !== target.info.id)
                    throw new ProtocolError(
                      "unauthorized",
                      "Account viewing authorization expired",
                    );
                  readable(target, secret, principal.account.id);
                  authorizeView = () =>
                    readable(target, secret, principal.account.id);
                  accountActive = principal.isActive;
                } else {
                  if (ticketStream && ticketStream !== target.info.id)
                    throw new ProtocolError(
                      "unauthorized",
                      "Viewing ticket scope differs",
                    );
                  readable(target, secret);
                  authorizeView = () => readable(target, secret);
                }
                if (
                  grants.authorize(secret, target.info.id, target.info.revision)
                ) {
                  viewing = grants.acquire(
                    secret,
                    target.info.id,
                    target.info.revision,
                  );
                  cancelViewing = () => {
                    cleanup();
                    ws.close(1008, "Viewing authorization ended");
                  };
                  viewing.signal.addEventListener("abort", cancelViewing, {
                    once: true,
                  });
                }
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
                acquired = undefined;
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
            } finally {
              if (acquired) store.release(acquired);
            }
          })
          .finally(() => {
            queued--;
          });
        void queue.catch(cleanup);
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
        // Existing viewers keep their sockets: dropping them would turn a latency
        // problem into a reconnect storm. Publishers are never refused, because
        // durable capture is what a recording is for.
        if (!publishing && overload.refuseViewer())
          throw new ProtocolError(
            "retry_later",
            "Server is past its delivery capacity",
          );
        if (publishing && !token(c.req.header("authorization")))
          throw new ProtocolError(
            "unauthorized",
            "Publishing requires a credential",
          );
        await next();
      },
      upgradeWebSocket(
        (c) => {
          let ticketStream: string | undefined;
          let ticketSecret: string | undefined;
          let accountCookie: string | undefined;
          const value = c.req.query("ticket");
          if (value) {
            const ticket = tickets.get(value);
            tickets.delete(value);
            if (!ticket || ticket.expires < Date.now())
              throw new ProtocolError("unauthorized", "Viewing ticket expired");
            ticketStream = ticket.streamId;
            ticketSecret = ticket.grantToken;
            accountCookie = ticket.accountCookie;
          }
          return connection(
            publishing,
            ticketSecret ?? token(c.req.header("authorization")),
            ticketStream,
            accountCookie,
          );
        },
        {
          // The adapter's default prints the raw exception to stderr; count it
          // instead so no socket data can reach logs.
          onError: () => {
            metrics.websocketHandlerErrors++;
          },
        },
      ),
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
    await closeHosted();
    await grants.close();
    await store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listening address");
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  if (!origin) origin = url;
  let closePromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    const backupsClosed = backups.close();
    const grantsClosed = grants.close();
    cleanupPromise = (async () => {
      for (const client of wss.clients) client.terminate();
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if ("closeAllConnections" in server) server.closeAllConnections();
      const errors: unknown[] = [];
      try {
        await stopped;
      } catch (error) {
        errors.push(error);
      }
      while (requests.size) await Promise.all([...requests]);
      transfers.close();
      // An upgrade accepted before admission stopped may have completed during HTTP draining.
      for (const client of wss.clients) client.terminate();
      while (connections.size)
        await Promise.allSettled([...connections].map((drain) => drain()));
      errors.push(...connectionErrors);
      await backupsClosed;
      await grantsClosed;
      try {
        await closeHosted();
      } catch (error) {
        errors.push(error);
      }
      try {
        await store.close();
      } catch (error) {
        errors.push(error);
      }
      overload.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (errors.length)
        throw new AggregateError(errors, "Server shutdown failed");
    })();
    closePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ShutdownTimeoutError(shutdownTimeoutMs)),
        shutdownTimeoutMs,
      );
      // Keep the deadline alive even when the stalled work owns no event-loop handles.
      // Both handlers remain attached after timeout, observing late cleanup failures.
      cleanupPromise!.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    return closePromise;
  }
  return {
    url,
    store,
    /** Diagnostic count of registered revocable transfers (0 when idle). */
    get activeTransfers() {
      return transfers.size;
    },
    /** Measured fan-out capacity state; also what `/readyz` and `/metrics` report. */
    overload,
    close,
    /** Starts shutdown if necessary; waits without a deadline for actual cleanup. */
    whenClosed() {
      void close().catch(() => {});
      return cleanupPromise!;
    },
  };
}
