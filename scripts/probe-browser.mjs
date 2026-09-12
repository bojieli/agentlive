#!/usr/bin/env node
/** Real Chromium smoke probe. Uses synthetic private data and a fresh browser context. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "../packages/server/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "agentlive-browser-"));
const output = resolve(
  "probe-results",
  `browser-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
const ownerSecret = randomBytes(32).toString("hex");
let server;
let browser;
const report = {
  success: false,
  checks: [],
  errors: [],
  timings: [],
  phase: "startup",
};
const saveReport = () =>
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
saveReport();
try {
  server = await startServer({ directory, ownerSecret, port: 0 });
  const recording = await server.store.create({
    ownerId: "local",
    requestId: "browser-probe",
    requestedAt: new Date().toISOString(),
    publisherId: "pub",
    producerEpoch: "epoch",
    writeSecret: ownerSecret,
    title: "Synthetic browser verification",
    visibility: "private",
  });
  const { lease } = await recording.resume(ownerSecret, {
    publisherId: "pub",
    producerEpoch: "epoch",
    attempt: 1,
    revision: recording.info.revision,
  });
  let sequence = 0;
  const appendAll = (contents) =>
    recording.append(
      lease,
      contents.map((content) => ({
        protocolVersion: 1,
        streamId: recording.info.id,
        producerEpoch: "epoch",
        producerSeq: ++sequence,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock",
        elapsedMs: 0,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "native" },
        content,
      })),
    );
  const append = (content) => appendAll([content]);
  await append({
    kind: "message.started",
    payload: { messageId: "m", role: "assistant" },
  });
  await append({
    kind: "message.text.append",
    payload: { messageId: "m", text: "Browser probe first." },
  });
  await append({
    kind: "message.text.append",
    payload: { messageId: "m", text: " Second tied event." },
  });
  await recording.buildSnapshot(recording.boundary.sequence);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  let snapshotBlobs = 0;
  const newPage = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("response", (response) => {
      if (
        response.ok() &&
        new URL(response.url()).pathname.includes("/snapshot-blobs/")
      )
        snapshotBlobs++;
    });
    page.on("pageerror", (error) => report.errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        report.errors.push(`${message.text()} (${message.location().url})`);
    });
    return page;
  };
  let page = await newPage();
  const check = async (name, action) => {
    report.phase = "checking";
    report.currentCheck = name;
    const started = performance.now();
    saveReport();
    try {
      await action();
      report.checks.push(name);
      console.log(name);
    } finally {
      report.timings.push({ name, elapsedMs: performance.now() - started });
      saveReport();
    }
  };
  const position = async (viewing, received) => {
    await page
      .getByText(`Viewing ${viewing} · Received ${received}`, { exact: true })
      .waitFor();
  };
  const joinRecording = async () => {
    await page
      .getByLabel("Recording ID", { exact: true })
      .fill(recording.info.id);
    await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
    await page
      .getByRole("button", { name: "Join recording", exact: true })
      .click();
    await page
      .getByText("Loaded playback data is cached on this device.", {
        exact: true,
      })
      .waitFor();
  };
  await page.goto(server.url);
  await check("cached private join", async () => {
    await joinRecording();
    await position(4, 4);
  });
  await check("fresh IndexedDB imports server snapshot blobs", async () => {
    await page
      .getByText("Browser probe first. Second tied event.", { exact: true })
      .waitFor();
    assert.ok(
      snapshotBlobs > 0,
      "Expected verified remote snapshot content transfer",
    );
  });
  await check("exact tied previous event", async () => {
    await page
      .getByRole("button", { name: "Previous event", exact: true })
      .click();
    await position(3, 4);
    await page.getByText("Browser probe first.", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Second tied event.", { exact: false }).count(),
      0,
    );
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
  });
  await check("idle cap control", async () => {
    await page
      .getByRole("combobox", { name: "Idle gap cap", exact: true })
      .selectOption("1000");
  });
  await check("live receipt preserves paused prefix", async () => {
    await append({ kind: "message.completed", payload: { messageId: "m" } });
    await position(3, 5);
  });
  await check(
    "IndexedDB survives page reload with exact selection",
    async () => {
      // Leave initiates session cleanup; reload exercises page lifecycle persistence.
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.reload();
      assert.equal(
        await page.getByLabel("Access key", { exact: false }).inputValue(),
        "",
      );
      const databases = await page.evaluate(() => indexedDB.databases());
      assert.ok(databases.length > 0);
      await joinRecording();
      await position(3, 5);
      assert.equal(
        await page
          .getByRole("combobox", { name: "Idle gap cap", exact: true })
          .inputValue(),
        "1000",
      );
      await page.getByText("Browser probe first.", { exact: true }).waitFor();
    },
  );
  await check(
    "renderer crash preserves committed cached selection",
    async () => {
      const cdp = await context.newCDPSession(page);
      const crashed = page.waitForEvent("crash");
      // The CDP request can reject when the renderer dies; the crash event is the evidence.
      void cdp.send("Page.crash").catch(() => {});
      await crashed;
      await page.close();
      page = await newPage();
      await page.goto(server.url);
      assert.equal(
        await page.getByLabel("Access key", { exact: false }).inputValue(),
        "",
      );
      await joinRecording();
      await position(3, 5);
      await page.getByText("Browser probe first.", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("combobox", { name: "Idle gap cap", exact: true })
          .inputValue(),
        "1000",
      );
      await cdp.detach().catch(() => {});
    },
  );
  await check("keyboard next event", async () => {
    const next = page.getByRole("button", { name: "Next event", exact: true });
    await next.focus();
    await page.keyboard.press("Enter");
    await position(4, 5);
    await page
      .getByText("Browser probe first. Second tied event.", { exact: true })
      .waitFor();
  });
  await check(
    "active generation recovery preserves paused presentation",
    async () => {
      const invalidate = () =>
        page.evaluate(async () => {
          await new Promise((resolve, reject) => {
            const request = indexedDB.open("agentlive-content-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("meta", "readwrite");
              const meta = tx.objectStore("meta");
              const cursor = meta.openCursor();
              cursor.onsuccess = () => {
                const item = cursor.result;
                if (!item) return;
                if (
                  typeof item.key === "string" &&
                  item.key.startsWith("root:")
                ) {
                  const scope = item.key.slice(5);
                  const head = item.value;
                  const generation = meta.get(`generation:${scope}`);
                  generation.onsuccess = () =>
                    meta.put(
                      (generation.result ?? 0) + 1,
                      `generation:${scope}`,
                    );
                  meta.put(head.serverSeq, `recovery:${scope}`);
                  meta.delete(`root:${scope}`);
                  meta.delete(`seek:${scope}`);
                  meta.delete(`leases:${scope}`);
                }
                item.continue();
              };
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error);
              };
            };
          });
        });
      await invalidate();
      const cap = page.getByRole("combobox", {
        name: "Idle gap cap",
        exact: true,
      });
      // Saving through the old connection triggers generation rejection and reopen.
      await cap.selectOption("5000");
      await page.waitForFunction(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("agentlive-content-v1", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const request = db
              .transaction("meta")
              .objectStore("meta")
              .getAllKeys();
            request.onsuccess = () =>
              resolve(
                request.result.some(
                  (key) => typeof key === "string" && key.startsWith("root:"),
                ),
              );
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      });
      await position(4, 5);
      await page
        .getByText("Browser probe first. Second tied event.", { exact: true })
        .waitFor();
      assert.equal(await cap.inputValue(), "5000");
      await cap.selectOption("1000");
      await invalidate();
      await cap.selectOption("5000");
      const reopen = page.getByRole("button", {
        name: "Reopen playback",
        exact: true,
      });
      await reopen.waitFor();
      // The automatic recovery allowance has been consumed. A second failure
      // stays visible until explicit user action, without losing the prefix.
      await page.waitForTimeout(500);
      assert.equal(await reopen.count(), 1);
      await reopen.click();
      await position(4, 5);
      await page
        .getByText("Browser probe first. Second tied event.", { exact: true })
        .waitFor();
      assert.equal(await cap.inputValue(), "5000");
      assert.equal(await page.getByRole("alert").count(), 0);
      await cap.selectOption("1000");
    },
  );
  await check("follow live", async () => {
    await page
      .getByRole("button", { name: "Follow live", exact: true })
      .click();
    await position(5, 5);
  });
  await check("activity keyboard navigation retains row focus", async () => {
    const viewport = page.getByRole("region", {
      name: "Scrollable session activity; use arrow keys to move between items",
      exact: true,
    });
    await viewport.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("role") === "listitem",
    );
    assert.equal(
      await page.locator(":focus").getAttribute("aria-posinset"),
      "1",
    );
    await page.keyboard.press("End");
    assert.equal(
      await page.locator(":focus").getAttribute("aria-setsize"),
      "1",
    );
  });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await check(`${name} viewport has no document overflow`, async () => {
      await page.setViewportSize(viewport);
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(
        dimensions.scrollWidth <= dimensions.width + 1,
        JSON.stringify(dimensions),
      );
      await page
        .getByRole("button", { name: "Previous event", exact: true })
        .scrollIntoViewIfNeeded();
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      report.accessibility ??= {};
      report.accessibility[name] = {
        passedRules: accessibility.passes.length,
        incompleteRules: accessibility.incomplete.map(({ id, nodes }) => ({
          id,
          nodes: nodes.map(({ target, failureSummary }) => ({
            target,
            failureSummary,
          })),
        })),
        violations: accessibility.violations.map(
          ({ id, impact, description, nodes }) => ({
            id,
            impact,
            description,
            nodes: nodes.map(({ target, failureSummary }) => ({
              target,
              failureSummary,
            })),
          }),
        ),
      };
      assert.deepEqual(
        report.accessibility[name].violations,
        [],
        `${name} accessibility violations`,
      );
      await page.screenshot({
        path: join(output, `${name}.png`),
        fullPage: true,
      });
    });
  }
  await check("paged activity search", async () => {
    await page.getByRole("searchbox").fill("Second tied event");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByText("1 matching items on this page.", { exact: true })
      .waitFor();
  });
  await check("clear persistent playback cache", async () => {
    await page
      .getByRole("button", { name: "Clear playback cache", exact: true })
      .click();
    await page
      .getByText("Playback cache cleared from this device.", { exact: true })
      .waitFor();
  });
  await check("uncached fallback joins and steps", async () => {
    await page
      .getByLabel("Cache playback on this device", { exact: true })
      .uncheck();
    await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
    await page
      .getByRole("button", { name: "Join recording", exact: true })
      .click();
    await page
      .getByText("Playback data is kept for this visit only.", { exact: true })
      .waitFor();
    await position(5, 5);
    await page
      .getByRole("button", { name: "Previous event", exact: true })
      .click();
    await position(4, 5);
    await page
      .getByRole("button", { name: "Previous event", exact: true })
      .click();
    await position(3, 5);
    assert.equal(
      await page
        .getByRole("combobox", { name: "Idle gap cap", exact: true })
        .inputValue(),
      "off",
    );
    await page.getByText("Browser probe first.", { exact: true }).waitFor();
  });
  await check(
    "multi-row virtualized keyboard navigation in both cache modes",
    async () => {
      const contents = [];
      for (let index = 0; index < 64; index++) {
        const messageId = `navigation-${index}`;
        contents.push(
          {
            kind: "message.started",
            payload: { messageId, role: "assistant" },
          },
          {
            kind: "message.text.append",
            payload: {
              messageId,
              text:
                `Navigation row ${index + 1}. ` +
                "Synthetic content. ".repeat(20),
            },
          },
          { kind: "message.completed", payload: { messageId } },
        );
      }
      for (let offset = 0; offset < contents.length; offset += 64)
        await recording.append(
          lease,
          contents.slice(offset, offset + 64).map((content) => ({
            protocolVersion: 1,
            streamId: recording.info.id,
            producerEpoch: "epoch",
            producerSeq: ++sequence,
            observedAt: new Date().toISOString(),
            clockSegmentId: "clock",
            elapsedMs: 0,
            fidelity: "delta",
            source: { agent: "synthetic", sessionId: "native" },
            content,
          })),
        );
      await recording.buildSnapshot(recording.boundary.sequence);
      for (const cached of [true, false]) {
        await page.getByRole("button", { name: "Leave", exact: true }).click();
        await page
          .getByLabel("Cache playback on this device", { exact: true })
          .setChecked(cached);
        await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
        await page
          .getByRole("button", { name: "Join recording", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Follow live", exact: true })
          .click();
        await position(
          recording.boundary.sequence,
          recording.boundary.sequence,
        );
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        const viewport = page.getByRole("region", {
          name: "Scrollable session activity; use arrow keys to move between items",
          exact: true,
        });
        await viewport.focus();
        for (const [key, expected] of [
          ["Home", 1],
          ["End", 65],
          ["ArrowUp", 64],
          ["ArrowDown", 65],
          ["Home", 1],
        ]) {
          await page.keyboard.press(key);
          await page.waitForFunction(
            (expected) =>
              document.activeElement?.getAttribute("aria-posinset") ===
              String(expected),
            expected,
          );
          assert.equal(
            await page.locator(":focus").getAttribute("aria-setsize"),
            "65",
          );
          await page
            .waitForFunction(() => {
              const focused = document.activeElement;
              const viewport = focused?.closest(".activity-viewport");
              if (!focused || !viewport) return false;
              const row = focused.getBoundingClientRect(),
                frame = viewport.getBoundingClientRect();
              return row.bottom > frame.top && row.top < frame.bottom;
            })
            .catch(async (error) => {
              report.navigationFailure = {
                cached,
                key,
                expected,
                geometry: await page.evaluate(() => {
                  const focused = document.activeElement;
                  const viewport = focused?.closest(".activity-viewport");
                  return {
                    position: focused?.getAttribute("aria-posinset"),
                    row: focused?.getBoundingClientRect().toJSON(),
                    viewport: viewport?.getBoundingClientRect().toJSON(),
                    scrollTop: viewport?.scrollTop,
                    scrollHeight: viewport?.scrollHeight,
                  };
                }),
              };
              throw error;
            });
        }
        const mounted = await viewport.getByRole("listitem").count();
        assert.ok(
          mounted < 30,
          `Expected bounded virtual rows, got ${mounted}`,
        );
        await page.screenshot({
          path: join(
            output,
            cached ? "navigation-cached.png" : "navigation-memory.png",
          ),
          fullPage: true,
        });
        report.navigation ??= [];
        report.navigation.push({
          cached,
          totalRows: 65,
          mountedRows: mounted,
          focusedPosition: 1,
        });
        await viewport.hover();
        await page.mouse.wheel(0, 1800);
        await page.waitForFunction(() => {
          const viewport = document.querySelector(".activity-viewport");
          return viewport && viewport.scrollTop > 1000;
        });
        // Allow delayed card measurements to settle: they must not undo the
        // user's scroll by dragging the keyboard-focused first row back.
        await page.waitForTimeout(500);
        assert.ok(
          await viewport.evaluate((element) => element.scrollTop > 1000),
        );
        report.navigation.at(-1).manualScrollPreserved = true;
      }
    },
  );
  await check(
    "tool disclosure and text page choices survive cached reopen",
    async () => {
      await append({
        kind: "tool.started",
        payload: {
          toolId: "persist-tool",
          name: "Inspection probe",
          input: "synthetic input",
        },
      });
      await append({
        kind: "tool.completed",
        payload: {
          toolId: "persist-tool",
          status: "completed",
          output:
            "synthetic output".padEnd(16384, ".") +
            "middle page".padEnd(16384, ".") +
            "latest page",
        },
      });
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page
        .getByLabel("Cache playback on this device", { exact: true })
        .setChecked(true);
      await joinRecording();
      const showTool = async () => {
        await page
          .getByRole("button", { name: "Follow live", exact: true })
          .click();
        await position(
          recording.boundary.sequence,
          recording.boundary.sequence,
        );
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        const viewport = page.getByRole("region", {
          name: "Scrollable session activity; use arrow keys to move between items",
          exact: true,
        });
        await viewport.focus();
        await page.keyboard.press("End");
        await page.locator("#tools-persist-tool summary").waitFor();
      };
      await showTool();
      const details = page.locator("#tools-persist-tool");
      await details.locator("summary").click();
      assert.equal(await details.evaluate((element) => element.open), true);
      const textNavigation = details.locator(".text-navigation");
      assert.match(await textNavigation.innerText(), /page 1 of 3/);
      await textNavigation
        .getByRole("button", { name: "Next", exact: true })
        .click();
      await details.locator("pre").filter({ hasText: "middle page" }).waitFor();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.reload();
      await joinRecording();
      await showTool();
      assert.equal(await details.evaluate((element) => element.open), true);
      await details.locator("pre").filter({ hasText: "middle page" }).waitFor();
      assert.match(await textNavigation.innerText(), /page 2 of 3/);
      await textNavigation
        .getByRole("button", { name: "Follow latest text", exact: true })
        .click();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await joinRecording();
      await showTool();
      await details.getByText("latest page", { exact: true }).waitFor();
      assert.equal(
        await textNavigation
          .getByRole("button", { name: "Follow latest text", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await details.locator("summary").click();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await joinRecording();
      await showTool();
      assert.equal(await details.evaluate((element) => element.open), false);
    },
  );
  await check(
    "attachment inspector restores exact version and rejects unavailable history",
    async () => {
      const bytes = Buffer.from("Persisted attachment inspection probe");
      const descriptor = {
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      };
      await recording.uploadAttachment(
        ownerSecret,
        descriptor,
        (async function* () {
          yield bytes;
        })(),
      );
      const attachment = {
        ...descriptor,
        artifactId: "persist-artifact",
        version: 1,
        filename: "inspection.txt",
        mediaType: "text/plain",
      };
      await append({ kind: "attachment.available", payload: { attachment } });
      const newerBytes = Buffer.from(
        "Newer attachment version must not replace the selected version",
      );
      const newer = {
        hash: createHash("sha256").update(newerBytes).digest("hex"),
        byteSize: newerBytes.length,
      };
      await recording.uploadAttachment(
        ownerSecret,
        newer,
        (async function* () {
          yield newerBytes;
        })(),
      );
      await append({
        kind: "attachment.available",
        payload: { attachment: { ...attachment, ...newer, version: 2 } },
      });
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page
        .getByRole("region", {
          name: "Scrollable session activity; use arrow keys to move between items",
          exact: true,
        })
        .focus();
      await page.keyboard.press("End");
      await page
        .getByRole("button", { name: "Open version 1", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Attachment inspector" });
      await dialog.getByText(bytes.toString(), { exact: true }).waitFor();
      const savedChoice = async (present) =>
        page.waitForFunction(async (present) => {
          return await new Promise((resolve, reject) => {
            const request = indexedDB.open("agentlive-content-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result,
                tx = db.transaction("meta", "readonly"),
                keys = tx.objectStore("meta").getAllKeys();
              let found = false;
              keys.onsuccess = () => {
                found = keys.result.some((key) =>
                  String(key).startsWith("attachment-choice:"),
                );
              };
              tx.oncomplete = () => {
                db.close();
                resolve(found === present);
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          });
        }, present);
      await savedChoice(true);
      await page.reload();
      await joinRecording();
      await dialog.getByText(bytes.toString(), { exact: true }).waitFor();
      await dialog
        .getByRole("button", { name: "Close attachment", exact: true })
        .click();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await joinRecording();
      assert.equal(await dialog.count(), 0);
      await savedChoice(false);
      await page
        .getByRole("button", { name: "Previous event", exact: true })
        .click();
      await position(
        recording.boundary.sequence - 1,
        recording.boundary.sequence,
      );
      await page
        .getByRole("button", { name: "Previous event", exact: true })
        .click();
      await position(
        recording.boundary.sequence - 2,
        recording.boundary.sequence,
      );
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      // A saved inspection can outlive the prefix where that version was visible.
      await page.evaluate(async (attachment) => {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("agentlive-content-v1", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("meta", "readwrite"),
              meta = tx.objectStore("meta"),
              keys = meta.getAllKeys();
            keys.onsuccess = () => {
              const root = keys.result.find((key) =>
                String(key).startsWith("root:"),
              );
              if (!root) {
                tx.abort();
                return;
              }
              meta.put(
                attachment,
                `attachment-choice:${String(root).slice(5)}`,
              );
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error ?? new Error("Missing root"));
            };
          };
        });
      }, attachment);
      await joinRecording();
      await position(
        recording.boundary.sequence - 2,
        recording.boundary.sequence,
      );
      await savedChoice(false);
      assert.equal(await dialog.count(), 0);
    },
  );
  await check(
    "automatic latest text survives paused virtual remount in both cache modes",
    async () => {
      await append({
        kind: "message.started",
        payload: { messageId: "default-pages", role: "assistant" },
      });
      await append({
        kind: "message.text.append",
        payload: {
          messageId: "default-pages",
          text:
            "first default page".padEnd(16384, ".") +
            "middle default page".padEnd(16384, ".") +
            "last default page",
        },
      });
      for (const cached of [false, true]) {
        await page.getByRole("button", { name: "Leave", exact: true }).click();
        await page
          .getByLabel("Cache playback on this device", { exact: true })
          .setChecked(cached);
        await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
        await page
          .getByRole("button", { name: "Join recording", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Follow live", exact: true })
          .click();
        await position(
          recording.boundary.sequence,
          recording.boundary.sequence,
        );
        const viewport = page.getByRole("region", {
          name: "Scrollable session activity; use arrow keys to move between items",
          exact: true,
        });
        await viewport.focus();
        await page.keyboard.press("End");
        const message = page.locator("#messages-default-pages");
        await message.getByText("last default page", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        const remount = async () => {
          await viewport.focus();
          await page.keyboard.press("Home");
          await message.waitFor({ state: "detached" });
          await page.keyboard.press("End");
          await message.waitFor();
        };
        await remount();
        await message.getByText("last default page", { exact: true }).waitFor();
        await message
          .getByRole("button", { name: "First", exact: true })
          .click();
        await message
          .getByRole("button", { name: "Next", exact: true })
          .click();
        await remount();
        await message
          .locator("pre")
          .filter({ hasText: "middle default page" })
          .waitFor();
      }
    },
  );
  await check(
    "attachment version pages survive remount, cached reopen and history clamping",
    async () => {
      const bytes = Buffer.from("Version pagination fixture");
      const descriptor = {
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      };
      await recording.uploadAttachment(
        ownerSecret,
        descriptor,
        (async function* () {
          yield bytes;
        })(),
      );
      for (let version = 1; version <= 65; version++) {
        await append({
          kind: "attachment.available",
          payload: {
            attachment: {
              ...descriptor,
              artifactId: "version-pages",
              version,
              filename: "versions.txt",
              mediaType: "text/plain",
            },
          },
        });
      }
      for (const cached of [true, false]) {
        await page.getByRole("button", { name: "Leave", exact: true }).click();
        await page
          .getByLabel("Cache playback on this device", { exact: true })
          .setChecked(cached);
        await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
        await page
          .getByRole("button", { name: "Join recording", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Follow live", exact: true })
          .click();
        await position(
          recording.boundary.sequence,
          recording.boundary.sequence,
        );
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        const viewport = page.getByRole("region", {
          name: "Scrollable session activity; use arrow keys to move between items",
          exact: true,
        });
        const card = page.locator("#artifacts-version-pages");
        const show = async () => {
          await viewport.focus();
          await page.keyboard.press("End");
          await card.waitFor();
        };
        await show();
        await card.getByText("Versions 1–32 of 65", { exact: true }).waitFor();
        assert.equal(
          await card.getByRole("button", { name: /^Open version/ }).count(),
          32,
        );
        await card
          .getByRole("button", { name: "Next versions", exact: true })
          .click();
        await card.getByText("Versions 33–64 of 65", { exact: true }).waitFor();
        await card
          .getByRole("button", { name: "Next versions", exact: true })
          .click();
        await card.getByText("Versions 65–65 of 65", { exact: true }).waitFor();
        await viewport.focus();
        await page.keyboard.press("Home");
        await card.waitFor({ state: "detached" });
        await show();
        await card.getByText("Versions 65–65 of 65", { exact: true }).waitFor();
        if (cached) {
          await page
            .getByRole("button", { name: "Leave", exact: true })
            .click();
          await page.reload();
          await joinRecording();
          await show();
          await card
            .getByText("Versions 65–65 of 65", { exact: true })
            .waitFor();
        }
        await page
          .getByRole("button", { name: "Previous event", exact: true })
          .click();
        await position(
          recording.boundary.sequence - 1,
          recording.boundary.sequence,
        );
        await show();
        await card.getByText("Versions 33–64 of 64", { exact: true }).waitFor();
        assert.equal(
          await card.getByRole("button", { name: /^Open version/ }).count(),
          32,
        );
        if (cached) {
          await page
            .getByRole("button", { name: "Leave", exact: true })
            .click();
          await joinRecording();
          await show();
          await card
            .getByText("Versions 33–64 of 64", { exact: true })
            .waitFor();
        }
        await page
          .getByRole("button", { name: "Next event", exact: true })
          .click();
        await position(
          recording.boundary.sequence,
          recording.boundary.sequence,
        );
        await show();
        await card.getByText("Versions 65–65 of 65", { exact: true }).waitFor();
        assert.equal(
          await card.getByRole("button", { name: /^Open version/ }).count(),
          1,
        );
      }
    },
  );
  const keyboard = (report.keyboard ??= {});
  const semantics = (report.semantics ??= {});
  // Describes the focused element the way a keyboard user perceives it.
  const focusDescription = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body)
        return { tag: "body", name: "", lost: true };
      const element = active;
      const label =
        element.getAttribute("aria-label") ??
        (element.labels?.[0]?.textContent ?? "").trim() ??
        "";
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        name: (label || (element.textContent ?? "").trim()).slice(0, 60),
        posinset: element.getAttribute("aria-posinset") ?? "",
        id: element.id,
        type: element.getAttribute("type") ?? "",
        inViewport: !!element.closest(".activity-viewport"),
        inDialog: !!element.closest("dialog"),
        lost: false,
      };
    });
  const startFromDocument = () =>
    page.evaluate(() => {
      document.activeElement instanceof HTMLElement &&
        document.activeElement.blur();
      document.body.focus();
    });
  const tabUntil = async (match, limit = 60) => {
    for (let index = 0; index < limit; index++) {
      await page.keyboard.press("Tab");
      const stop = await focusDescription();
      if (match(stop)) return stop;
    }
    throw new Error(`No Tab stop matched within ${limit} presses`);
  };
  const axNodes = async () => {
    const session = await context.newCDPSession(page);
    try {
      await session.send("Accessibility.enable");
      const { nodes } = await session.send("Accessibility.getFullAXTree");
      return nodes
        .filter((node) => !node.ignored)
        .map((node) => ({
          role: node.role?.value ?? "",
          name: node.name?.value ?? "",
          description: node.description?.value ?? "",
          properties: Object.fromEntries(
            (node.properties ?? []).map((property) => [
              property.name,
              property.value?.value,
            ]),
          ),
        }));
    } finally {
      await session.detach().catch(() => {});
    }
  };
  // Concurrent card loading can hit the content store's bounded queue; the
  // card then offers an explicit retry. Take it before asserting on content.
  const settleRows = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = page.getByRole("button", {
        name: "Retry activity",
        exact: true,
      });
      if (!(await retry.count())) return;
      await retry.first().click();
      await page.waitForTimeout(400);
    }
  };
  const waitForCard = async (selector) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await page.locator(selector).waitFor({ timeout: 4000 });
        return;
      } catch {
        await settleRows();
      }
    }
    await page.locator(selector).waitFor();
  };
  const liveRegions = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[aria-live],[role=status],[role=alert],[role=log]",
        ),
      ].map((element) => ({
        role: element.getAttribute("role") ?? "",
        live:
          element.getAttribute("aria-live") ??
          (element.getAttribute("role") === "alert" ? "assertive" : "polite"),
        atomic: element.getAttribute("aria-atomic") ?? "",
        inFeedList: !!element.closest(".activity-viewport"),
        containsFeedList: !!element.querySelector(".activity-viewport"),
        text: (element.textContent ?? "").trim().slice(0, 80),
      })),
    );

  await check(
    "keyboard-only join reaches the private form and enters playback",
    async () => {
      await page.goto(server.url);
      await startFromDocument();
      const before = [];
      const field = await (async () => {
        for (let index = 0; index < 12; index++) {
          await page.keyboard.press("Tab");
          const stop = await focusDescription();
          if (stop.tag === "input" && stop.name.startsWith("Recording ID"))
            return stop;
          before.push(stop);
        }
        throw new Error("Recording ID field is not reachable by Tab");
      })();
      assert.ok(
        before.every((stop) => !stop.lost),
        "Tab order passed through the document body before the join form",
      );
      assert.ok(
        before.length <= 2,
        `Expected the join form near the start of the Tab order, got ${JSON.stringify(before)}`,
      );
      await page.keyboard.type(recording.info.id);
      const key = await tabUntil(
        (stop) => stop.name.startsWith("Access key"),
        3,
      );
      assert.equal(key.type, "password");
      await page.keyboard.type(ownerSecret);
      const cache = await tabUntil((stop) => stop.type === "checkbox", 3);
      assert.equal(cache.name, "Cache playback on this device");
      const submit = await tabUntil(
        (stop) => stop.name === "Join recording",
        3,
      );
      assert.equal(submit.tag, "button");
      await page.keyboard.press("Enter");
      await page
        .getByText("Loaded playback data is cached on this device.", {
          exact: true,
        })
        .waitFor();
      // Activating Join unmounts nothing the user was on, but the new
      // playback context is far down the Tab order: focus must be moved.
      await page.waitForFunction(
        () => document.activeElement?.tagName === "H2",
      );
      const heading = await focusDescription();
      assert.equal(heading.tag, "h2");
      assert.equal(heading.name, "Synthetic browser verification");
      keyboard.joinStops = before.length + 4;
    },
  );

  await check(
    "every visible control is reachable by Tab and has a name",
    async () => {
      // A cached visit reopens at its saved position; take the whole
      // control set live and then paused, as a viewer would.
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const candidates = await page.evaluate(() => {
        const selector =
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]';
        let id = 0;
        const found = [];
        for (const element of document.querySelectorAll(selector)) {
          if (!element.getClientRects().length) continue;
          if (element.closest("[inert]")) continue;
          // Collapsed disclosure content is not part of the Tab order.
          const collapsed = element.closest("details:not([open])");
          if (collapsed && element !== collapsed.querySelector("summary"))
            continue;
          element.setAttribute("data-probe-tab", `k${id}`);
          found.push({
            key: `k${id++}`,
            tag: element.tagName.toLowerCase(),
            text: (
              element.getAttribute("aria-label") ??
              element.textContent ??
              ""
            )
              .trim()
              .slice(0, 40),
          });
        }
        return found;
      });
      // Start from the first control so the walk covers one whole cycle.
      await page.locator("[data-probe-tab=k0]").focus();
      const visited = new Set(["k0"]);
      const stops = [];
      let lost = 0;
      for (let index = 0; index < candidates.length * 2; index++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
          const active = document.activeElement;
          if (!active || active === document.body) return { lost: true };
          return {
            key: active.getAttribute("data-probe-tab"),
            tag: active.tagName.toLowerCase(),
            text: (active.textContent ?? "").trim().slice(0, 40),
            lost: false,
          };
        });
        if (stop.lost) {
          // One pass through the document is the wrap at the end of the page.
          lost++;
          continue;
        }
        stops.push(stop);
        if (stop.key) visited.add(stop.key);
        if (visited.size === candidates.length) break;
      }
      assert.ok(lost <= 1, `Tab order lost focus ${lost} times`);
      const unreachable = candidates.filter(
        (candidate) => !visited.has(candidate.key),
      );
      assert.deepEqual(
        unreachable,
        [],
        `Controls reachable only by pointer: ${JSON.stringify(unreachable)}`,
      );
      const nodes = await axNodes();
      const controls = nodes.filter((node) =>
        [
          "button",
          "link",
          "textbox",
          "combobox",
          "slider",
          "checkbox",
          "searchbox",
          "image",
          "dialog",
          "listbox",
          "spinbutton",
        ].includes(node.role),
      );
      const unnamed = controls.filter((node) => !node.name.trim());
      assert.deepEqual(
        unnamed,
        [],
        `Controls without an accessible name: ${JSON.stringify(unnamed)}`,
      );
      keyboard.tabStops = stops.length;
      keyboard.controls = candidates.length;
      keyboard.namedControls = controls.length;
      await page.evaluate(() => {
        for (const element of document.querySelectorAll("[data-probe-tab]"))
          element.removeAttribute("data-probe-tab");
      });
    },
  );

  await check(
    "player controls follow Tab order and announce playback state",
    async () => {
      const announcement = page.locator(".player p[role=status]");
      // Step back once so both stepping controls are enabled and in the order.
      await page
        .getByRole("button", { name: "Previous event", exact: true })
        .click();
      await position(
        recording.boundary.sequence - 1,
        recording.boundary.sequence,
      );
      await page.getByRole("button", { name: "Leave", exact: true }).focus();
      const order = [];
      for (let index = 0; index < 7; index++) {
        await page.keyboard.press("Tab");
        order.push((await focusDescription()).name);
      }
      assert.deepEqual(order, [
        "Play",
        "Follow live",
        "Previous event",
        "Next event",
        "Playback speed",
        "Idle gap cap",
        "Timeline",
      ]);
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await position(recording.boundary.sequence, recording.boundary.sequence);
      await assert.doesNotReject(
        announcement.getByText("Following live at 1× speed").waitFor(),
      );
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await pause.focus();
      await page.keyboard.press("Enter");
      await announcement
        .getByText(
          `Paused at 1× speed, event ${recording.boundary.sequence} of ${recording.boundary.sequence}`,
          { exact: true },
        )
        .waitFor();
      const previous = page.getByRole("button", {
        name: "Previous event",
        exact: true,
      });
      await previous.focus();
      await page.keyboard.press("Enter");
      await position(
        recording.boundary.sequence - 1,
        recording.boundary.sequence,
      );
      assert.equal(
        await focusDescription().then((stop) => stop.name),
        "Previous event",
      );
      // The raw slider value is milliseconds; only aria-valuetext carries a
      // position a listener can understand.
      const timeline = page.getByRole("slider", { name: "Timeline" });
      const viewing = async () =>
        Number(
          /Viewing (\d+)/.exec(
            await page.locator(".timeline-labels").innerText(),
          )[1],
        );
      const startedAt = await viewing();
      await timeline.focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(
        () => document.querySelector('input[type="range"]')?.value === "0",
      );
      await page.waitForFunction(
        (previous) =>
          Number(
            /Viewing (\d+)/.exec(
              document.querySelector(".timeline-labels")?.textContent ?? "",
            )?.[1],
          ) < previous,
        startedAt,
      );
      const text = await timeline.getAttribute("aria-valuetext");
      assert.match(text ?? "", /^0\.0s of \d+\.\ds, event \d+ of \d+$/);
      await page.keyboard.press("End");
      await page.waitForFunction(
        (previous) =>
          Number(
            /Viewing (\d+)/.exec(
              document.querySelector(".timeline-labels")?.textContent ?? "",
            )?.[1],
          ) >= previous,
        startedAt,
      );
      keyboard.timeline = {
        start: text,
        end: await timeline.getAttribute("aria-valuetext"),
      };
      const speed = page.getByRole("combobox", { name: "Playback speed" });
      await speed.focus();
      await page.keyboard.press("2");
      await page.waitForFunction(
        () =>
          document.querySelector('select[aria-label="Playback speed"]')
            ?.value === "2",
      );
      await announcement.getByText("2× speed", { exact: false }).waitFor();
      // Chrome's select type-ahead buffers characters; let it lapse first.
      await page.waitForTimeout(1500);
      await page.keyboard.press("1");
      await page.waitForFunction(
        () =>
          document.querySelector('select[aria-label="Playback speed"]')
            ?.value === "1",
      );
    },
  );

  await check(
    "accessibility tree exposes landmarks, headings and alternatives",
    async () => {
      const nodes = await axNodes();
      const landmarks = nodes
        .filter((node) =>
          ["banner", "complementary", "main", "region", "search"].includes(
            node.role,
          ),
        )
        .map((node) => `${node.role}:${node.name}`);
      for (const required of [
        "banner:",
        "complementary:",
        "main:",
        "region:Playback controls",
        "region:Session activity",
      ])
        assert.ok(
          landmarks.includes(required),
          `Missing landmark ${required} in ${JSON.stringify(landmarks)}`,
        );
      const headings = await page.evaluate(() =>
        [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
          .filter((element) => element.getClientRects().length)
          .map((element) => ({
            level: Number(element.tagName.slice(1)),
            text: (element.textContent ?? "").trim().slice(0, 40),
          })),
      );
      assert.equal(headings[0]?.level, 1, JSON.stringify(headings));
      for (let index = 1; index < headings.length; index++)
        assert.ok(
          headings[index].level <= headings[index - 1].level + 1,
          `Heading level skips from ${headings[index - 1].level} to ${headings[index].level} at ${headings[index].text}`,
        );
      const images = await page.evaluate(() =>
        [...document.querySelectorAll("img")].map((element) => ({
          alt: element.getAttribute("alt"),
          hidden: element.getAttribute("aria-hidden"),
        })),
      );
      assert.ok(
        images.every((image) => image.hidden === "true" || image.alt),
        `Images without a text alternative: ${JSON.stringify(images)}`,
      );
      const decorated = nodes.filter(
        (node) => node.name.includes("◉") || node.name.includes("●"),
      );
      assert.deepEqual(
        decorated,
        [],
        `Decorative glyphs are exposed as text: ${JSON.stringify(decorated)}`,
      );
      const brand = nodes.find((node) => node.role === "link");
      assert.equal(brand?.name, "AgentLive");
      semantics.landmarks = landmarks;
      semantics.headings = headings.map((heading) => heading.level);
    },
  );

  await check(
    "activity announcements are polite, atomic and outside the feed",
    async () => {
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      const before = await liveRegions();
      assert.deepEqual(
        before.filter((region) => region.containsFeedList),
        [],
        "A live region wraps the whole activity feed",
      );
      assert.deepEqual(
        before.filter((region) => region.live === "assertive" && !region.text),
        [],
      );
      assert.deepEqual(
        before.filter((region) => region.inFeedList && region.text),
        [],
        "Virtualized rows carry live regions with text",
      );
      const announcer = page.locator(".activity > p[role=status]");
      assert.equal(await announcer.getAttribute("aria-atomic"), "true");
      // Let any coalescing window opened by joining close before measuring.
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        const target = document.querySelector(".activity > p[role=status]");
        const announcements = [];
        Object.assign(window, { announcements });
        new MutationObserver(() => {
          const text = (target.textContent ?? "").trim();
          if (text && text !== announcements.at(-1)) announcements.push(text);
        }).observe(target, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      const contents = [];
      for (const suffix of ["one", "two", "three"]) {
        const messageId = `announce-${suffix}`;
        contents.push(
          {
            kind: "message.started",
            payload: { messageId, role: "assistant" },
          },
          {
            kind: "message.text.append",
            payload: { messageId, text: `Announced ${suffix}.` },
          },
          { kind: "message.completed", payload: { messageId } },
        );
      }
      await appendAll(contents);
      await position(recording.boundary.sequence, recording.boundary.sequence);
      await page.waitForFunction(
        () =>
          (
            document.querySelector(".activity > p[role=status]")?.textContent ??
            ""
          ).length > 0,
        undefined,
        { timeout: 10000 },
      );
      assert.equal(await announcer.getAttribute("aria-live"), null);
      assert.equal(await announcer.getAttribute("role"), "status");
      // Three arriving items must produce one announcement, not three.
      await page.waitForTimeout(3000);
      const announcements = await page.evaluate(() => window.announcements);
      assert.equal(
        announcements.length,
        1,
        `Expected one coalesced announcement, got ${JSON.stringify(announcements)}`,
      );
      const message = announcements[0];
      assert.match(
        message,
        /^[1-9]\d* new activity items?; \d+ in view\.$/,
        message,
      );
      semantics.announcement = message;
      semantics.liveRegions = (await liveRegions()).map(
        (region) =>
          `${region.role || region.live}:${region.inFeedList ? "feed" : "page"}`,
      );
    },
  );

  await check(
    "row focus survives virtualized remounting during live receipt",
    async () => {
      const viewport = page.getByRole("region", {
        name: "Scrollable session activity; use arrow keys to move between items",
        exact: true,
      });
      await viewport.focus();
      await page.keyboard.press("End");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("role") === "listitem",
      );
      const before = await focusDescription();
      const rows = Number(
        await page.locator(":focus").getAttribute("aria-setsize"),
      );
      const contents = [];
      for (const suffix of ["live-one", "live-two"]) {
        contents.push(
          {
            kind: "message.started",
            payload: { messageId: suffix, role: "assistant" },
          },
          {
            kind: "message.text.append",
            payload: { messageId: suffix, text: `Live remount ${suffix}.` },
          },
          { kind: "message.completed", payload: { messageId: suffix } },
        );
      }
      await appendAll(contents);
      await page.waitForFunction(
        (rows) =>
          Number(
            document
              .querySelector(".activity-viewport [role=listitem]")
              ?.getAttribute("aria-setsize"),
          ) > rows,
        rows,
      );
      const after = await focusDescription();
      assert.equal(after.lost, false, "Focus was dropped on the document body");
      assert.equal(after.inViewport, true, JSON.stringify(after));
      keyboard.liveFocus = { before: before.posinset, after: after.posinset };
      assert.equal(after.posinset, before.posinset);
    },
  );

  await check(
    "focus stays with a row scrolled out of view and returns on arrow keys",
    async () => {
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const viewport = page.getByRole("region", {
        name: "Scrollable session activity; use arrow keys to move between items",
        exact: true,
      });
      await viewport.focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-posinset") === "1",
      );
      // PageDown scrolls the region natively and must not be undone by the
      // keyboard-navigation correction that follows an explicit Home/End move.
      const rowVisible = () =>
        page.evaluate(() => {
          const active = document.activeElement;
          const frame = active?.closest(".activity-viewport");
          if (!active || !frame) return true;
          const row = active.getBoundingClientRect(),
            box = frame.getBoundingClientRect();
          return row.bottom > box.top && row.top < box.bottom;
        });
      for (let index = 0; index < 12 && (await rowVisible()); index++) {
        await page.keyboard.press("PageDown");
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(500);
      const scrolled = await focusDescription();
      assert.equal(scrolled.lost, false);
      assert.equal(scrolled.posinset, "1", JSON.stringify(scrolled));
      const offscreen = await page.evaluate(() => {
        const active = document.activeElement;
        const frame = active?.closest(".activity-viewport");
        if (!active || !frame) return null;
        const row = active.getBoundingClientRect(),
          box = frame.getBoundingClientRect();
        return { visible: row.bottom > box.top && row.top < box.bottom };
      });
      assert.equal(
        offscreen?.visible,
        false,
        "Expected the row to be offscreen",
      );
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-posinset") === "2",
      );
      await page.waitForFunction(() => {
        const active = document.activeElement;
        const frame = active?.closest(".activity-viewport");
        if (!active || !frame) return false;
        const row = active.getBoundingClientRect(),
          box = frame.getBoundingClientRect();
        return row.bottom > box.top && row.top < box.bottom;
      });
      keyboard.offscreenFocusRetained = true;
    },
  );

  await check(
    "keyboard search opens a result and moves focus to the row",
    async () => {
      // Settle pending card loads first: taking a card's retry control would
      // move focus itself, which is not what this check measures.
      await settleRows();
      const search = page.getByRole("searchbox");
      await search.focus();
      await page.keyboard.type("Navigation row 7.");
      await page.keyboard.press("Enter");
      await page
        .getByText("1 matching items on this page.", { exact: true })
        .waitFor();
      const result = await tabUntil(
        (stop) => stop.name.startsWith("messages"),
        6,
      );
      assert.ok(result.name.includes("Navigation row 7"), result.name);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("role") === "listitem",
      );
      await page
        .waitForFunction(() =>
          (document.activeElement?.textContent ?? "").includes(
            "Navigation row 7.",
          ),
        )
        .catch(async (error) => {
          // Retain which row an opened result actually focused.
          report.searchFailure = await focusDescription();
          report.searchFailure.rows = await page.evaluate(() =>
            [...document.querySelectorAll(".activity-viewport [role=listitem]")]
              .map(
                (element) =>
                  `${element.getAttribute("aria-posinset")}=${(element.textContent ?? "").trim().slice(0, 30)}`,
              )
              .sort(),
          );
          report.searchFailure.matches = await page
            .locator(".activity-search li button")
            .allInnerTexts();
          throw error;
        });
      const row = await focusDescription();
      assert.equal(row.inViewport, true);
      keyboard.searchResultPosition = row.posinset;
    },
  );

  await check(
    "tool disclosure and text paging operate from the keyboard",
    async () => {
      await appendAll([
        {
          kind: "tool.started",
          payload: {
            toolId: "keyboard-tool",
            name: "Keyboard probe",
            input: "keyboard input",
          },
        },
        {
          kind: "tool.completed",
          payload: {
            toolId: "keyboard-tool",
            status: "completed",
            output:
              "keyboard page one".padEnd(16384, ".") +
              "keyboard page two".padEnd(16384, ".") +
              "keyboard page three",
          },
        },
      ]);
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      const viewport = page.getByRole("region", {
        name: "Scrollable session activity; use arrow keys to move between items",
        exact: true,
      });
      await viewport.focus();
      await page.keyboard.press("End");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await viewport.focus();
      await page.keyboard.press("End");
      await waitForCard("#tools-keyboard-tool summary");
      const details = page.locator("#tools-keyboard-tool");
      const summary = await tabUntil(
        (stop) =>
          stop.tag === "summary" && stop.name.includes("Keyboard probe"),
        8,
      );
      assert.equal(summary.tag, "summary");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector("#tools-keyboard-tool")?.open === true,
      );
      assert.equal(
        (await focusDescription()).tag,
        "summary",
        "Expanding moved focus away from the disclosure",
      );
      const navigation = details.locator(".text-navigation").last();
      await navigation
        .locator("span.muted")
        .getByText("Tool output: page 1 of 3")
        .waitFor();
      const next = await tabUntil((stop) => stop.name === "Next", 12);
      assert.equal(next.tag, "button");
      await page.keyboard.press("Enter");
      await navigation
        .locator("span.muted")
        .getByText("Tool output: page 2 of 3")
        .waitFor();
      assert.equal(
        (await focusDescription()).name,
        "Next",
        "Paging moved focus away from the control",
      );
      const status = navigation.locator("[role=status]");
      assert.equal(await status.innerText(), "Tool output: page 2 of 3");
      keyboard.textPaging = await status.innerText();
    },
  );

  await check(
    "attachment dialog labels, traps and restores keyboard focus",
    async () => {
      const bytes = Buffer.from("Keyboard attachment inspection body");
      const descriptor = {
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      };
      await recording.uploadAttachment(
        ownerSecret,
        descriptor,
        (async function* () {
          yield bytes;
        })(),
      );
      await appendAll([
        {
          kind: "attachment.available",
          payload: {
            attachment: {
              ...descriptor,
              artifactId: "keyboard-artifact",
              version: 1,
              filename: "keyboard.txt",
              mediaType: "text/plain",
            },
          },
        },
      ]);
      const viewport = page.getByRole("region", {
        name: "Scrollable session activity; use arrow keys to move between items",
        exact: true,
      });
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      await viewport.focus();
      await page.keyboard.press("End");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await viewport.focus();
      await page.keyboard.press("End");
      await waitForCard("#artifacts-keyboard-artifact");
      const opener = await tabUntil(
        (stop) => stop.name === "Open version 1",
        10,
      );
      assert.equal(opener.tag, "button");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Attachment inspector" });
      await dialog
        .getByText("Keyboard attachment inspection body", { exact: true })
        .waitFor();
      const modal = await page.evaluate(() => {
        const element = document.querySelector("dialog");
        return {
          open: element?.open,
          label: element?.getAttribute("aria-label"),
          activeInside: !!document.activeElement?.closest("dialog"),
        };
      });
      assert.equal(modal.open, true);
      assert.match(modal.label ?? "", /^Attachment inspector: keyboard\.txt/);
      const nodes = await axNodes();
      const dialogNode = nodes.find((node) => node.role === "dialog");
      assert.ok(dialogNode, "No dialog node in the accessibility tree");
      assert.match(dialogNode.name, /Attachment inspector/);
      assert.equal(dialogNode.properties.modal, true);
      assert.equal(modal.activeInside, true, "Focus did not enter the dialog");
      const inside = [];
      for (let index = 0; index < 10; index++) {
        await page.keyboard.press("Tab");
        inside.push(await focusDescription());
      }
      const escaped = inside.filter((stop) => !stop.inDialog && !stop.lost);
      assert.deepEqual(
        escaped,
        [],
        `Tab escaped the modal dialog: ${JSON.stringify(inside)}`,
      );
      assert.ok(
        inside.some((stop) => stop.name === "Close attachment"),
        "The dialog close control is not in the dialog Tab cycle",
      );
      await page.keyboard.press("Shift+Tab");
      const back = await focusDescription();
      assert.ok(back.inDialog || back.lost, JSON.stringify(back));
      if (back.lost) await page.keyboard.press("Shift+Tab");
      assert.equal((await focusDescription()).inDialog, true);
      keyboard.dialogTabStops = inside.filter((stop) => !stop.lost).length;
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      const restored = await focusDescription();
      assert.equal(restored.lost, false, "Escape dropped focus on the body");
      assert.equal(restored.name, "Open version 1", JSON.stringify(restored));
      assert.equal(restored.inViewport, true);
      keyboard.dialogStops = inside.length;
    },
  );

  await check(
    "leaving with the keyboard returns focus to the join form",
    async () => {
      const leave = page.getByRole("button", { name: "Leave", exact: true });
      await leave.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Join recording" }).waitFor();
      await page.waitForFunction(
        () => document.activeElement?.tagName === "INPUT",
      );
      const restored = await focusDescription();
      assert.equal(restored.name, "Recording ID", JSON.stringify(restored));
      keyboard.leaveRestoresForm = true;
    },
  );

  await check(
    "reduced motion keeps every transition and scroll instant",
    async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByLabel("Access key", { exact: false }).fill(ownerSecret);
      await page
        .getByRole("button", { name: "Join recording", exact: true })
        .click();
      await page
        .getByText("Loaded playback data is cached on this device.", {
          exact: true,
        })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      );
      const motion = await page.evaluate(() => {
        const animated = [];
        for (const element of document.querySelectorAll("*")) {
          const style = getComputedStyle(element);
          const duration = (value) =>
            value
              .split(",")
              .map((part) =>
                part.trim().endsWith("ms")
                  ? Number.parseFloat(part)
                  : Number.parseFloat(part) * 1000,
              )
              .reduce((a, b) => Math.max(a, b), 0);
          if (
            duration(style.transitionDuration) > 1 ||
            duration(style.animationDuration) > 1 ||
            style.scrollBehavior === "smooth"
          )
            animated.push({
              tag: element.tagName.toLowerCase(),
              className: String(element.className).slice(0, 40),
              transition: style.transitionDuration,
              animation: style.animationDuration,
              scroll: style.scrollBehavior,
            });
        }
        return {
          animated,
          elements: document.querySelectorAll("*").length,
          running: document.getAnimations().length,
        };
      });
      assert.deepEqual(motion.animated, [], JSON.stringify(motion.animated));
      assert.equal(motion.running, 0);
      // Following live still tracks the newest activity without animating.
      await page
        .getByRole("button", { name: "Follow live", exact: true })
        .click();
      await position(recording.boundary.sequence, recording.boundary.sequence);
      report.reducedMotion = motion;
      await page.emulateMedia({ reducedMotion: null });
    },
  );

  for (const [name, viewport] of [
    ["reflow-320", { width: 320, height: 800 }],
    ["zoom-200", { width: 640, height: 512 }],
  ]) {
    await check(
      `${name} keeps controls visible without horizontal scrolling`,
      async () => {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(200);
        const layout = await page.evaluate(() => {
          const targets = [];
          for (const element of document.querySelectorAll(
            "button:not([disabled]),a[href],select,input",
          )) {
            const rect = element.getBoundingClientRect();
            if (!rect.width && !rect.height) continue;
            const label = (
              element.getAttribute("aria-label") ??
              element.textContent ??
              element.getAttribute("type") ??
              ""
            )
              .trim()
              .slice(0, 30);
            const box =
              element.getAttribute("type") === "checkbox" &&
              element.closest("label")
                ? element.closest("label").getBoundingClientRect()
                : rect;
            targets.push({
              label,
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") ?? "",
              left: Math.round(box.left),
              right: Math.round(box.right),
              width: Math.round(box.width),
              height: Math.round(box.height),
            });
          }
          return {
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            targets,
          };
        });
        assert.ok(
          layout.scrollWidth <= layout.width + 1,
          `Horizontal overflow: ${layout.scrollWidth} > ${layout.width}`,
        );
        const clipped = layout.targets.filter(
          (target) => target.left < -1 || target.right > layout.width + 1,
        );
        assert.deepEqual(
          clipped,
          [],
          `Clipped controls: ${JSON.stringify(clipped)}`,
        );
        const small = layout.targets.filter(
          (target) =>
            target.type !== "range" &&
            (target.height < 24 || target.width < 24),
        );
        assert.deepEqual(
          small,
          [],
          `Targets below 24px: ${JSON.stringify(small)}`,
        );
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        report.accessibility[name] = {
          passedRules: accessibility.passes.length,
          incompleteRules: accessibility.incomplete.map(({ id }) => id),
          violations: accessibility.violations.map(({ id, nodes }) => ({
            id,
            nodes: nodes.map(({ target, failureSummary }) => ({
              target,
              failureSummary,
            })),
          })),
        };
        assert.deepEqual(
          report.accessibility[name].violations,
          [],
          `${name} accessibility violations`,
        );
        (report.reflow ??= {})[name] = {
          width: layout.width,
          scrollWidth: layout.scrollWidth,
          targets: layout.targets.length,
          smallestTarget: Math.min(
            ...layout.targets.map((target) =>
              Math.min(target.width, target.height),
            ),
          ),
        };
        await page.screenshot({
          path: join(output, `${name}.png`),
          fullPage: true,
        });
      },
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settleRows();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(report.errors, []);
  report.success = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  delete report.currentCheck;
  report.phase = "closing browser";
  saveReport();
  await browser?.close();
  report.phase = "closing server";
  saveReport();
  await server?.close();
  report.phase = "removing fixture";
  saveReport();
  await rm(directory, { recursive: true, force: true });
  report.phase = "complete";
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`Probe output: ${output}`);
}
