import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { JsonlLog } from "../../packages/storage/src/index.js";
for (const mode of ["durable", "torn"])
  it(`recovers committed records after an actual SIGKILL (${mode})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlive-crash-test-"));
    const path = join(directory, "events.jsonl");
    try {
      const child = fork(
        fileURLToPath(new URL("../fixtures/log-process.mjs", import.meta.url)),
        [path, mode],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let committed = 0;
      let errors = "";
      child.stderr?.on("data", (data) => {
        errors += data;
      });
      child.on("message", (message) => {
        committed = (message as { committed: number }).committed;
      });
      const exit = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(errors).toBe("");
      expect(exit.signal).toBe("SIGKILL");
      expect(committed).toBe(1);
      const log = await JsonlLog.open(path, { parse: (value) => value });
      expect(log.boundary.sequence).toBe(1);
      const values = [];
      for await (const event of log.read()) values.push(event.value);
      expect(values).toEqual([
        { text: "durably captured before process death" },
      ]);
      await log.append([{ text: "after recovery" }]);
      expect(log.boundary.sequence).toBe(2);
      await log.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

it("keeps a suspended writer fenced and releases ownership automatically on process death", async () => {
  const { FileLock } = await import("../../packages/storage/src/index.js");
  const directory = await mkdtemp(join(tmpdir(), "agentlive-lock-test-"));
  const path = join(directory, ".lock");
  const child = fork(
    fileURLToPath(new URL("../fixtures/lock-process.mjs", import.meta.url)),
    [path],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", () => resolve());
      child.once("exit", () =>
        reject(new Error("Lock holder exited before readiness")),
      );
    });
    child.kill("SIGSTOP");
    await expect(FileLock.acquire(path)).rejects.toMatchObject({
      code: "publisher_busy",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const acquired = await FileLock.acquire(path);
    await acquired.release();
  } finally {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
