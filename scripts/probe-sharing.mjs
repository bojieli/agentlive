#!/usr/bin/env node
/** Real production browser and server; synthetic secrets never enter the report. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "../packages/server/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "agentlive-sharing-"));
const output = resolve("probe-results", `sharing-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const ownerSecret = randomBytes(32).toString("hex");
const report = { success: false, checks: [] };
let server, browser;
try {
  server = await startServer({ directory, ownerSecret, port: 0 });
  const recording = await server.store.create({
    ownerId: "local",
    requestId: "sharing-probe",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "epoch",
    writeSecret: ownerSecret,
    title: "Synthetic sharing verification",
    visibility: "private",
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  report.browser = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  async function joinRecording(target, credential) {
    await target.goto(server.url);
    await target
      .getByLabel("Recording ID", { exact: true })
      .fill(recording.info.id);
    await target.getByLabel("Access key", { exact: false }).fill(credential);
    await target
      .getByRole("button", { name: "Join recording", exact: true })
      .click();
    await target
      .getByRole("button", { name: "Manage viewing access", exact: true })
      .waitFor();
  }
  const manage = page.getByRole("button", {
    name: "Manage viewing access",
    exact: true,
  });
  const create = page.getByRole("button", {
    name: "Create viewing credential",
    exact: true,
  });
  const check = (name) => {
    report.checks.push(name);
    console.log(name);
  };
  await joinRecording(page, ownerSecret);
  await manage.click();
  await page
    .getByText("No active viewing credentials.", { exact: true })
    .waitFor();
  check("owner opens empty grant list");
  await page.getByLabel("Access label", { exact: true }).fill("Review team");
  await page.getByLabel("Expires in days", { exact: true }).fill("7");
  await create.click();
  const field = page.getByLabel("Viewing credential", { exact: true });
  await field.waitFor();
  const token = await field.inputValue();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await field.getAttribute("type"), "password");
  const link = new URL(
    await page.getByLabel("Recording link", { exact: true }).inputValue(),
  );
  assert.equal(link.searchParams.get("stream"), recording.info.id);
  assert.equal(link.href.includes(token), false);
  await page
    .getByRole("button", { name: "Revoke Review team", exact: true })
    .waitFor();
  check("issue shows masked credential and credential-free recording link");
  const base = `${server.url}/api/v1/streams/${recording.info.id}`;
  const read = (suffix = "") =>
    fetch(base + suffix, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await read()).status, 200);
  assert.equal((await read("/viewing-grants")).status, 401);
  assert.equal((await read("/publisher-state")).status, 401);
  check("issued credential reads private recording but cannot administer");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await page
    .getByRole("button", { name: "Copy viewing credential", exact: true })
    .click();
  await page
    .getByText("Copy unavailable. Select and copy the credential field.", {
      exact: true,
    })
    .waitFor();
  check("missing clipboard API provides manual-copy feedback");
  await manage.click();
  assert.equal(await field.count(), 0);
  await manage.click();
  await page
    .getByRole("button", { name: "Revoke Review team", exact: true })
    .waitFor();
  assert.equal(await field.count(), 0);
  check("closing clears issued token while reopening retains grant metadata");
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await joinRecording(viewer, token);
  await viewer
    .getByRole("button", { name: "Manage viewing access", exact: true })
    .click();
  await viewer
    .getByRole("alert")
    .filter({ hasText: "Owner or publisher access is required" })
    .waitFor();
  check("viewer credential cannot open management data");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const accessibility = await new AxeBuilder({ page })
    .include(".sharing")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    accessibility.violations.map((item) => item.id),
    [],
  );
  report.accessibilityIncomplete = accessibility.incomplete.map(
    (item) => item.id,
  );
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  check(
    "mobile sharing has no horizontal overflow or automated accessibility violations",
  );
  await page
    .getByRole("button", { name: "Revoke Review team", exact: true })
    .click();
  await page
    .getByText("No active viewing credentials.", { exact: true })
    .waitFor();
  assert.equal((await read()).status, 403);
  check("browser revocation removes grant and denies subsequent private reads");
  assert.deepEqual(errors, []);
  report.success = true;
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(`Probe output: ${output}`);
}
