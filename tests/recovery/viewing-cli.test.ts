import { expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
import { viewingCredential } from "../../packages/cli/src/credentials.js";
const run = promisify(execFile);
it("issues, lists, uses and revokes a private viewing credential through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-view-cli-"));
  const owner = "a".repeat(64);
  const server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "cli",
      requestedAt: new Date().toISOString(),
      publisherId: "p",
      producerEpoch: "e",
      writeSecret: "b".repeat(64),
      title: "CLI private recording",
      visibility: "private",
    });
    const streamId = session.info.id;
    server.store.release(session);
    const command = (name: string, args: string[] = [], secret = owner) =>
      run(
        process.execPath,
        [
          "packages/cli/dist/main.js",
          name,
          "--server",
          server.url,
          "--stream",
          streamId,
          "--state-dir",
          join(root, "client"),
          ...args,
        ],
        {
          env: { ...process.env, AGENTLIVE_OWNER_SECRET: secret },
          timeout: 30000,
        },
      );
    const issued = await command("viewing-grant", [
      "--label",
      "Demo",
      "--expires-at",
      new Date(Date.now() + 60000).toISOString(),
    ]);
    const grant = JSON.parse(issued.stdout);
    expect(grant).toMatchObject({ streamId, label: "Demo" });
    expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.stderr).toBe("");
    const listing = await command("viewing-grants");
    expect(JSON.parse(listing.stdout).grants[0].id).toBe(grant.id);
    expect(listing.stdout).not.toContain(grant.token);
    const replay = await command("replay", [], grant.token);
    expect(replay.stdout).toContain("CLI private recording");
    const viewerFile = join(root, "viewer-grant.json");
    await writeFile(viewerFile, issued.stdout, { mode: 0o600 });
    // Explicit viewer files take precedence over an ambient owner credential.
    const fileReplay = await command("replay", ["--viewer-file", viewerFile]);
    expect(fileReplay.stdout).toContain("CLI private recording");
    expect(fileReplay.stdout + fileReplay.stderr).not.toContain(grant.token);
    const watcher = spawn(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "watch",
        "--server",
        server.url,
        "--stream",
        streamId,
        "--viewer-file",
        viewerFile,
        "--state-dir",
        join(root, "watcher"),
      ],
      {
        env: { ...process.env, AGENTLIVE_OWNER_SECRET: "invalid-unused-owner" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const watcherExit = new Promise<void>((resolve) =>
      watcher.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Viewer-file watch did not render")),
          10000,
        );
        let output = "";
        watcher.stdout.on("data", (bytes) => {
          output += bytes.toString();
          if (output.includes("CLI private recording")) {
            clearTimeout(timer);
            resolve();
          }
        });
        watcher.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Viewer-file watch failed to start"));
        });
        watcher.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Viewer-file watch exited before rendering"));
        });
      });
    } finally {
      watcher.kill("SIGTERM");
      const kill = setTimeout(() => watcher.kill("SIGKILL"), 5000);
      await watcherExit;
      clearTimeout(kill);
    }
    const exported = await command("export", [
      "--viewer-file",
      viewerFile,
      "--output",
      join(root, "view.agentlive"),
    ]);
    expect(JSON.parse(exported.stdout).event).toBe("exported");
    await expect(
      command("replay", ["--viewer-file", viewerFile, "--anonymous"]),
    ).rejects.toThrow("cannot be combined");
    await expect(
      command("viewing-grants", ["--viewer-file", viewerFile]),
    ).rejects.toThrow();
    await expect(command("viewing-grants", [], grant.token)).rejects.toThrow();
    await expect(
      command("viewing-grant", ["--expires-at", "yesterday"]),
    ).rejects.toThrow("ISO-8601");
    await expect(
      command("viewing-grant", ["--expires-at", "2000-01-01T00:00:00Z"]),
    ).rejects.toThrow("Expiry");
    expect(
      JSON.parse(
        (await command("revoke-viewing-grant", ["--grant-id", grant.id]))
          .stdout,
      ).revoked,
    ).toBe(true);
    expect(
      JSON.parse(
        (await command("revoke-viewing-grant", ["--grant-id", grant.id]))
          .stdout,
      ).revoked,
    ).toBe(false);
    await expect(command("replay", [], grant.token)).rejects.toThrow();
    // A revoked file must never fall back to the still-valid owner environment.
    await expect(
      command("replay", ["--viewer-file", viewerFile]),
    ).rejects.toThrow();
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects unsafe, malformed, expired and differently scoped viewer files without echoing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-view-file-"));
  const path = join(root, "grant.json");
  const token = "d".repeat(64);
  const value = { token, streamId: "recording", expiresAt: Date.now() + 60000 };
  try {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    expect(await viewingCredential(path, "recording")).toBe(token);
    await expect(viewingCredential(path, "other")).rejects.toThrow(
      "another recording",
    );
    await chmod(path, 0o644);
    await expect(viewingCredential(path, "recording")).rejects.toThrow(
      "chmod 600",
    );
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(viewingCredential(link, "recording")).rejects.toThrow();
    await writeFile(path, JSON.stringify({ ...value, expiresAt: 1 }));
    await expect(viewingCredential(path, "recording")).rejects.toThrow(
      "expired",
    );
    await writeFile(path, token + "invalid json");
    await expect(viewingCredential(path, "recording")).rejects.toThrow(
      /^Invalid viewing credential JSON$/,
    );
    await writeFile(path, "x".repeat(4097));
    await expect(viewingCredential(path, "recording")).rejects.toThrow(
      "Invalid viewing credential file",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
