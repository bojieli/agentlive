/** Exercise a built image against a disposable named volume, never user data. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const run = promisify(execFile);
const image = process.argv[2] ?? "agentlive:production-gate-local";
const name = `agentlive-probe-${randomUUID()}`;
const volume = `${name}-data`;
const docker = async (...args) =>
  (
    await run("docker", args, { timeout: 60000, maxBuffer: 1048576 })
  ).stdout.trim();
let created = false;
let activeState = "/data";
async function start() {
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    "-p",
    "127.0.0.1::7331",
    "--health-interval=1s",
    image,
    "serve",
    "--host",
    "0.0.0.0",
    "--port",
    "7331",
    "--state-dir",
    activeState,
  );
  created = true;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await docker("inspect", name))[0];
    if (!state.State.Running) throw new Error("Container failed to start");
    if (state.State.Health.Status === "healthy")
      return `http://127.0.0.1:${state.NetworkSettings.Ports["7331/tcp"][0].HostPort}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Container readiness deadline exceeded");
}
const cli = (...args) =>
  docker(
    "exec",
    name,
    "node",
    "/opt/agentlive/cli.mjs",
    ...args,
    "--state-dir",
    activeState,
  );
try {
  await docker("volume", "create", volume);
  let origin = await start();
  assert.equal((await fetch(origin + "/readyz")).status, 200);
  assert.match(await (await fetch(origin)).text(), /<html/);
  for (const path of ["/artifact-preview", "/artifact-interactive"])
    assert.equal((await fetch(origin + path)).status, 200);
  assert.notEqual(await docker("exec", name, "id", "-u"), "0");
  const fingerprint = () =>
    docker(
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      'import{readFileSync,statSync}from"node:fs";import{createHash}from"node:crypto";const p="/data/owner.json";if((statSync(p).mode&63)!==0)throw Error("credential permissions");console.log(createHash("sha256").update(readFileSync(p)).digest("hex"))',
    );
  const owner = await fingerprint();
  const source =
    JSON.stringify({
      type: "user",
      sessionId: "container-probe",
      uuid: "row1",
      timestamp: "2026-09-01T00:00:00Z",
      message: { content: "CONTAINER_RECORDING_OK" },
    }) + "\n";
  await docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    'import{writeFileSync}from"node:fs";writeFileSync("/tmp/source.jsonl",process.argv[1]);',
    source,
  );
  const imported = JSON.parse(
    await cli(
      "import",
      "--agent",
      "claude",
      "--source",
      "/tmp/source.jsonl",
      "--server",
      "http://127.0.0.1:7331",
    ),
  );
  const replay = await cli(
    "replay",
    "--stream",
    imported.streamId,
    "--server",
    "http://127.0.0.1:7331",
  );
  assert.match(replay, /CONTAINER_RECORDING_OK/);
  await docker("stop", "-t", "45", name);
  assert.equal(
    JSON.parse(await docker("inspect", name))[0].State.ExitCode,
    143,
  );
  await docker("rm", name);
  created = false;
  origin = await start();
  assert.equal(await fingerprint(), owner);
  assert.equal(
    await cli(
      "replay",
      "--stream",
      imported.streamId,
      "--server",
      "http://127.0.0.1:7331",
    ),
    replay,
  );
  await cli(
    "export",
    "--stream",
    imported.streamId,
    "--output",
    "/tmp/recording.agentlive",
    "--server",
    "http://127.0.0.1:7331",
  );
  assert.equal(
    await cli("replay", "--source", "/tmp/recording.agentlive"),
    replay,
  );
  await assert.rejects(
    cli("backup", "--output", "/data/refused-live-backup"),
    /in use by a running server/,
  );
  // Online backup while the server keeps running, then prove it restores.
  const online = JSON.parse(
    (
      await cli(
        "backup",
        "--server",
        "http://127.0.0.1:7331",
        "--output",
        "/data/online-backup",
      )
    )
      .split("\n")
      .filter(Boolean)
      .at(-1),
  );
  assert.equal((await fetch(origin + "/readyz")).status, 200);
  const doctor = JSON.parse(
    await cli("doctor", "--server", "http://127.0.0.1:7331"),
  );
  assert.equal(
    doctor.checks.find((check) => check.name === "server").status,
    "ok",
  );
  assert.equal(
    doctor.checks.find((check) => check.name === "owner-credential").status,
    "ok",
  );
  await docker("stop", "-t", "45", name);
  await docker("rm", name);
  created = false;
  const offline = (...args) =>
    docker(
      "run",
      "--rm",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "--mount",
      `type=volume,src=${volume},dst=/data`,
      image,
      ...args,
    );
  const backup = JSON.parse(
    await offline("backup", "--state-dir", "/data", "--output", "/data/backup"),
  );
  assert.equal(backup.recordings, 1);
  const restored = JSON.parse(
    await offline(
      "restore",
      "--source",
      "/data/backup",
      "--output",
      "/data/restored",
    ),
  );
  assert.equal(restored.recordings, 1);
  const onlineRestored = JSON.parse(
    await offline(
      "restore",
      "--source",
      "/data/online-backup",
      "--output",
      "/data/online-restored",
    ),
  );
  assert.equal(onlineRestored.recordings, 1);
  assert.notEqual(
    restored.revisions[0].revision,
    restored.revisions[0].previousRevision,
  );
  activeState = "/data/restored";
  origin = await start();
  assert.equal(
    await cli(
      "replay",
      "--stream",
      imported.streamId,
      "--server",
      "http://127.0.0.1:7331",
    ),
    replay,
  );
  const listings = JSON.parse(
    await cli("list", "--server", "http://127.0.0.1:7331"),
  );
  assert.ok(JSON.stringify(listings).includes(restored.revisions[0].revision));
  const report = {
    success: true,
    image,
    imageId: await docker("image", "inspect", "--format", "{{.Id}}", image),
    at: new Date().toISOString(),
    checks: [
      "non-root-read-only-start",
      "readiness-healthcheck",
      "browser-preview-assets",
      "private-import-replay",
      "graceful-stop",
      "volume-container-replacement",
      "owner-credential-permissions-and-persistence",
      "portable-export-offline-replay",
      "running-server-offline-backup-refusal",
      "online-backup-while-serving",
      "doctor-server-and-credential",
      "online-backup-restore",
      "offline-container-backup-and-restore",
      "restored-revision-and-exact-replay",
    ],
    replayHash: createHash("sha256").update(replay).digest("hex"),
    onlineBackup: { recordings: online.recordings ?? null },
  };
  await mkdir("probe-results/container", { recursive: true });
  await writeFile(
    "probe-results/container/report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  if (created) {
    await docker("stop", "-t", "45", name).catch(() => {});
    await docker("rm", "-f", name).catch(() => {});
  }
  await docker("volume", "rm", volume).catch(() => {});
}
