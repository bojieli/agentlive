#!/usr/bin/env node
/** Install the actual tarball outside the workspace and exercise its CLI and native file locks. */
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
const run = promisify(execFile);
const workspace = resolve(import.meta.dirname, "..");
const root = await realpath(
  await mkdtemp(join(tmpdir(), "agentlive-install-")),
);
const version = JSON.parse(
  await readFile(join(workspace, "packages/cli/package.json"), "utf8"),
).version;
const tarball = join(workspace, "dist/release", `agentlive-${version}.tgz`);
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
  const originalPackage = await readFile(tarball);
  await run(process.execPath, [join(workspace, "scripts/build-package.mjs")], {
    cwd: workspace,
    env: { ...env, npm_config_registry: "http://127.0.0.1:1" },
    timeout: 30000,
  });
  if (!(await readFile(tarball)).equals(originalPackage))
    throw new Error("Repeated package build changed artifact bytes");
  await writeFile(join(root, "package.json"), '{"private":true}\n');
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: root, env, timeout: 120000 },
  );
  const cli = await realpath(join(root, "node_modules/agentlive/cli.mjs"));
  if (!cli.startsWith(root + "/"))
    throw new Error("Installed CLI escaped isolated directory");
  const manifest = JSON.parse(
    await readFile(join(root, "node_modules/agentlive/package.json"), "utf8"),
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
  for (const [path, mime, marker] of [
    ["/", "text/html", '<div id="root">'],
    ["/app.js", "text/javascript", "AgentLive"],
    ["/app.css", "text/css", ".shell"],
  ]) {
    const asset = await fetch(new URL(path, ready.url));
    if (
      !asset.ok ||
      !asset.headers.get("content-type")?.includes(mime) ||
      !asset.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'") ||
      !(await asset.text()).includes(marker)
    )
      throw new Error(`Installed browser asset failed: ${path}`);
  }
  const previewWrapper = await fetch(new URL("/artifact-preview", ready.url));
  if (
    !previewWrapper.ok ||
    !previewWrapper.headers
      .get("content-security-policy")
      ?.includes("sandbox allow-scripts") ||
    !(await previewWrapper.text()).includes('sandbox=""')
  )
    throw new Error(
      "Installed static preview wrapper is missing or not sandboxed",
    );
  const previewBridge = await fetch(new URL("/artifact-preview.js", ready.url));
  if (
    !previewBridge.ok ||
    !(await previewBridge.text()).includes("agentlive-static-preview")
  )
    throw new Error("Installed static preview bridge is missing");
  const interactiveWrapper = await fetch(
    new URL("/artifact-interactive", ready.url),
  );
  const interactivePolicy =
    interactiveWrapper.headers.get("content-security-policy") ?? "";
  if (
    !interactiveWrapper.ok ||
    !interactivePolicy.includes("frame-src 'none'") ||
    !interactivePolicy.includes("connect-src 'none'") ||
    !interactivePolicy.includes("sandbox allow-scripts") ||
    !(await interactiveWrapper.text()).includes("agentlive-interactive-preview")
  )
    throw new Error("Installed interactive preview isolation is missing");
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
  if (!process.argv[2]) {
    const discovery = JSON.parse(
      (await command(["discover", "--agent", "claude", "--source-root", root]))
        .stdout,
    );
    if (
      discovery.sessions.length !== 1 ||
      discovery.sessions[0].nativeSessionId !== "installed-probe" ||
      discovery.sessions[0].source !== source
    )
      throw new Error(
        "Installed native discovery did not identify the fixture",
      );
  }
  const imported = JSON.parse(
    (
      await command([
        "import",
        "--agent",
        agent,
        ...(process.argv[2]
          ? ["--source", source]
          : ["--native-session", "installed-probe", "--source-root", root]),
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
  if (!process.argv[2]) {
    const publisherRoot = join(state, "publisher");
    const binding = join(publisherRoot, (await readdir(publisherRoot))[0]);
    const inspection = JSON.parse(
      (await command(["inspect-migration", "--source", binding])).stdout,
    );
    env.MIGRATION_VALUE = "INSTALLED_RECORDING_OK";
    const migrationArgs = [
      "migrate-import",
      "--source",
      binding,
      "--native-source",
      source,
      "--operation-id",
      "installed-migration",
      "--expected-manifest-hash",
      inspection.imported.manifestHash,
      "--old-recording",
      "retain",
      "--redact-env",
      "MIGRATION_VALUE",
    ];
    const firstMigration = await command(migrationArgs);
    const migrated = JSON.parse(firstMigration.stdout);
    if (
      !migrated.completed ||
      migrated.target.streamId === imported.streamId ||
      (await command(migrationArgs)).stdout !== firstMigration.stdout
    )
      throw new Error("Installed migration retry changed replacement identity");
    const migratedReplay = await command([
      "replay",
      "--stream",
      migrated.target.streamId,
      "--server",
      ready.url,
    ]);
    if (
      migratedReplay.stdout.includes("INSTALLED_RECORDING_OK") ||
      !migratedReplay.stdout.includes("[REDACTED]")
    )
      throw new Error("Installed migration did not reproject filtered text");
    delete env.MIGRATION_VALUE;
  }
  const snapshotBase = `${ready.url}/api/v1/streams/${encodeURIComponent(imported.streamId)}`;
  const portablePath = join(root, "recording.agentlive");
  await command([
    "export",
    "--stream",
    imported.streamId,
    "--server",
    ready.url,
    "--output",
    portablePath,
  ]);
  const offlineReplay = await command(["replay", "--source", portablePath]);
  if (!process.argv[2] && offlineReplay.stdout !== replay.stdout)
    throw new Error("Installed archive replay differs");
  const portableImport = JSON.parse(
    (await command(["import", "--source", portablePath, "--server", ready.url]))
      .stdout,
  );
  if (
    portableImport.streamId === imported.streamId ||
    portableImport.lifecycle !== "ended"
  )
    throw new Error("Installed archive import identity or lifecycle differs");
  const importedReplay = await command([
    "replay",
    "--stream",
    portableImport.streamId,
    "--server",
    ready.url,
  ]);
  if (!process.argv[2] && importedReplay.stdout !== replay.stdout)
    throw new Error("Installed imported archive replay differs");
  const snapshotSignal = AbortSignal.timeout(30000);
  const snapshotRequest = async (path, options = {}) => {
    const response = await fetch(snapshotBase + path, {
      ...options,
      headers: {
        authorization: `Bearer ${env.AGENTLIVE_OWNER_SECRET}`,
        "content-type": "application/json",
      },
      signal: snapshotSignal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error(`Installed snapshot request failed (${response.status})`);
    return response.json();
  };
  const metadata = await snapshotRequest("");
  const published = await snapshotRequest("/snapshots", {
    method: "POST",
    body: JSON.stringify({
      revision: metadata.revision,
      throughServerSeq: metadata.serverSeq,
    }),
  });
  const selected = await snapshotRequest(
    `/snapshots?${new URLSearchParams({ revision: metadata.revision, throughServerSeq: String(metadata.serverSeq) })}`,
  );
  if (!isDeepStrictEqual(published, selected))
    throw new Error("Installed snapshot selection differs");
  const activityRef = selected.snapshot.activity;
  if (!activityRef)
    throw new Error("Installed snapshot omitted activity ordering");
  const activityContent = await snapshotRequest(
    `/snapshot-content/${activityRef.hash}?${new URLSearchParams({ revision: metadata.revision, byteSize: String(activityRef.byteSize), units: String(activityRef.units), offset: "0", length: String(activityRef.units) })}`,
  );
  const activityManifest = JSON.parse(activityContent.text);
  if (
    activityManifest.format !== "agentlive.activity-index" ||
    activityManifest.version !== 1 ||
    activityManifest.streamId !== imported.streamId ||
    activityManifest.revision !== metadata.revision ||
    activityManifest.root.appliedSeq !== metadata.serverSeq
  )
    throw new Error("Installed activity snapshot binding or boundary differs");
  const ref = selected.snapshot.ref;
  const blob = await snapshotRequest(
    `/snapshot-blobs/${ref.hash}?${new URLSearchParams({ revision: metadata.revision, byteSize: String(ref.byteSize), units: String(ref.units) })}`,
  );
  const blobBytes = Buffer.from(blob.base64, "base64");
  if (
    blobBytes.length !== ref.byteSize ||
    createHash("sha256").update(blobBytes).digest("hex") !== ref.hash
  )
    throw new Error(
      "Installed snapshot blob transfer differs from its content address",
    );
  const content = await snapshotRequest(
    `/snapshot-content/${ref.hash}?${new URLSearchParams({ revision: metadata.revision, byteSize: String(ref.byteSize), units: String(ref.units), offset: "0", length: String(ref.units) })}`,
  );
  const snapshotManifest = JSON.parse(content.text);
  if (
    snapshotManifest.streamId !== imported.streamId ||
    snapshotManifest.revision !== metadata.revision ||
    snapshotManifest.format !== "agentlive.paged-state" ||
    snapshotManifest.state.appliedSeq !== metadata.serverSeq ||
    content.text.length !== ref.units
  )
    throw new Error(
      "Installed snapshot snapshotManifest differs from recording",
    );
  if (!process.argv[2]) {
    const assets = join(root, "bundle-assets");
    await mkdir(assets);
    await writeFile(join(assets, "module.js"), "export const value = 1;");
    await writeFile(join(assets, "image.png"), Buffer.from([137, 80, 78, 71]));
    const html =
      '<base href="./"><img srcset="image.png 1x"><script type="module">import {value} from "./module.js";</script>';
    const bundleSource = join(root, "bundle-export.json");
    await writeFile(
      bundleSource,
      JSON.stringify({
        info: { id: "installed-bundle", time: { created: 1 } },
        messages: [
          {
            info: {
              id: "m",
              sessionID: "installed-bundle",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [
              {
                id: "f",
                type: "file",
                messageID: "m",
                sessionID: "installed-bundle",
                mime: "text/html",
                filename: "index.html",
                url:
                  "data:text/html;base64," +
                  Buffer.from(html).toString("base64"),
              },
            ],
          },
        ],
      }),
    );
    const importedBundle = JSON.parse(
      (
        await command([
          "import",
          "--agent",
          "opencode",
          "--source",
          bundleSource,
          "--state-dir",
          state,
          "--server",
          ready.url,
          "--artifact-bundles",
          "--artifact-base",
          assets,
          "--artifact-root",
          assets,
        ])
      ).stdout,
    );
    const base = `${ready.url}/api/v1/streams/${importedBundle.streamId}`;
    const get = async (path) => {
      const response = await fetch(base + path, {
        headers: { authorization: `Bearer ${env.AGENTLIVE_OWNER_SECRET}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(`Installed bundle request failed (${response.status})`);
      return response;
    };
    const info = await (await get("")).json();
    const events = (
      await (
        await get(
          `/events?revision=${info.revision}&throughServerSeq=${info.serverSeq}`,
        )
      ).text()
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const attachment = events.find(
      (event) => event.content.kind === "attachment.available",
    )?.content.payload.attachment;
    if (
      attachment?.mediaType !== "application/vnd.agentlive.artifact-bundle+json"
    )
      throw new Error("Installed bundle attachment missing");
    const bytes = Buffer.from(
      await (await get(`/attachments/${attachment.hash}`)).arrayBuffer(),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== attachment.hash)
      throw new Error("Installed bundle hash differs");
    const bundle = JSON.parse(bytes.toString());
    if (
      bundle.manifest.files.length !== 3 ||
      bundle.manifest.unavailable.length
    )
      throw new Error("Installed bundle graph is incomplete");
    for (const file of bundle.manifest.files) {
      const leaf = Buffer.from(bundle.blobs[file.hash], "base64");
      if (
        leaf.length !== file.byteSize ||
        createHash("sha256").update(leaf).digest("hex") !== file.hash
      )
        throw new Error("Installed bundle leaf differs");
    }
    const entry = bundle.manifest.files.find(
      (file) => file.path === bundle.manifest.entrypoint,
    );
    const rewritten = Buffer.from(
      bundle.blobs[entry.hash],
      "base64",
    ).toString();
    if (
      rewritten.includes("./module.js") ||
      rewritten.includes("image.png") ||
      rewritten.includes("<base href=")
    )
      throw new Error("Installed bundle dependencies were not rewritten");
  }
  const cliGrant = JSON.parse(
    (
      await command([
        "viewing-grant",
        "--server",
        ready.url,
        "--stream",
        portableImport.streamId,
        "--label",
        "Installed CLI viewer",
        "--expires-at",
        new Date(Date.now() + 60000).toISOString(),
      ])
    ).stdout,
  );
  const cliGrants = JSON.parse(
    (
      await command([
        "viewing-grants",
        "--server",
        ready.url,
        "--stream",
        portableImport.streamId,
      ])
    ).stdout,
  );
  const viewerFile = join(root, "viewer-grant.json");
  await writeFile(viewerFile, JSON.stringify(cliGrant), { mode: 0o600 });
  const viewerReplayArgs = [
    "replay",
    "--server",
    ready.url,
    "--stream",
    portableImport.streamId,
    "--viewer-file",
    viewerFile,
  ];
  const viewerReplay = await command(viewerReplayArgs);
  if (
    viewerReplay.stdout !== importedReplay.stdout ||
    viewerReplay.stderr.includes(cliGrant.token)
  )
    throw new Error("Installed viewer-file replay differs");
  if (
    !cliGrants.grants.some((item) => item.id === cliGrant.id) ||
    JSON.stringify(cliGrants).includes(cliGrant.token)
  )
    throw new Error("Installed viewing grant list differs");
  if (
    !JSON.parse(
      (
        await command([
          "revoke-viewing-grant",
          "--server",
          ready.url,
          "--stream",
          portableImport.streamId,
          "--grant-id",
          cliGrant.id,
        ])
      ).stdout,
    ).revoked
  )
    throw new Error("Installed CLI revocation failed");
  let revokedFileDenied = false;
  try {
    await command(viewerReplayArgs);
  } catch {
    revokedFileDenied = true;
  }
  if (!revokedFileDenied)
    throw new Error("Installed revoked viewer file retained access");
  const grantBase = `${ready.url}/api/v1/streams/${portableImport.streamId}`;
  const issuedGrant = await fetch(grantBase + "/viewing-grants", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AGENTLIVE_OWNER_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      label: "Installed viewer",
      expiresAt: Date.now() + 60000,
    }),
  });
  if (issuedGrant.status !== 201)
    throw new Error("Installed viewing grant issuance failed");
  const viewingGrant = await issuedGrant.json();
  if (
    !(
      await fetch(grantBase, {
        headers: { authorization: `Bearer ${viewingGrant.token}` },
      })
    ).ok
  )
    throw new Error("Installed viewing grant read failed");
  const revokedGrant = await fetch(
    grantBase + `/viewing-grants/${viewingGrant.id}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.AGENTLIVE_OWNER_SECRET}` },
    },
  );
  if (
    !revokedGrant.ok ||
    (
      await fetch(grantBase, {
        headers: { authorization: `Bearer ${viewingGrant.token}` },
      })
    ).status !== 403
  )
    throw new Error("Installed viewing grant revocation failed");
  const publisherState = JSON.parse(
    (
      await command([
        "publisher-credential",
        "--server",
        ready.url,
        "--stream",
        portableImport.streamId,
      ])
    ).stdout,
  );
  const revokePublisherArgs = [
    "revoke-publisher-credential",
    "--server",
    ready.url,
    "--stream",
    portableImport.streamId,
    "--revision",
    publisherState.revision,
    "--expected-version",
    String(publisherState.version),
    "--operation-id",
    "installed-revoke",
  ];
  for (let retry = 0; retry < 2; retry++) {
    const result = JSON.parse((await command(revokePublisherArgs)).stdout);
    if (!result.revoked || result.version !== publisherState.version + 1)
      throw new Error("Installed publisher credential revocation differs");
  }
  server.kill("SIGTERM");
  const shutdown = setTimeout(() => server.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(shutdown);
  }
  if (server.exitCode !== 143)
    throw new Error("Installed server failed graceful backup shutdown");
  await writeFile(
    join(state, "owner.json"),
    JSON.stringify({ version: 1, secret: env.AGENTLIVE_OWNER_SECRET }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  delete env.AGENTLIVE_OWNER_SECRET;
  const backupPath = join(root, "server-backup");
  const backup = JSON.parse(
    (await command(["backup", "--state-dir", state, "--output", backupPath]))
      .stdout,
  );
  if (backup.recordings < 1)
    throw new Error("Installed backup omitted recordings");
  const backupManifest = JSON.parse(
    await readFile(join(backupPath, "backup.json"), "utf8"),
  );
  for (const file of backupManifest.files) {
    const bytes = await readFile(join(backupPath, file.path));
    if (
      bytes.length !== file.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== file.hash
    )
      throw new Error("Installed backup hash differs");
  }
  const restoredPath = join(root, "restored-state");
  const restored = JSON.parse(
    (
      await command([
        "restore",
        "--source",
        backupPath,
        "--output",
        restoredPath,
      ])
    ).stdout,
  );
  if (
    restored.recordings !== backup.recordings ||
    restored.revisions.some((item) => item.revision === item.previousRevision)
  )
    throw new Error("Installed restore failed to renew revisions");
  for (const revision of restored.revisions) {
    const metadata = JSON.parse(
      await readFile(
        join(
          restoredPath,
          "server",
          "sessions",
          revision.streamId,
          "metadata.json",
        ),
        "utf8",
      ),
    );
    if (metadata.revision !== revision.revision)
      throw new Error("Installed restore revision was not persisted");
    if (
      revision.streamId === portableImport.streamId &&
      (!metadata.publisherCredential?.revoked ||
        metadata.publisherCredential.version !== publisherState.version + 1)
    )
      throw new Error("Installed restore lost publisher credential revocation");
  }
  summary = {
    success: true,
    isolatedInstall: true,
    reproducibleRebuild: true,
    installScriptsDisabled: true,
    server: true,
    browserAssets: true,
    staticPreviewAssets: true,
    interactivePreviewAssets: true,
    imported: true,
    nativeDiscovery: !process.argv[2],
    nativeSessionSelection: !process.argv[2],
    ownerDiscovery: true,
    serverSnapshot: true,
    replay: true,
    artifactBundles: !process.argv[2],
    serverBackup: true,
    serverRestore: true,
    viewingGrants: true,
    viewingGrantCli: true,
    viewingCredentialFile: true,
    publisherCredentialManagement: true,
    portableExport: true,
    offlineArchiveReplay: true,
    portableImport: true,
    retrySameRecording: true,
    replacementMigration: !process.argv[2],
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
