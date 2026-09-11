import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { OidcLogin } from "../../packages/server/src/oidc-login.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import { hostedAuth } from "../../packages/server/src/hosted-auth.js";

it("validates signed OIDC code flow, PKCE, state, nonce, audience, expiry and single-use sealed attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-oidc-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "sessions.json"),
    accounts,
    "s".repeat(64),
  );
  const issuer = "https://id.example",
    redirectUri = "https://app.example/auth/callback";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  let authorization: URL;
  let mode = "valid",
    exchanges = 0;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  try {
    const login = await OidcLogin.discover({
      issuer,
      clientId: "client",
      clientSecret: "client-secret",
      redirectUri,
      cookiePassword: "p".repeat(64),
      accounts,
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.pathname === "/.well-known/openid-configuration")
          return Response.json({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            jwks_uri: issuer + "/jwks",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
        if (url.pathname !== "/token")
          throw new Error("Unexpected OIDC request");
        exchanges++;
        const body = new URLSearchParams(String(init.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(redirectUri);
        expect(
          createHash("sha256")
            .update(body.get("code_verifier")!)
            .digest("base64url"),
        ).toBe(authorization.searchParams.get("code_challenge"));
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: mode === "issuer" ? "https://wrong.example" : issuer,
          sub: "subject",
          aud: mode === "audience" ? "other" : "client",
          iat: now - 1,
          exp: mode === "expiry" ? now - 3600 : now + 300,
          nonce:
            mode === "nonce"
              ? "wrong"
              : authorization.searchParams.get("nonce"),
          name: "Test account",
        };
        const unsigned =
          encode({ alg: "RS256", kid: "test" }) + "." + encode(claims);
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(unsigned),
          keys.privateKey,
        ).toString("base64url");
        const idToken =
          unsigned +
          "." +
          (mode === "signature"
            ? (signature[0] === "a" ? "b" : "a") + signature.slice(1)
            : signature);
        return Response.json({
          access_token: "provider-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
      },
    });
    const begin = async () => {
      const started = await login.begin();
      authorization = new URL(started.url);
      expect(authorization.searchParams.get("scope")).toBe("openid profile");
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(started.cookie).not.toContain("verifier");
      const callback = new URL(redirectUri);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      callback.searchParams.set("code", "synthetic-code");
      return { ...started, callback };
    };
    const first = await begin();
    const account = await login.complete(first.callback, first.cookie);
    expect(account.displayName).toBe("Test account");
    expect(exchanges).toBe(1);
    await expect(login.complete(first.callback, first.cookie)).rejects.toThrow(
      "start a new login",
    );
    expect(exchanges).toBe(1);
    for (mode of ["nonce", "audience", "issuer", "expiry", "signature"]) {
      const attempt = await begin();
      await expect(
        login.complete(attempt.callback, attempt.cookie),
      ).rejects.toThrow("start a new login");
    }
    mode = "valid";
    const attempt = await begin();
    const wrongState = new URL(attempt.callback);
    wrongState.searchParams.set("state", "wrong");
    const before = exchanges;
    await expect(login.complete(wrongState, attempt.cookie)).rejects.toThrow();
    await expect(
      login.complete(attempt.callback, "tampered" + attempt.cookie),
    ).rejects.toThrow();
    expect(exchanges).toBe(before);
    const wrongOrigin = new URL(attempt.callback);
    wrongOrigin.hostname = "other.example";
    await expect(login.complete(wrongOrigin, attempt.cookie)).rejects.toThrow();
    expect(exchanges).toBe(before);
    expect((await login.complete(attempt.callback, attempt.cookie)).id).toBe(
      account.id,
    );
    const expired = await begin();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    const beforeExpiry = exchanges;
    try {
      await expect(
        login.complete(expired.callback, expired.cookie),
      ).rejects.toThrow();
      expect(exchanges).toBe(beforeExpiry);
    } finally {
      clock.mockRestore();
    }
    const auth = hostedAuth({ origin: "https://app.example", login, sessions });
    const started = await auth.request("https://app.example/login");
    expect(started.status).toBe(303);
    authorization = new URL(started.headers.get("location")!);
    const loginCookie = started.headers.get("set-cookie")!;
    expect(loginCookie).toContain("HttpOnly");
    expect(loginCookie).toContain("Secure");
    expect(loginCookie).toContain("SameSite=Lax");
    const callback = new URL("https://app.example/callback");
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("code", "synthetic-code");
    const completed = await auth.request(callback.href, {
      headers: { cookie: loginCookie.split(";")[0]! },
    });
    expect(completed.status).toBe(303);
    const sessionHeader = completed.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agentlive-session="))!;
    expect(sessionHeader).toContain("HttpOnly");
    const cookie = sessionHeader.split(";")[0]!;
    const current = await auth.request("https://app.example/session", {
      headers: { cookie },
    });
    expect(current.status).toBe(200);
    const currentBody = await current.json();
    expect(currentBody.account.id).toBe(account.id);
    expect(current.headers.get("cache-control")).toBe("no-store");
    const logout = (origin?: string, csrf?: string) =>
      auth.request("https://app.example/logout", {
        method: "POST",
        headers: {
          cookie,
          ...(origin ? { origin } : {}),
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
      });
    expect((await logout()).status).toBe(403);
    expect(
      (await logout("https://evil.example", currentBody.csrf)).status,
    ).toBe(403);
    expect((await logout("https://app.example", "bad")).status).toBe(403);
    expect((await logout("https://app.example", currentBody.csrf)).status).toBe(
      200,
    );
    expect(
      (
        await auth.request("https://app.example/session", {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    await accounts.setDisabled(account.id, account.version, true);
    const disabled = await begin();
    await expect(
      login.complete(disabled.callback, disabled.cookie),
    ).rejects.toThrow();
  } finally {
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
