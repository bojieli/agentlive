#!/usr/bin/env node
/** Production browser over a disposable local TLS proxy; preissued synthetic account session. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { Accounts, startServer } from "../packages/server/dist/index.js";
import { AccountSessions } from "../packages/server/dist/account-sessions.js";

const root = await mkdtemp(join(tmpdir(), "agentlive-hosted-browser-"));
const output = resolve("probe-results", `hosted-browser-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { success: false, checks: [] };
let server, proxy, browser;
const sockets = new Set();
try {
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  proxy = https.createServer(
    {
      key: await readFile(join(root, "key.pem")),
      cert: await readFile(join(root, "cert.pem")),
    },
    (incoming, outgoing) => {
      const request = http.request(
        new URL(incoming.url, server.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      request.on("error", () => outgoing.destroy());
      incoming.pipe(request);
    },
  );
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("upgrade", (request, socket, head) => {
    const remote = new URL(server.url);
    const upstream = net.connect(Number(remote.port), remote.hostname, () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(
          request.headers,
        )
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const state = join(root, "state"),
    password = randomBytes(32).toString("hex");
  const accounts = await Accounts.open(join(state, "accounts"));
  const account = await accounts.resolveVerifiedIdentity({
    issuer: "https://id.example",
    subject: "browser",
    displayName: "Browser reviewer",
  });
  const sessions = await AccountSessions.open(
    join(state, "account-sessions.json"),
    accounts,
    password,
  );
  const issued = await sessions.issue(account.id);
  await sessions.close();
  await accounts.close();
  const operatorSecret = randomBytes(32).toString("hex");
  server = await startServer({
    directory: state,
    ownerSecret: operatorSecret,
    port: 0,
    publicOrigin: origin,
    hosted: {
      issuer: "https://id.example",
      clientId: "client",
      clientSecret: "synthetic",
      cookiePassword: password,
      fetch: async () =>
        Response.json({
          issuer: "https://id.example",
          authorization_endpoint: "https://id.example/authorize",
          token_endpoint: "https://id.example/token",
          jwks_uri: "https://id.example/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
    },
  });
  const recording = await server.store.create({
    ownerId: account.id,
    requestId: "browser",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "epoch",
    writeSecret: randomBytes(32).toString("hex"),
    title: "Account private recording",
    visibility: "private",
  });
  const id = recording.info.id;
  server.store.release(recording);
  const publicRecording = await server.store.create({
    ownerId: account.id,
    requestId: "public-browser",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "public-epoch",
    writeSecret: randomBytes(32).toString("hex"),
    title: "Public discovery fixture",
    visibility: "public",
  });
  server.store.release(publicRecording);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "__Host-agentlive-session",
      value: issued.cookie,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  await page.goto(origin);
  await page
    .getByText("Signed in as Browser reviewer", { exact: true })
    .waitFor();
  const accountFile = join(root, "cli-account.json");
  const cliEnv = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: join(root, "cert.pem"),
    AGENTLIVE_OWNER_SECRET: "invalid-unused-owner",
  };
  const cli = (args) =>
    promisify(execFile)(
      process.execPath,
      ["packages/cli/dist/main.js", ...args],
      { env: cliEnv, timeout: 30000 },
    );
  let loginErrors = "";
  const loginTask = execFile(
    process.execPath,
    [
      "packages/cli/dist/main.js",
      "login",
      "--server",
      origin,
      "--account-file",
      accountFile,
    ],
    { env: cliEnv, timeout: 30000 },
  );
  const loginDone = new Promise((resolve, reject) => {
    let stdout = "";
    loginTask.stdout.on("data", (bytes) => {
      stdout += bytes.toString();
    });
    loginTask.stderr.on("data", (bytes) => {
      loginErrors += bytes.toString();
    });
    loginTask.once("error", () =>
      reject(new Error("CLI login failed to start")),
    );
    loginTask.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error("CLI login failed")),
    );
  });
  void loginDone.catch(() => {});
  try {
    for (
      let tries = 0;
      tries < 100 && !/Enter device code: ([A-F0-9]{10})/.test(loginErrors);
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const code = /Enter device code: ([A-F0-9]{10})/.exec(loginErrors)?.[1];
    assert.ok(code, "CLI must display the device code");
    await page.getByLabel("Device code", { exact: true }).fill(code);
    await page
      .getByRole("button", { name: "Approve device", exact: true })
      .click();
    await page
      .getByText("Device approved. Return to your terminal.", { exact: true })
      .waitFor();
    const loginOutput = await loginDone;
    const saved = JSON.parse(await readFile(accountFile, "utf8"));
    assert.equal(saved.serverOrigin, origin);
    assert.equal((loginOutput + loginErrors).includes(saved.token), false);
    const listed = JSON.parse(
      (await cli(["list", "--server", origin, "--account-file", accountFile]))
        .stdout,
    );
    assert.ok(listed.recordings.some((recording) => recording.id === id));
    const replayed = await cli([
      "replay",
      "--server",
      origin,
      "--stream",
      id,
      "--account-file",
      accountFile,
      "--state-dir",
      join(root, "cli-state"),
    ]);
    assert.ok(replayed.stdout.includes("Account private recording"));
    const nativeSource = join(root, "hosted-native.jsonl");
    const nativeRow = (uuid, text) =>
      JSON.stringify({
        type: "user",
        sessionId: "hosted-native",
        uuid,
        timestamp: new Date().toISOString(),
        message: { content: text },
      }) + "\n";
    await writeFile(nativeSource, nativeRow("first", "HOSTED_NATIVE_FIRST"));
    const imported = JSON.parse(
      (
        await cli([
          "import",
          "--agent",
          "claude",
          "--source",
          nativeSource,
          "--server",
          origin,
          "--account-file",
          accountFile,
          "--state-dir",
          join(root, "import-state"),
        ])
      ).stdout,
    );
    const importedSession = await server.store.get(imported.streamId);
    assert.equal(importedSession.info.ownerId, account.id);
    server.store.release(importedSession);
    const importedReplay = await cli([
      "replay",
      "--server",
      origin,
      "--stream",
      imported.streamId,
      "--account-file",
      accountFile,
      "--state-dir",
      join(root, "import-reader"),
    ]);
    assert.ok(importedReplay.stdout.includes("HOSTED_NATIVE_FIRST"));
    const archivePath = join(root, "hosted-export.agentlive");
    await cli([
      "export",
      "--server",
      origin,
      "--stream",
      imported.streamId,
      "--account-file",
      accountFile,
      "--output",
      archivePath,
    ]);
    const archiveImport = JSON.parse(
      (
        await cli([
          "import",
          "--source",
          archivePath,
          "--server",
          origin,
          "--account-file",
          accountFile,
          "--state-dir",
          join(root, "archive-import-state"),
        ])
      ).stdout,
    );
    const restoredRecording = await server.store.get(archiveImport.streamId);
    assert.equal(restoredRecording.info.ownerId, account.id);
    assert.equal(restoredRecording.info.visibility, "private");
    server.store.release(restoredRecording);
    const archiveReplay = await cli([
      "replay",
      "--server",
      origin,
      "--stream",
      archiveImport.streamId,
      "--account-file",
      accountFile,
      "--state-dir",
      join(root, "archive-reader"),
    ]);
    assert.equal(archiveReplay.stdout, importedReplay.stdout);
    report.checks.push(
      "account CLI exports/imports portable archive privately with identical replay and account ownership",
    );
    const liveSource = join(root, "hosted-live.jsonl");
    await writeFile(liveSource, nativeRow("live-first", "HOSTED_LIVE_FIRST"));
    const publisher = execFile(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "publish",
        "--agent",
        "claude",
        "--source",
        liveSource,
        "--server",
        origin,
        "--account-file",
        accountFile,
        "--state-dir",
        join(root, "publish-state"),
      ],
      { env: cliEnv, timeout: 30000 },
    );
    let publisherOutput = "";
    publisher.stdout.on("data", (bytes) => {
      publisherOutput += bytes.toString();
    });
    publisher.stderr.resume();
    const publisherExit = new Promise((resolve) =>
      publisher.once("close", resolve),
    );
    publisher.on("error", () => {});
    try {
      let liveId;
      for (let attempt = 0; attempt < 150; attempt++) {
        const ready = publisherOutput
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return {};
            }
          })
          .find((row) => row.event === "publishing");
        liveId = ready?.streamId;
        if (liveId) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(liveId, "Hosted CLI publisher must create its recording");
      await appendFile(
        liveSource,
        nativeRow("live-second", "HOSTED_LIVE_SECOND"),
      );
      let observed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await cli([
          "replay",
          "--server",
          origin,
          "--stream",
          liveId,
          "--account-file",
          accountFile,
          "--state-dir",
          join(root, "live-reader"),
        ]);
        if (result.stdout.includes("HOSTED_LIVE_SECOND")) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(
        observed,
        true,
        "Live native suffix must reach account replay",
      );
      const liveSession = await server.store.get(liveId);
      assert.equal(liveSession.info.ownerId, account.id);
      server.store.release(liveSession);
    } finally {
      publisher.kill("SIGTERM");
      const killer = setTimeout(() => publisher.kill("SIGKILL"), 5000);
      await publisherExit;
      clearTimeout(killer);
    }
    report.checks.push(
      "account CLI imports native Claude history and publishes appended native records into account-owned recordings",
    );
    await page
      .getByRole("button", { name: "Refresh devices", exact: true })
      .click();
    const revokeDevice = page.getByRole("button", { name: /^Revoke device / });
    await revokeDevice.waitFor();
    await revokeDevice.click();
    await page.getByText("No active CLI devices.", { exact: true }).waitFor();
    assert.equal(
      (
        await fetch(`${server.url}/api/v1/streams/${id}`, {
          headers: { authorization: `Bearer ${saved.token}` },
        })
      ).status,
      403,
    );
    report.checks.push(
      "browser lists approved CLI credential and revokes its private recording access",
    );
    await cli(["logout", "--server", origin, "--account-file", accountFile]);
    await assert.rejects(readFile(accountFile), { code: "ENOENT" });
    assert.equal(
      (
        await fetch(`${server.url}/api/v1/streams/${id}`, {
          headers: { authorization: `Bearer ${saved.token}` },
        })
      ).status,
      403,
    );
    report.checks.push(
      "actual CLI login, browser approval, private account listing/replay and logout with credential deletion",
    );
  } finally {
    if (loginTask.exitCode === null) loginTask.kill("SIGKILL");
  }
  await page
    .getByRole("button", { name: "Browse my recordings", exact: true })
    .click();
  await page.getByRole("button", { name: /Account private recording/ }).click();
  await page
    .getByRole("button", { name: "Manage viewing access", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Access key", { exact: false }).inputValue(),
    "",
  );
  report.checks.push("cookie-only account listing and private recording join");
  await page
    .getByRole("button", { name: "Manage viewing access", exact: true })
    .click();
  await page
    .getByText("No active viewing credentials.", { exact: true })
    .waitFor();
  await page.getByLabel("Access label", { exact: true }).fill("Account review");
  await page
    .getByRole("button", { name: "Create viewing credential", exact: true })
    .click();
  await page.getByLabel("Viewing credential", { exact: true }).waitFor();
  report.checks.push("cookie-authenticated grant issuance with CSRF transport");
  await page
    .getByRole("button", { name: "Revoke Account review", exact: true })
    .click();
  await page
    .getByText("No active viewing credentials.", { exact: true })
    .waitFor();
  report.checks.push("cookie-authenticated grant revocation");
  const visibility = page.getByRole("combobox", {
    name: "Recording visibility",
    exact: true,
  });
  for (const mode of ["public", "private"]) {
    await visibility.selectOption(mode);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/streams/${id}/visibility`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save visibility", exact: true })
      .click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).visibility, mode);
    assert.equal(
      (await fetch(`${server.url}/api/v1/streams/${id}`)).status,
      mode === "public" ? 200 : 403,
    );
    assert.equal(
      (
        await (await fetch(server.url + "/api/v1/public-recordings")).json()
      ).recordings.some((recording) => recording.id === id),
      mode === "public",
    );
    await page.waitForFunction(() => {
      const select = document.querySelector(
        'section[aria-label="Recording visibility"] select',
      );
      return select && !select.disabled;
    });
  }
  report.checks.push(
    "browser owner changes private/public visibility and restores anonymous denial",
  );
  const disposable = await server.store.create({
    ownerId: account.id,
    requestId: "browser-removal",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "remove-epoch",
    writeSecret: randomBytes(32).toString("hex"),
    title: "Removal fixture",
    visibility: "private",
  });
  const removedId = disposable.info.id;
  server.store.release(disposable);
  const removalPage = await context.newPage();
  await removalPage.goto(origin);
  await removalPage
    .getByRole("button", { name: "Browse my recordings", exact: true })
    .click();
  await removalPage.getByRole("button", { name: /Removal fixture/ }).click();
  await removalPage
    .getByRole("button", { name: "Manage viewing access", exact: true })
    .click();
  const removeButton = removalPage.getByRole("button", {
    name: "Remove recording",
    exact: true,
  });
  await removeButton.waitFor();
  assert.equal(await removeButton.isDisabled(), true);
  await removalPage
    .getByRole("checkbox", {
      name: "I want to permanently remove this recording from the service.",
    })
    .check();
  await removeButton.click();
  await removalPage
    .getByText(
      "Recording removed from the service. You can leave this recording.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await removalPage.evaluate(
      async (stream) => (await fetch(`/api/v1/streams/${stream}`)).status,
      removedId,
    ),
    404,
  );
  await removalPage.close();
  report.checks.push("browser confirmed owner removal ends service access");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Manage viewing access", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Browse my recordings", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate(
      async (stream) => (await fetch(`/api/v1/streams/${stream}`)).status,
      id,
    ),
    403,
  );
  report.checks.push(
    "sign-out clears open recording/list and private server access",
  );
  await page.reload();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  report.checks.push("signed-out state survives reload");
  await page
    .getByRole("button", { name: "Browse public recordings", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Public discovery fixture/ })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: /Account private recording/ })
      .count(),
    0,
  );
  await page.getByRole("button", { name: /Public discovery fixture/ }).click();
  await page
    .getByRole("button", { name: "Manage viewing access", exact: true })
    .waitFor();
  report.checks.push(
    "signed-out public discovery excludes private recordings and opens public playback",
  );
  await page.getByText("Report recording", { exact: true }).click();
  await page
    .getByRole("combobox", { name: /Report category/ })
    .selectOption("spam");
  await page
    .getByLabel("Report explanation", { exact: true })
    .fill("Synthetic browser report for operator review");
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.getByText(/Report received. Reference:/).waitFor();
  const reportPage = await server.store.reports.list();
  assert.equal(reportPage.reports.length, 1);
  assert.equal(reportPage.reports[0].category, "spam");
  assert.equal(
    reportPage.reports[0].details,
    "Synthetic browser report for operator review",
  );
  assert.equal(reportPage.reports[0].reporterId, undefined);
  report.checks.push(
    "signed-out browser submits public-recording report and receives durable receipt",
  );
  await page.getByLabel("Access key", { exact: false }).fill(operatorSecret);
  await page
    .getByRole("button", { name: "Review reports (operator)", exact: true })
    .click();
  const operatorPanel = page.getByRole("region", {
    name: "Operator reports",
    exact: true,
  });
  await operatorPanel
    .getByRole("combobox", { name: /Review action/ })
    .selectOption("remove");
  await operatorPanel
    .getByRole("textbox", { name: /Review note/ })
    .fill("Synthetic operator removal review");
  const saveReview = operatorPanel.getByRole("button", {
    name: "Save report decision",
    exact: true,
  });
  assert.equal(await saveReview.isDisabled(), true);
  await operatorPanel
    .getByRole("checkbox", {
      name: "I confirm permanent removal from the service.",
    })
    .check();
  await saveReview.click();
  await operatorPanel
    .getByText("Decision: removed. Synthetic operator removal review", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await server.store.reports.list()).reports[0].status,
    "removed",
  );
  report.checks.push(
    "browser operator reviews a report and explicitly confirms recording removal",
  );
  const retryFixture = await server.store.create({
    ownerId: account.id,
    requestId: "operator-retry",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "retry",
    writeSecret: randomBytes(32).toString("hex"),
    title: "Retry review fixture",
    visibility: "public",
  });
  const retryInfo = retryFixture.info;
  server.store.release(retryFixture);
  const retryReceipt = await server.store.reports.submit(
    {
      operationId: "retry-report",
      category: "other",
      details: "Pending operator review fixture",
    },
    retryInfo.id,
    retryInfo.revision,
  );
  await operatorPanel
    .getByRole("button", { name: "Refresh reports", exact: true })
    .click();
  const retryRow = operatorPanel.getByRole("article", {
    name: `Report ${retryReceipt.reportId}`,
    exact: true,
  });
  await retryRow.getByRole("combobox", { name: /Review action/ }).waitFor();
  await assert.rejects(
    server.store.reports.decide(
      retryReceipt.reportId,
      {
        operationId: "retry-review",
        action: "remove",
        revision: retryInfo.revision,
        note: "Saved pending operator decision",
      },
      async () => {
        throw new Error("Synthetic interrupted removal");
      },
    ),
  );
  await operatorPanel
    .getByRole("button", { name: "Refresh reports", exact: true })
    .click();
  const retryButton = retryRow.getByRole("button", {
    name: "Retry report decision",
    exact: true,
  });
  await retryButton.waitFor();
  assert.equal(
    await retryRow
      .getByRole("combobox", { name: /Review action/ })
      .inputValue(),
    "remove",
  );
  assert.equal(
    await retryRow.getByRole("textbox", { name: /Review note/ }).inputValue(),
    "Saved pending operator decision",
  );
  assert.equal(await retryButton.isDisabled(), true);
  await retryRow
    .getByRole("checkbox", {
      name: "I confirm permanent removal from the service.",
    })
    .check();
  await retryButton.click();
  await retryRow
    .getByText("Decision: removed. Saved pending operator decision", {
      exact: true,
    })
    .waitFor();
  report.checks.push(
    "operator refresh adopts a saved pending removal and requires explicit confirmation before retry",
  );
  const restoredFixture = await server.store.create({
    ownerId: account.id,
    requestId: "restored-report",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "restored",
    writeSecret: randomBytes(32).toString("hex"),
    title: "Restored review fixture",
    visibility: "public",
  });
  const restoredInfo = restoredFixture.info;
  server.store.release(restoredFixture);
  const restoredReceipt = await server.store.reports.submit(
    {
      operationId: "before-restore-report",
      category: "privacy",
      details: "Original report before synthetic restore",
    },
    restoredInfo.id,
    "prior-revision",
  );
  await server.store.reports.reconcileRestore([
    {
      streamId: restoredInfo.id,
      previousRevision: "prior-revision",
      revision: restoredInfo.revision,
    },
  ]);
  await operatorPanel
    .getByRole("button", { name: "Refresh reports", exact: true })
    .click();
  const restoredRow = operatorPanel.getByRole("article", {
    name: `Report ${restoredReceipt.reportId}`,
    exact: true,
  });
  await restoredRow
    .getByText(
      `This recording was restored. Review revision: ${restoredInfo.revision}. A new decision is required.`,
      { exact: true },
    )
    .waitFor();
  await restoredRow
    .getByRole("textbox", { name: /Review note/ })
    .fill("Reviewed restored revision and dismissed");
  await restoredRow
    .getByRole("button", { name: "Save report decision", exact: true })
    .click();
  await restoredRow
    .getByText(
      "Decision: dismissed. Reviewed restored revision and dismissed",
      { exact: true },
    )
    .waitFor();
  report.checks.push(
    "operator sees restored report revision and submits a fresh review against it",
  );
  assert.deepEqual(errors, []);
  report.success = true;
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await server?.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  console.log(`Probe output: ${output}`);
}
