#!/usr/bin/env node
/** Install the actual tarball outside the workspace and exercise its CLI and native file locks. */
import { mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const workspace = resolve(import.meta.dirname, "..");
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-install-")),
);
const version = JSON.parse(
  await readFile(join(workspace, "packages/cli/package.json"), "utf8"),
).version;
const tarball = join(workspace, "dist/release", `agentlive-cli-${version}.tgz`);
const env = {
  ...process.env,
  AGENTLIVE_OWNER_SECRET: randomBytes(32).toString("hex"),
};
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
let server;
let exited;
let summary;
try {
  await writeFile(join(root, "package.json"), '{"private":true}\n');
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, env, timeout: 120000 },
  );
  const cli = await realpath(join(root, "node_modules/@agentlive/cli/cli.mjs"));
  if (!cli.startsWith(root + "/"))
    throw new Error("Installed CLI escaped isolated directory");
  const manifest = JSON.parse(
    await readFile(
      join(root, "node_modules/@agentlive/cli/package.json"),
      "utf8",
    ),
  );
  if (
    Object.values(manifest.dependencies).some((value) =>
      value.startsWith("workspace:"),
    )
  )
    throw new Error("Distribution still depends on workspace packages");
  const command = (args) =>
    run(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
  const help = await command(["--help"]);
  if (!help.stdout.includes("agentlive serve"))
    throw new Error("Installed CLI help is missing");
  const state = join(root, "state");
  server = spawn(
    process.execPath,
    [cli, "serve", "--port", "0", "--state-dir", state],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  exited = new Promise((resolve, reject) => {
    server.once("exit", resolve);
    server.once("error", reject);
  });
  void exited.catch(() => {});
  server.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Installed server did not start")),
      15000,
    );
    const data = (chunk) => {
      output += chunk.toString();
      if (output.length > 65536) {
        clearTimeout(timer);
        reject(new Error("Unexpected server output"));
      }
      if (output.includes("\n")) {
        clearTimeout(timer);
        server.stdout.off("data", data);
        try {
          resolve(JSON.parse(output.split("\n")[0]));
        } catch (error) {
          reject(error);
        }
      }
    };
    server.stdout.on("data", data);
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error("Installed server exited during startup"));
    }, reject);
  });
  let source = process.argv[2]
    ? resolve(process.argv[2])
    : join(root, "source.jsonl");
  const agent = process.argv[3] ?? "claude";
  if (!process.argv[2])
    await writeFile(
      source,
      JSON.stringify({
        type: "user",
        sessionId: "installed-probe",
        uuid: "row1",
        timestamp: "2026-09-01T00:00:00Z",
        message: { content: "INSTALLED_RECORDING_OK" },
      }) + "\n",
    );
  const imported = JSON.parse(
    (
      await command([
        "import",
        "--agent",
        agent,
        "--source",
        source,
        "--server",
        ready.url,
        "--state-dir",
        state,
        "--title",
        "Installed package probe",
      ])
    ).stdout,
  );
  if (!imported.streamId)
    throw new Error("Installed importer returned no recording");
  const listing = JSON.parse(
    (await command(["list", "--server", ready.url])).stdout,
  );
  if (
    !listing.recordings.some((recording) => recording.id === imported.streamId)
  )
    throw new Error("Installed listing omitted imported recording");
  const replay = await command([
    "replay",
    "--stream",
    imported.streamId,
    "--server",
    ready.url,
  ]);
  if (
    !replay.stdout.length ||
    (!process.argv[2] && !replay.stdout.includes("INSTALLED_RECORDING_OK"))
  )
    throw new Error("Installed replay did not reconstruct recording");
  const retry = JSON.parse(
    (
      await command([
        "import",
        "--agent",
        agent,
        "--source",
        source,
        "--server",
        ready.url,
        "--state-dir",
        state,
        "--title",
        "Installed package probe",
      ])
    ).stdout,
  );
  if (retry.streamId !== imported.streamId)
    throw new Error("Installed import retry changed recording");
  summary = {
    success: true,
    isolatedInstall: true,
    installScriptsDisabled: true,
    server: true,
    imported: true,
    ownerDiscovery: true,
    replay: true,
    retrySameRecording: true,
    nativeSource: !!process.argv[2],
    replayBytes: Buffer.byteLength(replay.stdout),
    replayHash: createHash("sha256").update(replay.stdout).digest("hex"),
  };
} finally {
  let forced = false;
  try {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      const force = setTimeout(() => {
        forced = true;
        server.kill("SIGKILL");
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (forced || (summary && server.exitCode !== 0 && server.exitCode !== 143))
    throw new Error("Installed server did not shut down cleanly");
}
console.log(JSON.stringify({ ...summary, cleanShutdown: true }));
