import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { AccountSessions } from "./account-sessions.js";
import { OidcLogin } from "./oidc-login.js";
import { DeviceLinks } from "./device-links.js";
import { z } from "zod";

const sessionCookie = "__Host-agentlive-session";
const attemptCookie = "__Host-agentlive-login";
const attributes = {
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
};

/** Mount at /auth only in explicitly configured hosted mode. */
export function hostedAuth(options: {
  origin: string;
  login: OidcLogin;
  sessions: AccountSessions;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin)
    throw new Error("Hosted authentication requires an HTTPS origin");
  const app = new Hono();
  const devices = new DeviceLinks(options.sessions);
  const body = async (request: Request) => {
    if (!request.body) throw new Error("Missing request body");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 4096) throw new Error("Request too large");
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    const supplied = c.req.header("origin");
    if (supplied && supplied !== options.origin)
      return c.json({ error: "Origin is not allowed" }, 403);
    await next();
  });
  app.get("/login", async (c) => {
    if (c.req.header("sec-fetch-site") === "cross-site")
      return c.json({ error: "Start login from this site" }, 403);
    const attempt = await options.login.begin();
    setCookie(c, attemptCookie, attempt.cookie, {
      ...attributes,
      maxAge: attempt.maxAge,
    });
    return c.redirect(attempt.url, 303);
  });
  app.post("/device/start", (c) =>
    c.json(
      { ...devices.begin(), verificationUri: options.origin + "/?device=1" },
      201,
    ),
  );
  app.post("/device/poll", async (c) => {
    const input = z
      .strictObject({ deviceCode: z.string().max(64) })
      .parse(await body(c.req.raw));
    return c.json(devices.poll(input.deviceCode));
  });
  app.post("/device/decide", async (c) => {
    const cookie = getCookie(c, sessionCookie);
    const principal = cookie
      ? await options.sessions.authenticate(cookie)
      : undefined;
    if (!principal)
      return c.json({ error: "Sign in before linking a device" }, 401);
    if (
      c.req.header("origin") !== options.origin ||
      !AccountSessions.validCsrf(principal.csrf, c.req.header("x-csrf-token"))
    )
      return c.json({ error: "Invalid CSRF authorization" }, 403);
    const input = z
      .strictObject({ userCode: z.string().max(32), approve: z.boolean() })
      .parse(await body(c.req.raw));
    await devices.decide(input.userCode, cookie!, input.approve);
    return c.json({ decided: true });
  });
  app.post("/device/revoke", async (c) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!options.sessions.authenticateDevice(token))
      return c.json({ error: "Invalid device credential" }, 401);
    return c.json({ revoked: await options.sessions.revokeDevice(token) });
  });
  app.get("/devices", async (c) => {
    const cookie = getCookie(c, sessionCookie);
    const principal = cookie
      ? await options.sessions.authenticate(cookie)
      : undefined;
    if (!principal) return c.json({ error: "Sign in to manage devices" }, 401);
    return c.json({
      devices: await options.sessions.listDevices(principal.account.id),
    });
  });
  app.post("/devices/revoke", async (c) => {
    const cookie = getCookie(c, sessionCookie);
    const principal = cookie
      ? await options.sessions.authenticate(cookie)
      : undefined;
    if (!principal) return c.json({ error: "Sign in to manage devices" }, 401);
    if (
      c.req.header("origin") !== options.origin ||
      !AccountSessions.validCsrf(principal.csrf, c.req.header("x-csrf-token"))
    )
      return c.json({ error: "Invalid CSRF authorization" }, 403);
    const input = z
      .strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/) })
      .parse(await body(c.req.raw));
    return c.json({
      revoked: await options.sessions.revokeAccountDevice(
        principal.account.id,
        input.id,
      ),
    });
  });
  app.get("/callback", async (c) => {
    const attempt = getCookie(c, attemptCookie);
    deleteCookie(c, attemptCookie, attributes);
    if (!attempt) return c.json({ error: "Start a new login attempt" }, 401);
    // The externally configured origin is authoritative behind a TLS proxy.
    const callback = new URL("/auth/callback", options.origin);
    callback.search = new URL(c.req.url).search;
    try {
      const account = await options.login.complete(callback, attempt);
      const previous = getCookie(c, sessionCookie);
      if (previous) await options.sessions.revoke(previous);
      const session = await options.sessions.issue(account.id);
      setCookie(c, sessionCookie, session.cookie, {
        ...attributes,
        maxAge: session.maxAge,
      });
      return c.redirect("/", 303);
    } catch {
      return c.json(
        { error: "Login could not be completed; start a new login attempt" },
        401,
      );
    }
  });
  app.get("/session", async (c) => {
    const cookie = getCookie(c, sessionCookie);
    const session = cookie && (await options.sessions.authenticate(cookie));
    if (!session) return c.json({ authenticated: false }, 401);
    return c.json({
      authenticated: true,
      account: {
        id: session.account.id,
        displayName: session.account.displayName,
      },
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    });
  });
  app.post("/logout", async (c) => {
    if (c.req.header("origin") !== options.origin)
      return c.json({ error: "Same-origin logout required" }, 403);
    const cookie = getCookie(c, sessionCookie);
    const session = cookie && (await options.sessions.authenticate(cookie));
    if (
      session &&
      !AccountSessions.validCsrf(session.csrf, c.req.header("x-csrf-token"))
    )
      return c.json({ error: "Invalid CSRF token" }, 403);
    if (cookie) await options.sessions.revoke(cookie);
    deleteCookie(c, sessionCookie, attributes);
    return c.json({ authenticated: false });
  });
  app.onError((_error, c) =>
    c.json({ error: "Authentication service unavailable" }, 503),
  );
  return app;
}
