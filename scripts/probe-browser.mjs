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
  const append = (content) =>
    recording.append(lease, [
      {
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
      },
    ]);
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
