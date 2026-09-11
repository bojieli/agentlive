import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostedConfig } from "../../packages/cli/src/hosted-config.js";

it("loads explicit HTTPS hosted configuration with environment secrets and rejects malformed or unsafe inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-hosted-config-"));
  const path = join(root, "hosted.json");
  const config = {
    version: 1,
    publicOrigin: "https://app.example",
    issuer: "https://id.example/tenant",
    clientId: "client",
    clientSecretEnv: "OIDC_CLIENT_SECRET",
    cookiePasswordEnv: "SESSION_PASSWORD",
  };
  const env = {
    OIDC_CLIENT_SECRET: "client-secret",
    SESSION_PASSWORD: "a".repeat(64),
  };
  try {
    await writeFile(path, JSON.stringify(config));
    expect(await loadHostedConfig(path, env)).toEqual({
      publicOrigin: config.publicOrigin,
      hosted: {
        issuer: config.issuer,
        clientId: "client",
        clientSecret: env.OIDC_CLIENT_SECRET,
        cookiePassword: env.SESSION_PASSWORD,
      },
    });
    await expect(loadHostedConfig(path, {})).rejects.toThrow(
      "environment secrets",
    );
    await expect(
      loadHostedConfig(path, { ...env, SESSION_PASSWORD: "short" }),
    ).rejects.toThrow("environment secrets");
    for (const extra of [
      { publicOrigin: "http://app.example" },
      { publicOrigin: "https://app.example/path" },
      { issuer: "https://user:password@id.example" },
      { clientSecret: "inline-secret" },
    ]) {
      await writeFile(path, JSON.stringify({ ...config, ...extra }));
      await expect(loadHostedConfig(path, env)).rejects.toThrow();
    }
    await writeFile(path, "private-secret invalid JSON");
    await expect(loadHostedConfig(path, env)).rejects.toThrow(
      /^Invalid hosted configuration JSON$/,
    );
    await writeFile(path, "x".repeat(16385));
    await expect(loadHostedConfig(path, env)).rejects.toThrow(
      "Invalid hosted configuration file",
    );
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(loadHostedConfig(link, env)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
