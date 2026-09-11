import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SnapshotLeases } from "../../packages/server/src/snapshot-leases.js";
const binding = { streamId: "stream", revision: "revision" };
const snapshot = {
  format: "agentlive.paged-state" as const,
  serverSeq: 1,
  timelineMs: 0,
  ref: { hash: "a".repeat(64), byteSize: 10, units: 1 },
  activity: { hash: "b".repeat(64), byteSize: 10, units: 1 },
};
it.each([
  ["before", "renew"],
  ["after", "renew"],
  ["before", "acquire"],
  ["after", "acquire"],
  ["before", "release"],
  ["after", "release"],
] as const)(
  "preserves a complete lease ledger after SIGKILL %s %s replacement rename",
  async (stage, operation) => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-lease-kill-"));
    const leases = new SnapshotLeases(directory, binding, () => 100, 128, 1000);
    const first = await leases.acquire(snapshot);
    const script = join(directory, "crash.mjs");
    const argument = operation === "acquire" ? snapshot : first.token;
    await writeFile(
      script,
      `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to.endsWith('/leases.json')) {
    if (${JSON.stringify(stage)} === 'after') await rename(from, to);
    process.stdout.write('at-rename\\n');
    await new Promise(() => {});
  }
  return rename(from, to);
};
syncBuiltinESMExports();
const { SnapshotLeases } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "packages/server/dist/snapshot-leases.js")).href)});
await new SnapshotLeases(${JSON.stringify(directory)}, ${JSON.stringify(binding)}, () => 200, 128, 1000)[${JSON.stringify(operation)}](${JSON.stringify(argument)});
`,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Child did not reach rename: ${errors}`)),
          10000,
        );
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("at-rename")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Early child exit: ${errors}`));
        });
      });
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      const reopened = new SnapshotLeases(
        directory,
        binding,
        () => 200,
        128,
        1000,
      );
      const retained = await reopened.retained();
      if (operation === "release" && stage === "after") {
        expect(retained).toEqual([]);
        await expect(reopened.validate(first.token)).rejects.toMatchObject({
          code: "stale_lease",
        });
      } else {
        const saved = await reopened.validate(first.token);
        expect(saved.snapshot).toEqual(snapshot);
        expect(saved.expiresAt).toBe(
          operation === "renew" && stage === "after" ? 1200 : 1100,
        );
        expect(retained).toHaveLength(
          operation === "acquire" && stage === "after" ? 2 : 1,
        );
        for (const lease of retained) expect(lease.snapshot).toEqual(snapshot);
        expect((await reopened.renew(first.token)).expiresAt).toBe(1200);
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
