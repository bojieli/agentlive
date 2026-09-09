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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>AgentLive · Shared coding sessions</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript to view recordings.</noscript></body></html>\n`,
);
