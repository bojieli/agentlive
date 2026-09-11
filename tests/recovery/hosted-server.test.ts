import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startServer,
  type ServerOptions,
} from "../../packages/server/src/http.js";

it("mounts hosted login over actual HTTP, enforces origin and callback cookies, and releases state on shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-hosted-http-"));
  const issuer = "https://id.example";
  const options: ServerOptions = {
    directory: root,
    ownerSecret: "a".repeat(64),
    port: 0,
    publicOrigin: "https://app.example",
    hosted: {
      issuer,
      clientId: "client",
      clientSecret: "secret",
      cookiePassword: "p".repeat(64),
      fetch: async () =>
        Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
    },
  };
  let server = await startServer(options);
  try {
    expect(
      await (await fetch(server.url + "/api/v1/auth-config")).json(),
    ).toEqual({ mode: "hosted" });
    const started = await fetch(server.url + "/auth/login", {
      redirect: "manual",
    });
    expect(started.status).toBe(303);
    const target = new URL(started.headers.get("location")!);
    expect(target.origin).toBe(issuer);
    expect(target.searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/callback",
    );
    expect(started.headers.get("set-cookie")).toContain(
      "__Host-agentlive-login=",
    );
    expect(started.headers.get("set-cookie")).toContain("Secure");
    expect((await fetch(server.url + "/auth/session")).status).toBe(401);
    expect(
      (await fetch(server.url + "/auth/callback?state=bad&code=bad")).status,
    ).toBe(401);
    expect(
      (await fetch(server.url + "/auth/logout", { method: "POST" })).status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url + "/auth/logout", {
          method: "POST",
          headers: { origin: "https://app.example" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(server.url + "/auth/login", {
          headers: { origin: "https://evil.example" },
          redirect: "manual",
        })
      ).status,
    ).toBe(403);
    await server.close();
    server = await startServer(options);
    expect((await fetch(server.url + "/auth/session")).status).toBe(401);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cleans up account/session ownership on discovery failure and requires HTTPS configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-hosted-startup-"));
  const basic = { directory: root, ownerSecret: "a".repeat(64), port: 0 };
  const hosted = {
    issuer: "https://id.example",
    clientId: "client",
    clientSecret: "secret",
    cookiePassword: "p".repeat(64),
    fetch: async () => {
      throw new Error("provider unavailable");
    },
  };
  try {
    await expect(startServer({ ...basic, hosted })).rejects.toThrow(
      "HTTPS publicOrigin",
    );
    await expect(
      startServer({ ...basic, hosted, publicOrigin: "https://app.example" }),
    ).rejects.toThrow();
    const server = await startServer(basic);
    try {
      expect(
        await (await fetch(server.url + "/api/v1/auth-config")).json(),
      ).toEqual({ mode: "standalone" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
