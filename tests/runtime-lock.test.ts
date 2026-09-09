import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { validateRuntimeLock } from "../scripts/runtime-lock.mjs";
const locked = JSON.parse(
  await readFile(
    new URL("../packaging/runtime-lock.json", import.meta.url),
    "utf8",
  ),
);
const manifest = locked.packages[""];
it("accepts the checked-in runtime dependency graph", () => {
  expect(() => validateRuntimeLock(locked, manifest)).not.toThrow();
});
it("rejects manifest version, engine, binary, and dependency drift", () => {
  for (const change of [
    { version: "99.0.0" },
    { engines: { node: ">=24" } },
    { bin: { agentlive: "other.mjs" } },
    { dependencies: { ...manifest.dependencies, zod: "99.0.0" } },
  ])
    expect(() =>
      validateRuntimeLock(locked, { ...manifest, ...change }),
    ).toThrow("Runtime lock differs");
});
it("rejects unlocked or nonregistry runtime artifacts", () => {
  for (const change of [
    { link: true },
    { integrity: undefined },
    { resolved: "file:../workspace" },
  ]) {
    const changed = structuredClone(locked);
    Object.assign(changed.packages["node_modules/zod"], change);
    expect(() => validateRuntimeLock(changed, manifest)).toThrow(
      "unpinned or unsupported",
    );
  }
});
