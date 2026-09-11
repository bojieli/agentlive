/** Isolate runtime I/O stalls from reducer work. Parent deadlines do not depend
 * on the worker's event loop or libuv pool. No existing recording is touched. */
import { fork } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const withMarks = process.argv.includes("--marks");
const worker = process.argv[2] === "--worker";
const count = Number(process.argv[worker ? 3 : 2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1 || count > 10000000)
  throw new RangeError("Iterations must be 1..10000000");
if (worker) {
  const directory = process.argv[4];
  const bytes = Buffer.from(
    "agentlive runtime filesystem and digest verification\n".repeat(64),
  );
  const expected = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, "fixture");
  let marks;
  let completed = 0,
    phase = "write";
  const heartbeat = setInterval(
    () => process.send?.({ completed, phase, memory: process.memoryUsage() }),
    1000,
  );
  try {
    await writeFile(path, bytes);
    if (withMarks) {
      const { ContentMarks } =
        await import("../packages/storage/dist/index.js");
      marks = await ContentMarks.create(join(directory, "collection"));
    }
    for (; completed < count; completed++) {
      phase = "open";
      const file = await open(path, "r");
      try {
        phase = "stat";
        if ((await file.stat()).size !== bytes.length)
          throw new Error("Wrong fixture size");
        phase = "read";
        const loaded = await file.readFile();
        phase = "digest";
        const digest = Buffer.from(
          await webcrypto.subtle.digest("SHA-256", loaded),
        ).toString("hex");
        if (digest !== expected) throw new Error("Wrong fixture digest");
        if (marks) {
          phase = "mark";
          const ref = {
            hash: createHash("sha256").update(String(completed)).digest("hex"),
            byteSize: bytes.length,
            units: bytes.length,
          };
          marks.add(ref.hash);
          marks.recordTrace(ref);
          if (!marks.traced(ref)) throw new Error("Missing trace record");
        }
      } finally {
        phase = "close";
        await file.close();
      }
    }
    if (marks) {
      phase = "seal";
      await marks.seal();
      for (let index = 0; index < count; index++) {
        if (
          !marks.has(createHash("sha256").update(String(index)).digest("hex"))
        )
          throw new Error("Missing sealed mark");
      }
      phase = "marks-close";
      await marks.close();
      marks = undefined;
    }
    process.send?.({ completed, phase: "complete", success: true });
  } catch (error) {
    process.send?.({
      completed,
      phase,
      success: false,
      error: String(error.stack ?? error),
    });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    process.disconnect();
  }
} else {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-runtime-io-"));
  const started = performance.now();
  const report = {
    success: false,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    iterations: count,
    withMarks,
    completed: 0,
    phase: "startup",
  };
  let lastProgress = performance.now();
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--worker", String(count), directory, ...(withMarks ? ["--marks"] : [])],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  const watchdog = setInterval(() => {
    if (performance.now() - lastProgress > 30000) {
      report.error = "No completed iteration for 30 seconds";
      report.timedOut = true;
      child.kill("SIGKILL");
    }
  }, 1000);
  child.on("message", (message) => {
    if (message.completed > report.completed) lastProgress = performance.now();
    Object.assign(report, message);
  });
  child.on("error", (error) => {
    report.error = String(error);
  });
  await new Promise((done) =>
    child.once("close", (code, signal) => {
      report.exitCode = code;
      report.signal = signal;
      done();
    }),
  );
  clearInterval(watchdog);
  report.elapsedMs = performance.now() - started;
  report.success =
    report.success &&
    report.exitCode === 0 &&
    report.completed === count &&
    !report.timedOut;
  // Synchronous reporting remains available if the parent's async pool stalls.
  const output = resolve(process.argv[3] ?? `runtime-io-${Date.now()}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, output }));
  if (report.success) await rm(directory, { recursive: true, force: true });
  else {
    console.error(`Preserved fixture: ${directory}`);
    process.exitCode = 1;
  }
}
