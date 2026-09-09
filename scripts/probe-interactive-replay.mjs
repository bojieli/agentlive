#!/usr/bin/env node
/** Local PTY verification; Python supplies the PTY, not a runtime application dependency. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../packages/server/dist/http.js";
import { importClaudeRecording } from "../packages/adapters/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-interactive-"));
const secret = randomBytes(32).toString("hex");
const server = await startServer({
  directory: join(root, "server"),
  ownerSecret: secret,
  port: 0,
});
try {
  const sourcePath = join(root, "session.jsonl");
  const beganAt = Date.now() - 60000;
  await writeFile(
    sourcePath,
    [0, 60]
      .map((seconds, index) =>
        JSON.stringify({
          type: "user",
          sessionId: "pty-session",
          uuid: "row" + index,
          timestamp: new Date(beganAt + seconds * 1000).toISOString(),
          message: {
            content: index ? "SECOND_PTY_MESSAGE" : "FIRST_PTY_MESSAGE",
          },
        }),
      )
      .join("\n") + "\n",
  );
  const imported = await importClaudeRecording({
    sourcePath,
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential: secret,
    title: "PTY probe",
    visibility: "private",
    secrets: [],
    signal: AbortSignal.timeout(30000),
  });
  const python = String.raw`
import os, pty, termios, subprocess, sys, select, time, json
command = sys.argv[1:]
watching = "watch" in command
for quit_early in (True, False):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
    output = b""
    def read_until(marker, timeout=10):
        global output
        deadline = time.monotonic() + timeout
        while marker not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                output += os.read(master, 65536)
        assert marker in output, "Expected replay marker missing"
    try:
        read_until(b"FIRST_PTY_MESSAGE")
        if not watching:
            assert b"[30.000s] Playback state" in output, "Seek boundary missing"
            assert b"SECOND_PTY_MESSAGE" not in output, "Future content leaked into seek state"
        assert not termios.tcgetattr(slave)[3] & termios.ICANON, "Raw mode not active"
        os.write(master, b" ")
        time.sleep(0.1)
        assert child.poll() is None, "Replay unexpectedly exited while paused"
        if quit_early:
            os.write(master, b"q")
        else:
            os.write(master, b" " if watching else b"++++++++++ ")
            read_until(b"SECOND_PTY_MESSAGE")
            if watching:
                os.write(master, b"q")
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                output += os.read(master, 65536)
        assert child.poll() is not None, "Replay did not exit"
        assert termios.tcgetattr(slave) == original, "Terminal settings were not restored"
        assert child.returncode == 0, "Replay failed"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
print(json.dumps({"success": True, "pauseResume": True, "speedChange": not watching, "quit": True, "terminalRestored": True, "seekState": not watching, "watchControls": watching}))
`;
  const result = await promisify(execFile)(
    "python3",
    [
      "-c",
      python,
      process.execPath,
      resolve("packages/cli/dist/main.js"),
      process.argv.includes("--watch") ? "watch" : "replay",
      "--stream",
      imported.streamId,
      "--server",
      server.url,
      "--interactive",
      "--state-dir",
      root,
      ...(process.argv.includes("--watch") ? [] : ["--from-ms", "30000"]),
    ],
    {
      env: { ...process.env, AGENTLIVE_OWNER_SECRET: secret },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
