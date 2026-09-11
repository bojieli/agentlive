#!/usr/bin/env node
/** Build one installable package from workspace code and pinned external dependencies. */
import { build } from "esbuild";
import { validateRuntimeLock } from "./runtime-lock.mjs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  chmod,
  rename,
  copyFile,
  cp,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifests = new Map();
for (const directory of await readdir(join(root, "packages"))) {
  const manifest = JSON.parse(
    await readFile(join(root, "packages", directory, "package.json"), "utf8"),
  );
  manifests.set(manifest.name, manifest);
}
const dependencies = {};
const visited = new Set();
function collect(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const manifest = manifests.get(name);
  if (!manifest) throw new Error(`Missing workspace package ${name}`);
  for (const [dependency, version] of Object.entries(
    manifest.dependencies ?? {},
  )) {
    if (version.startsWith("workspace:")) collect(dependency);
    else {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
        throw new Error(`Unpinned runtime dependency ${dependency}`);
      if (dependencies[dependency] && dependencies[dependency] !== version)
        throw new Error(`Conflicting dependency ${dependency}`);
      dependencies[dependency] = version;
    }
  }
}
collect("@agentlive/cli");
const publishable = process.argv.includes("--release");
const staging = join(root, "dist", "package");
const release = join(root, "dist", "release");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(release, { recursive: true });
const cli = manifests.get("@agentlive/cli");
await build({
  absWorkingDir: root,
  entryPoints: ["packages/cli/dist/main.js"],
  outfile: join(staging, "cli.mjs"),
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  external: Object.keys(dependencies),
  legalComments: "inline",
});
await chmod(join(staging, "cli.mjs"), 0o755);
await writeFile(
  join(staging, "package.json"),
  JSON.stringify(
    {
      name: "agentlive",
      version: cli.version,
      // Only the release workflow (--release) produces a publishable manifest.
      ...(publishable ? {} : { private: true }),
      description:
        "Broadcast and replay coding-agent sessions from Claude Code, Codex, Kimi Code and OpenCode",
      keywords: [
        "coding-agent",
        "claude-code",
        "codex",
        "opencode",
        "kimi",
        "replay",
        "live",
        "broadcast",
      ],
      homepage: "https://github.com/bojieli/agentlive#readme",
      bugs: { url: "https://github.com/bojieli/agentlive/issues" },
      repository: {
        type: "git",
        url: "git+https://github.com/bojieli/agentlive.git",
      },
      type: "module",
      license: "MIT",
      engines: cli.engines,
      bin: { agentlive: "cli.mjs" },
      files: ["cli.mjs", "npm-shrinkwrap.json", "README.md", "LICENSE", "web"],
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
    },
    null,
    2,
  ) + "\n",
);
await copyFile(join(root, "README.md"), join(staging, "README.md"));
await copyFile(join(root, "LICENSE"), join(staging, "LICENSE"));
await cp(join(root, "packages/server/dist/web"), join(staging, "web"), {
  recursive: true,
});
const lockPath = join(root, "packaging", "runtime-lock.json");
const updateLock = process.argv.includes("--update-lock");
if (updateLock) {
  await run(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: staging },
  );
  await rename(
    join(staging, "package-lock.json"),
    join(staging, "npm-shrinkwrap.json"),
  );
}
const lockBytes = await readFile(
  updateLock ? join(staging, "npm-shrinkwrap.json") : lockPath,
);
const locked = JSON.parse(lockBytes.toString("utf8"));
const manifest = JSON.parse(
  await readFile(join(staging, "package.json"), "utf8"),
);
validateRuntimeLock(locked, manifest);
if (updateLock) await writeFile(lockPath, lockBytes);
else await writeFile(join(staging, "npm-shrinkwrap.json"), lockBytes);
const packed = await run(
  "npm",
  ["pack", "--json", "--pack-destination", release],
  { cwd: staging },
);
const [result] = JSON.parse(packed.stdout);
console.log(
  JSON.stringify({
    package: result.filename,
    bytes: result.size,
    integrity: result.integrity,
  }),
);
