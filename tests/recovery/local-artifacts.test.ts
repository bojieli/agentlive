import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { localArtifactResolver } from "../../packages/adapters/src/index.js";

const directories: string[] = [];
const resolvers: Awaited<ReturnType<typeof localArtifactResolver>>[] = [];
afterEach(async () => {
  for (const resolver of resolvers.splice(0)) await resolver.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-outcome-"));
  directories.push(root);
  const options = {
    directory: join(root, "artifacts"),
    roots: [root],
    baseDirectory: root,
    secrets: ["private"],
    serverOrigin: "http://localhost:1",
    streamId: "stream",
    writeSecret: "unused",
    signal: new AbortController().signal,
  };
  const resolver = await localArtifactResolver(options);
  resolvers.push(resolver);
  const input = {
    artifactId: "artifact",
    sourceKey: "source",
    path: "missing.txt",
    historical: true,
  };
  const checkpoint = join(
    options.directory,
    "outcomes",
    createHash("sha256").update(input.sourceKey).digest("hex") + ".json",
  );
  return { root, options, resolver, input, checkpoint };
}
it("pins missing outcomes across restart and rejects changed source or policy", async () => {
  const { root, options, resolver, input, checkpoint } = await setup();
  const missing = await resolver.resolveArtifact(input);
  expect(missing).toHaveProperty("reason");
  await writeFile(join(root, input.path), "newly created");
  await resolver.close();
  resolvers.pop();
  const resumed = await localArtifactResolver(options);
  resolvers.push(resumed);
  expect(
    await resumed.resolveArtifact({
      ...input,
      path: pathToFileURL(join(root, input.path)).href,
    }),
  ).toEqual(missing);
  for (const change of [
    { path: "other.txt" },
    { artifactId: "other" },
    { historical: false },
    { expectedSourceHash: "a".repeat(64) },
  ])
    await expect(
      resumed.resolveArtifact({ ...input, ...change }),
    ).rejects.toThrow("identity or capture policy changed");
  const stored = await readFile(checkpoint, "utf8");
  expect(stored).not.toContain("private");
  await resumed.close();
  resolvers.pop();
  const changed = await localArtifactResolver({
    ...options,
    secrets: ["different"],
  });
  resolvers.push(changed);
  await expect(changed.resolveArtifact(input)).rejects.toThrow(
    "identity or capture policy changed",
  );
  expect(await readFile(checkpoint, "utf8")).toBe(stored);
});
it("serializes conflicting callers and snapshots caller input before queuing", async () => {
  const { resolver, input } = await setup();
  const first = resolver.resolveArtifact(input);
  input.path = "changed.txt";
  const second = resolver.resolveArtifact(input);
  await expect(first).resolves.toHaveProperty("reason");
  await expect(second).rejects.toThrow("identity or capture policy changed");
});
it("refuses unverifiable legacy missing outcomes without rewriting them", async () => {
  const { resolver, input, checkpoint } = await setup();
  const missing = await resolver.resolveArtifact(input);
  const legacy = JSON.stringify(missing);
  await writeFile(checkpoint, legacy);
  await expect(resolver.resolveArtifact(input)).rejects.toThrow(
    "no verifiable request binding",
  );
  expect(await readFile(checkpoint, "utf8")).toBe(legacy);
});
it("preserves a source conflict after capture committed but the outcome checkpoint was lost", async () => {
  const { ArtifactSpool } =
    await import("../../packages/publisher/src/index.js");
  const { root, options, resolver, input, checkpoint } = await setup();
  await resolver.close();
  resolvers.pop();
  const path = join(root, input.path);
  await writeFile(path, "original private");
  const spool = await ArtifactSpool.open(join(options.directory, "capture"), {
    allowedRoots: options.roots,
    secrets: options.secrets,
  });
  try {
    await spool.capture({
      ...input,
      path,
      mediaType: "text/plain",
      text: true,
    });
  } finally {
    await spool.close();
  }
  const restarted = await localArtifactResolver(options);
  resolvers.push(restarted);
  await expect(
    restarted.resolveArtifact({ ...input, path: "different.txt" }),
  ).rejects.toMatchObject({ code: "event_conflict" });
  await expect(readFile(checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
});
