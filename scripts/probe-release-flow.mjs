#!/usr/bin/env node
/** Rehearse the M7 release journey — publish, watch, rewind, catch up, replay —
 * against the installed standalone package, with a synthetic agent and no model calls. */
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const workspace = resolve(import.meta.dirname, "..");
const started = Date.now();
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-release-")),
);
const checks = [];
const timings = {};
const record = (name) => {
  checks.push(name);
  timings[name] = Math.round((Date.now() - started) / 100) / 10;
};
const state = join(root, "state");
const native = join(root, "native");
const project = join(root, "project");
const bin = join(root, "bin");
const lateGate = join(root, "publish-late");
const exitGate = join(root, "native-exit");
const children = new Set();
let summary;
let failure;
/** Track every spawned process so a failure cannot leave one behind. */
function track(command, args, options) {
  const child = spawn(command, args, options);
  children.add(child);
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  void exited.then(
    () => children.delete(child),
    () => children.delete(child),
  );
  return { child, exited };
}
async function stopChild(entry, signal = "SIGTERM") {
  if (
    !entry ||
    entry.child.exitCode !== null ||
    entry.child.signalCode !== null
  )
    return entry?.exited;
  entry.child.kill(signal);
  const force = setTimeout(() => entry.child.kill("SIGKILL"), 5000);
  try {
    return await entry.exited;
  } finally {
    clearTimeout(force);
  }
}
/** Collect a child's output and resolve when a predicate matches it. */
function collector(stream) {
  let text = "";
  const waiters = new Set();
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    if (text.length > 4 * 1024 * 1024) text = text.slice(-1024 * 1024);
    for (const waiter of [...waiters]) waiter();
  });
  return {
    get text() {
      return text;
    },
    async until(predicate, timeoutMs, description) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = predicate(text);
        if (found) return found;
        if (Date.now() >= deadline)
          throw new Error(`${description}; saw: ${text.slice(-1500)}`);
        await new Promise((resolve) => {
          const waiter = () => {
            waiters.delete(waiter);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(waiter, 250);
          waiters.add(waiter);
        });
      }
    },
  };
}
/** Bound a wait without leaving a timer that would hold the process open. */
async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const jsonEvents = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
let server;
let publisher;
let viewer;
try {
  const version = JSON.parse(
    await readFile(join(workspace, "packages/cli/package.json"), "utf8"),
  ).version;
  const tarball = join(workspace, "dist/release", `agentlive-${version}.tgz`);
  const buildEnv = { ...process.env };
  delete buildEnv.NODE_PATH;
  delete buildEnv.NODE_OPTIONS;
  delete buildEnv.AGENTLIVE_OWNER_SECRET;
  await run(process.execPath, [join(workspace, "scripts/build-package.mjs")], {
    cwd: workspace,
    env: { ...buildEnv, npm_config_registry: "http://127.0.0.1:1" },
    timeout: 120000,
  }).catch(() => {
    throw new Error(
      "Could not build the release tarball; run `pnpm build` before this probe",
    );
  });
  await writeFile(join(root, "package.json"), '{"private":true}\n');
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, env: buildEnv, timeout: 180000 },
  );
  const cli = await realpath(join(root, "node_modules/agentlive/cli.mjs"));
  if (!cli.startsWith(root + "/"))
    throw new Error("Installed CLI escaped the isolated directory");
  record("install: standalone tarball installs with scripts disabled");

  // Every later command runs the installed CLI against an isolated home, so the
  // rehearsal can never read or write the operator's own ~/.agentlive.
  const env = { ...buildEnv, HOME: root };
  const cliRun = (args, options = {}) =>
    run(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  for (const directory of [
    state,
    native,
    project,
    bin,
    join(root, "viewer-state"),
    join(root, "anonymous-state"),
  ])
    await mkdir(directory, { recursive: true });

  server = track(
    process.execPath,
    [cli, "serve", "--port", "0", "--state-dir", state],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverOut = collector(server.child.stdout);
  collector(server.child.stderr);
  const ready = JSON.parse(
    await serverOut.until(
      (text) => (text.includes("\n") ? text.split("\n")[0] : undefined),
      20000,
      "Installed server did not report a ready line",
    ),
  );
  if (
    ready.event !== "ready" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url) ||
    ready.reachability !== "this-machine" ||
    ready.viewerUrls.length !== 1 ||
    ready.viewerUrls[0] !== `${ready.url}/` ||
    ready.ownerFile !== join(state, "owner.json")
  )
    throw new Error(`Serve ready line differs: ${JSON.stringify(ready)}`);
  if (((await stat(ready.ownerFile)).mode & 0o777) !== 0o600)
    throw new Error("Owner credential file is not owner-only");
  const ownerSecret = JSON.parse(
    await readFile(ready.ownerFile, "utf8"),
  ).secret;
  record(
    "serve: ready line reports url, viewerUrls, reachability and ownerFile",
  );

  const ownerFetch = async (path, options = {}) =>
    fetch(new URL(path, ready.url), {
      ...options,
      headers: {
        authorization: `Bearer ${ownerSecret}`,
        "content-type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    });

  // A synthetic Claude executable: native transcript rows plus terminal output,
  // with no model call. Its last two rows wait for gates the viewer controls.
  const rowScript = (uuid, seconds, text) =>
    `row(${JSON.stringify(uuid)}, ${seconds}, ${JSON.stringify(text)})`;
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "--session-id") process.exit(3);
const id = process.argv[3];
const saved = JSON.parse(fs.readFileSync(${JSON.stringify(join(state, "launches"))} + "/" + id + ".json", "utf8"));
if (saved.nativeSessionId !== id) process.exit(4);
const source = ${JSON.stringify(join(native, "transcript.jsonl"))};
const base = Date.parse("2026-09-01T00:00:00.000Z");
const row = (uuid, seconds, content) =>
  JSON.stringify({
    type: "user",
    sessionId: id,
    uuid,
    timestamp: new Date(base + seconds * 1000).toISOString(),
    message: { content },
  }) + "\\n";
const deadline = Date.now() + 300000;
const waitFor = (path, next) => {
  if (fs.existsSync(path)) return next();
  if (Date.now() > deadline) process.exit(5);
  setTimeout(() => waitFor(path, next), 100);
};
fs.writeFileSync(source, ${rowScript("r1", 0, "STAGE-ONE-OPENING")});
console.log("NATIVE_TERMINAL_OUTPUT");
setTimeout(() => {
  fs.appendFileSync(source, ${rowScript("r2", 45, "STAGE-TWO-MIDDLE")});
  setTimeout(() => {
    fs.appendFileSync(source, ${rowScript("r3", 90, "STAGE-THREE-LATEST")});
    waitFor(${JSON.stringify(lateGate)}, () => {
      fs.appendFileSync(source, ${rowScript("r4", 135, "STAGE-FOUR-WHILE-PAUSED")});
      waitFor(${JSON.stringify(exitGate)}, () => process.exit(0));
    });
  }, 500);
}, 500);
`,
    { mode: 0o700 },
  );

  publisher = track(
    process.execPath,
    [
      cli,
      "publish",
      "--agent",
      "claude",
      "--launch",
      "--cwd",
      project,
      "--source-root",
      native,
      "--server",
      ready.url,
      "--state-dir",
      state,
    ],
    {
      cwd: root,
      env: { ...env, PATH: `${bin}:${env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const publisherOut = collector(publisher.child.stdout);
  const publisherErr = collector(publisher.child.stderr);
  const publishing = await publisherErr.until(
    (text) => jsonEvents(text).find((event) => event.event === "publishing"),
    60000,
    "Live publish never reported a publishing event",
  );
  const streamId = publishing.streamId;
  if (publishing.viewerUrl !== `${ready.url}/?stream=${streamId}`)
    throw new Error(`Publishing viewerUrl differs: ${publishing.viewerUrl}`);
  record("publish: launch reports a publishing event with a viewer URL");

  const metadata = async (path = "") =>
    (await ownerFetch(`/api/v1/streams/${streamId}${path}`)).json();
  for (const deadline = Date.now() + 60000; ;) {
    const info = await metadata();
    if (info.lifecycle === "open" && info.timelineMs === 90000) break;
    if (Date.now() > deadline)
      throw new Error(
        "Live events did not reach the server before the deadline",
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (publisher.child.exitCode !== null)
    throw new Error("Synthetic agent exited before its events were delivered");
  record("publish: events reach the server while the agent is still running");

  const refused = await cliRun([
    "replay",
    "--stream",
    streamId,
    "--server",
    ready.url,
    "--anonymous",
    "--state-dir",
    state,
  ]).then(
    () => undefined,
    (error) => error,
  );
  if (!refused?.stderr.includes("requires viewing authorization"))
    throw new Error("Anonymous access to a private recording was not refused");
  record("access: anonymous viewing of a private recording is refused");

  const driver = track(
    "python3",
    [
      join(workspace, "scripts/probe-terminal.py"),
      "release-flow",
      process.execPath,
      cli,
      ready.url,
      streamId,
      state,
      lateGate,
      exitGate,
    ],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  viewer = driver;
  const driverOut = collector(driver.child.stdout);
  const driverErr = collector(driver.child.stderr);
  const driverExit = await withDeadline(
    driver.exited,
    240000,
    "Terminal viewer probe exceeded its deadline",
  );
  if (driverExit.code !== 0)
    throw new Error(
      `Terminal viewer probe failed: ${driverErr.text.slice(-2000)}`,
    );
  const viewerResult = JSON.parse(driverOut.text);
  for (const check of viewerResult.checks) record(check);

  const publisherExit = await withDeadline(
    publisher.exited,
    90000,
    "Live publish did not end after the agent exited",
  );
  if (
    publisherExit.code !== 0 ||
    publisherOut.text !== "NATIVE_TERMINAL_OUTPUT\n"
  )
    throw new Error(
      `Managed launch did not relay native output cleanly: ${publisherExit.code} ${JSON.stringify(publisherOut.text)}`,
    );
  record(
    "publish: managed launch relays native terminal output and exits zero",
  );

  const finished = JSON.parse(
    (await cliRun(["finish", "--stream", streamId, "--state-dir", state]))
      .stdout,
  );
  if (!finished.completed || (await metadata()).lifecycle !== "ended")
    throw new Error("Finish did not end the recording");
  record("finish: the published recording ends with every captured event");

  const archive = join(root, "recording.agentlive");
  const exported = JSON.parse(
    (
      await cliRun([
        "export",
        "--stream",
        streamId,
        "--server",
        ready.url,
        "--state-dir",
        state,
        "--output",
        archive,
      ])
    ).stdout,
  );
  if (!exported.bytes) throw new Error("Export produced no archive bytes");
  record("export: the ended recording writes a portable archive");

  const offline = await cliRun(["replay", "--source", archive]);
  const markers = (text) => [...new Set(text.match(/STAGE-[A-Z-]+/g) ?? [])];
  const replayed = markers(offline.stdout);
  const displayed = markers(viewerResult.markers.join("\n"));
  if (
    replayed.length !== 4 ||
    displayed.join(",") !== replayed.join(",") ||
    !offline.stdout.includes("Recording ended")
  )
    throw new Error(
      `Offline replay text differs from the viewer: ${displayed} vs ${replayed}`,
    );
  record("replay: offline archive replay matches the text the viewer showed");

  for (const [path, mime, marker] of [
    ["/", "text/html", '<div id="root">'],
    ["/app.js", "text/javascript", "AgentLive"],
    ["/app.css", "text/css", ".shell"],
  ]) {
    const asset = await fetch(new URL(path, ready.url), {
      signal: AbortSignal.timeout(15000),
    });
    if (
      !asset.ok ||
      !asset.headers.get("content-type")?.includes(mime) ||
      !(await asset.text()).includes(marker)
    )
      throw new Error(`Installed browser viewer asset failed: ${path}`);
  }
  const shortLink = await fetch(new URL(`/s/${streamId}`, ready.url), {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (
    shortLink.status !== 302 ||
    shortLink.headers.get("location") !== `/?stream=${streamId}`
  )
    throw new Error("Short share link did not redirect to the browser viewer");
  record(
    "browser: the installed package serves the viewer, its assets and /s/<id>",
  );

  const grantFile = join(root, "viewer-grant.json");
  const grant = JSON.parse(
    (
      await cliRun([
        "viewing-grant",
        "--stream",
        streamId,
        "--server",
        ready.url,
        "--state-dir",
        state,
        "--label",
        "Release rehearsal viewer",
        "--expires-at",
        new Date(Date.now() + 900000).toISOString(),
      ])
    ).stdout,
  );
  await writeFile(grantFile, JSON.stringify(grant), { mode: 0o600 });
  const granted = track(
    process.execPath,
    [
      cli,
      "watch",
      "--stream",
      streamId,
      "--server",
      ready.url,
      "--state-dir",
      join(root, "viewer-state"),
      "--viewer-file",
      grantFile,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const grantedOut = collector(granted.child.stdout);
    const grantedErr = collector(granted.child.stderr);
    await grantedOut.until(
      (text) => text.includes("Recording ended") || undefined,
      60000,
      "Scoped viewer never reached the end of the recording",
    );
    if (
      grantedOut.text.includes(grant.token) ||
      grantedErr.text.includes(grant.token)
    )
      throw new Error("Scoped viewer echoed its credential");
    if (markers(grantedOut.text).join(",") !== replayed.join(","))
      throw new Error("Scoped viewer text differs from the archive replay");
    // Watch stays attached to an ended recording until the viewer quits.
    const grantedExit = await stopChild(granted, "SIGINT");
    if (grantedExit.code !== 130)
      throw new Error(
        `Interrupted watch exited ${grantedExit.code} instead of 130`,
      );
  } finally {
    await stopChild(granted);
  }
  record("centralized: a scoped viewing grant watches the private recording");

  if (
    !JSON.parse(
      (
        await cliRun([
          "revoke-viewing-grant",
          "--stream",
          streamId,
          "--server",
          ready.url,
          "--state-dir",
          state,
          "--grant-id",
          grant.id,
        ])
      ).stdout,
    ).revoked
  )
    throw new Error("Viewing grant revocation failed");
  const revoked = await cliRun([
    "replay",
    "--stream",
    streamId,
    "--server",
    ready.url,
    "--viewer-file",
    grantFile,
  ]).then(
    () => undefined,
    (error) => error,
  );
  if (!revoked) throw new Error("Revoked viewing grant retained access");
  record("centralized: revoking the grant immediately denies the viewer file");

  const visibility = await metadata("/visibility");
  const changed = await (
    await ownerFetch(`/api/v1/streams/${streamId}/visibility`, {
      method: "POST",
      body: JSON.stringify({
        revision: visibility.revision,
        operationId: crypto.randomUUID(),
        expectedVersion: visibility.version,
        visibility: "public",
      }),
    })
  ).json();
  if (changed.visibility !== "public")
    throw new Error("Recording did not become public");
  const anonymous = await cliRun([
    "replay",
    "--stream",
    streamId,
    "--server",
    ready.url,
    "--anonymous",
    "--state-dir",
    join(root, "anonymous-state"),
  ]);
  if (markers(anonymous.stdout).join(",") !== replayed.join(","))
    throw new Error("Anonymous viewer did not receive the public recording");
  record(
    "centralized: an anonymous viewer is accepted once the recording is public",
  );

  // The only CLI-expressible way to publish without credentials: the
  // --visibility flag at native import or publish time.
  const openSource = join(root, "public-import", "transcript.jsonl");
  await mkdir(join(root, "public-import"), { recursive: true });
  await writeFile(
    openSource,
    JSON.stringify({
      type: "user",
      sessionId: "release-rehearsal-public",
      uuid: "row1",
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { content: "STAGE-PUBLIC-AT-IMPORT" },
    }) + "\n",
  );
  const published = JSON.parse(
    (
      await cliRun([
        "import",
        "--agent",
        "claude",
        "--source",
        openSource,
        "--server",
        ready.url,
        "--state-dir",
        state,
        "--visibility",
        "public",
        "--title",
        "Release rehearsal public import",
      ])
    ).stdout,
  );
  if (published.visibility !== "public")
    throw new Error("Import did not apply the requested visibility");
  const republished = await cliRun([
    "replay",
    "--stream",
    published.streamId,
    "--server",
    ready.url,
    "--anonymous",
    "--state-dir",
    join(root, "anonymous-state"),
  ]);
  if (!republished.stdout.includes("STAGE-PUBLIC-AT-IMPORT"))
    throw new Error("Publishing with --visibility public was not readable");
  record(
    "centralized: --visibility public shares a recording without credentials",
  );

  const shutdown = await stopChild(server);
  if (shutdown.code !== 143)
    throw new Error(`Installed server exited ${shutdown.code} on SIGTERM`);
  record("shutdown: the installed server stops gracefully");
  summary = {
    success: true,
    package: `agentlive-${version}.tgz`,
    streamId,
    replayMarkers: replayed,
  };
} catch (error) {
  failure = error;
} finally {
  // Release the synthetic agent, then stop every process before removing state.
  await writeFile(exitGate, "").catch(() => {});
  await stopChild(viewer, "SIGKILL").catch(() => {});
  await stopChild(publisher).catch(() => {});
  await stopChild(server).catch(() => {});
  for (const child of children) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
const report = {
  ...(summary ?? {
    success: false,
    error: String(failure?.message ?? failure),
  }),
  checks,
  seconds: Math.round((Date.now() - started) / 100) / 10,
  checkSeconds: timings,
  platform: process.platform,
  node: process.version,
  at: new Date().toISOString(),
  scope:
    "Installed-package publish/watch/rewind/catch-up/replay with a synthetic agent; no real agent, no model calls, loopback only. Rendered browser behaviour stays with probe-browser.mjs.",
};
await mkdir(join(workspace, "probe-results/release-flow"), { recursive: true });
await writeFile(
  join(workspace, "probe-results/release-flow/report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(report) + "\n");
if (!summary) {
  process.exitCode = 1;
  if (failure) process.stderr.write(String(failure?.stack ?? failure) + "\n");
}
