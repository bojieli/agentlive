import { expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  symlink,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountCredential,
  loginAccount,
  logoutAccount,
} from "../../packages/cli/src/account-login.js";

it("persists approved origin-bound credentials, refuses unsafe files and retains files on failed logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-login-"));
  const path = join(root, "account.json"),
    origin = "https://app.example",
    token = "ald1_" + "a".repeat(64);
  let polls = 0;
  const signal = new AbortController().signal;
  try {
    const result = await loginAccount({
      serverOrigin: origin,
      output: path,
      signal,
      prompt: (value) => {
        expect(value.verificationUri).toBe(origin + "/?device=1");
        expect(value).not.toHaveProperty("deviceCode");
      },
      fetch: async (url) => {
        if (String(url).endsWith("/start"))
          return Response.json({
            deviceCode: "b".repeat(64),
            userCode: "ABCDEF1234",
            verificationUri: origin + "/?device=1",
            expiresAt: Date.now() + 60000,
            intervalSeconds: 1,
          });
        if (++polls === 1) throw new TypeError("Lost polling response");
        return Response.json({
          status: "approved",
          token,
          expiresAt: Date.now() + 60000,
        });
      },
    });
    expect(result).not.toHaveProperty("token");
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await accountCredential(path, origin)).toBe(token);
    await expect(
      accountCredential(path, "https://other.example"),
    ).rejects.toThrow("another server origin");
    await expect(
      loginAccount({
        serverOrigin: origin,
        output: path,
        signal,
        prompt: () => {},
      }),
    ).rejects.toThrow("already exists");
    await expect(
      logoutAccount({
        serverOrigin: origin,
        path,
        signal,
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("file retained");
    expect(await accountCredential(path, origin)).toBe(token);
    await chmod(path, 0o644);
    await expect(accountCredential(path, origin)).rejects.toThrow("chmod 600");
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(accountCredential(link, origin)).rejects.toThrow();
    await logoutAccount({
      serverOrigin: origin,
      path,
      signal,
      fetch: async () => new Response(null, { status: 401 }),
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(
      path,
      JSON.stringify({ version: 1, serverOrigin: origin, token, expiresAt: 1 }),
      { mode: 0o600 },
    );
    await expect(accountCredential(path, origin)).rejects.toThrow("expired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels device polling without creating a credential file and rejects redirected approval destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-login-cancel-"));
  const path = join(root, "account.json"),
    origin = "https://app.example";
  const stop = new AbortController();
  const start = {
    deviceCode: "b".repeat(64),
    userCode: "ABCDEF1234",
    verificationUri: origin,
    expiresAt: Date.now() + 60000,
    intervalSeconds: 1,
  };
  try {
    await expect(
      loginAccount({
        serverOrigin: origin,
        output: path,
        signal: stop.signal,
        prompt: () => stop.abort(),
        fetch: async () => Response.json(start),
      }),
    ).rejects.toThrow();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      loginAccount({
        serverOrigin: origin,
        output: path,
        signal: new AbortController().signal,
        prompt: () => {
          throw new Error("Should not prompt");
        },
        fetch: async () =>
          Response.json({ ...start, verificationUri: "https://other.example" }),
      }),
    ).rejects.toThrow("destination");
    await expect(
      loginAccount({
        serverOrigin: "http://app.example",
        output: path,
        signal: stop.signal,
        prompt: () => {},
      }),
    ).rejects.toThrow("HTTPS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
