import * as oidc from "openid-client";
import { sealData, unsealData } from "iron-session";
import { z } from "zod";
import { Accounts } from "./accounts.js";

const attemptSchema = z.strictObject({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  expiresAt: z.number().int(),
  redirectUri: z.string(),
});
/** OIDC protocol validation and sealed login attempts; HTTP cookie/session wiring is separate. */
export class OidcLogin {
  private attempts = new Map<string, number>();
  private constructor(
    private config: oidc.Configuration,
    private options: {
      redirectUri: string;
      cookiePassword: string;
      accounts: Accounts;
    },
  ) {}
  static async discover(options: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    cookiePassword: string;
    accounts: Accounts;
    fetch?: oidc.CustomFetch;
  }) {
    for (const value of [options.issuer, options.redirectUri]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Hosted login requires HTTPS issuer and callback URLs without query or fragment",
        );
    }
    if (
      !options.clientId ||
      !options.clientSecret ||
      options.cookiePassword.length < 32
    )
      throw new Error("Hosted login configuration is incomplete");
    const config = await oidc.discovery(
      new URL(options.issuer),
      options.clientId,
      options.clientSecret,
      undefined,
      {
        timeout: 10,
        execute: [oidc.enableNonRepudiationChecks],
        ...(options.fetch ? { [oidc.customFetch]: options.fetch } : {}),
      },
    );
    if (config.serverMetadata().issuer !== options.issuer)
      throw new Error("OIDC issuer differs from configured issuer");
    return new OidcLogin(config, {
      redirectUri: options.redirectUri,
      cookiePassword: options.cookiePassword,
      accounts: options.accounts,
    });
  }
  async begin() {
    for (const [state, expiresAt] of this.attempts)
      if (expiresAt <= Date.now()) this.attempts.delete(state);
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    if (this.attempts.size >= 1024) throw new Error("Too many pending logins");
    const attempt = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier,
      expiresAt: Date.now() + 300000,
      redirectUri: this.options.redirectUri,
    };
    this.attempts.set(attempt.state, attempt.expiresAt);
    try {
      const cookie = await sealData(attempt, {
        password: this.options.cookiePassword,
        ttl: 300,
      });
      const url = oidc.buildAuthorizationUrl(this.config, {
        redirect_uri: attempt.redirectUri,
        scope: "openid profile",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: attempt.state,
        nonce: attempt.nonce,
      });
      return { url: url.href, cookie, maxAge: 300 };
    } catch (error) {
      this.attempts.delete(attempt.state);
      throw error;
    }
  }
  async complete(callback: URL, sealedAttempt: string) {
    try {
      if (sealedAttempt.length > 4096)
        throw new Error("Oversized login attempt");
      const attempt = attemptSchema.parse(
        await unsealData(sealedAttempt, {
          password: this.options.cookiePassword,
          ttl: 300,
        }),
      );
      const expected = new URL(this.options.redirectUri);
      if (
        callback.origin !== expected.origin ||
        callback.pathname !== expected.pathname ||
        callback.hash ||
        callback.username ||
        callback.password ||
        attempt.redirectUri !== this.options.redirectUri ||
        callback.searchParams.get("state") !== attempt.state
      )
        throw new Error("Login callback differs");
      const expiresAt = this.attempts.get(attempt.state);
      this.attempts.delete(attempt.state);
      if (
        !expiresAt ||
        expiresAt !== attempt.expiresAt ||
        expiresAt <= Date.now()
      )
        throw new Error("Login attempt expired or already used");
      const tokens = await oidc.authorizationCodeGrant(this.config, callback, {
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const identity = z
        .object({
          iss: z.string(),
          sub: z.string().min(1).max(255),
          name: z.string().min(1).max(200).optional(),
        })
        .parse(claims);
      return await this.options.accounts.resolveVerifiedIdentity({
        issuer: identity.iss,
        subject: identity.sub,
        displayName: identity.name ?? "Account",
      });
    } catch {
      // Provider failures may include codes, tokens, or personal claims.
      throw new Error(
        "Login could not be completed; start a new login attempt",
      );
    }
  }
}
