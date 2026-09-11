#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = join(root, "packages/server/dist/web");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["apps/web/src/main.tsx"],
  outfile: join(output, "app.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2023"],
  minify: true,
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  join(output, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>AgentLive · Shared coding sessions</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript to view recordings.</noscript></body></html>\n`,
);

await writeFile(
  join(output, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#172c28"/><circle cx="16" cy="16" r="8" fill="#b7e5c4"/><circle cx="16" cy="16" r="3" fill="#172c28"/></svg>\n`,
);

await writeFile(
  join(output, "artifact-preview.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style><script src="/artifact-preview.js" defer></script></head><body><iframe title="Static artifact document" sandbox="" referrerpolicy="no-referrer"></iframe></body></html>`,
);
await writeFile(
  join(output, "artifact-preview.js"),
  `"use strict";addEventListener("message",event=>{if(event.source!==parent||event.origin!==new URL(location.href).origin||event.data?.type!=="agentlive-static-preview"||typeof event.data.html!=="string"||event.data.html.length>12*1024*1024)return;document.querySelector("iframe").srcdoc=event.data.html;});`,
);

await writeFile(
  join(output, "artifact-interactive.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style><script>"use strict";addEventListener("message",event=>{if(event.source!==parent||event.origin!==new URL(location.href).origin||event.data?.type!=="agentlive-interactive-preview"||typeof event.data.html!=="string"||event.data.html.length>12*1024*1024)return;document.querySelector("iframe").srcdoc=event.data.html;});</script></head><body><iframe title="Interactive artifact document" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></body></html>`,
);
