/** Real POSIX PTY input/resize acceptance against a synthetic recording. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "../packages/server/dist/index.js";
import { exportRecording } from "../packages/cli/dist/export.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-terminal-probe-"));
const secret = "c".repeat(64);
let server;
try {
  server = await startServer({
    directory: join(root, "server"),
    ownerSecret: secret,
    port: 0,
  });
  const session = await server.store.create({
    ownerId: "local",
    requestId: "terminal-probe",
    requestedAt: new Date().toISOString(),
    publisherId: "probe",
    producerEpoch: "epoch",
    writeSecret: secret,
    title: "Synthetic terminal resize",
    visibility: "public",
  });
  const { lease } = await session.resume(secret, {
    publisherId: "probe",
    producerEpoch: "epoch",
    attempt: 1,
    revision: session.info.revision,
  });
  const contents = [
    { kind: "message.started", payload: { messageId: "m", role: "assistant" } },
    {
      kind: "message.text.append",
      payload: { messageId: "m", text: "first-part " },
    },
    {
      kind: "message.text.append",
      payload: { messageId: "m", text: "second-part " },
    },
    {
      kind: "message.text.append",
      payload: {
        messageId: "m",
        text: "third-part " + "wide-content ".repeat(20) + "\u001b[2J",
      },
    },
    { kind: "message.completed", payload: { messageId: "m" } },
  ];
  for (const [index, content] of contents.entries())
    await session.append(lease, [
      {
        protocolVersion: 1,
        streamId: session.info.id,
        producerEpoch: "epoch",
        producerSeq: index + 1,
        observedAt: new Date().toISOString(),
        clockSegmentId: "clock",
        elapsedMs: index * 1000,
        fidelity: "delta",
        source: { agent: "synthetic", sessionId: "pty" },
        content,
      },
    ]);
  const archive = join(root, "fixture.agentlive");
  await exportRecording({
    serverOrigin: server.url,
    streamId: session.info.id,
    credential: secret,
    output: archive,
    signal: AbortSignal.timeout(10000),
  });
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(
      "python3",
      [
        "scripts/probe-terminal.py",
        process.execPath,
        resolve("packages/cli/dist/main.js"),
        archive,
        server.url,
        session.info.id,
        join(root, "cli"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 60000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        reject(new Error(errors || `Terminal probe exited ${code}`));
      else {
        try {
          resolveResult(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  const report = {
    ...result,
    platform: process.platform,
    node: process.version,
    at: new Date().toISOString(),
    scope:
      "POSIX PTY controls, resize survival and terminal mode; no visual emulator or screen-reader acceptance",
  };
  await mkdir("probe-results/terminal", { recursive: true });
  await writeFile(
    "probe-results/terminal/report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
