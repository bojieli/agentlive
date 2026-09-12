#!/usr/bin/env node
/** Fail on broken relative links and heading anchors between committed Markdown files. */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skip = new Set([
  "node_modules",
  "dist",
  ".git",
  "probe-results",
  "coverage",
]);
/** Historical archives are verbatim copies; their links describe the old tree. */
const exempt = new Set(["docs/history"]);

async function* markdown(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* markdown(path);
    else if (entry.name.endsWith(".md")) yield path;
  }
}

const anchors = new Map();
async function headings(path) {
  if (anchors.has(path)) return anchors.get(path);
  const found = new Set();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    found.add(
      heading[1]
        .toLowerCase()
        .replace(/[`*_[\]()]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  }
  anchors.set(path, found);
  return found;
}

const broken = [];
let checked = 0;
for await (const path of markdown(root)) {
  const rel = relative(root, path);
  if ([...exempt].some((prefix) => rel.startsWith(prefix + "/"))) continue;
  const text = await readFile(path, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [file, fragment] = target.split("#");
    const resolved = file ? normalize(join(dirname(path), file)) : path;
    checked++;
    if (!existsSync(resolved)) {
      broken.push(`${rel} -> ${target} (missing file)`);
      continue;
    }
    if (fragment && resolved.endsWith(".md")) {
      if (!(await headings(resolved)).has(fragment))
        broken.push(`${rel} -> ${target} (missing heading)`);
    }
  }
}
if (broken.length) {
  console.error(`Broken documentation links (${broken.length}):`);
  for (const entry of broken) console.error("  " + entry);
  process.exit(1);
}
console.log(JSON.stringify({ checked, broken: 0 }));
