#!/usr/bin/env node
/** Verify interactive cancellation during a real stalled HTTP join, using a local PTY. */
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SubscriberCache } from "../packages/storage/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "agentlive-join-cancel-"));
const replaying = process.argv.includes("--replay");
const marker = join(root, "request-started");
let requests = 0;
const server = createServer((_request, _response) => {
  requests++;
  void writeFile(marker, String(requests));
  // Deliberately leave metadata unanswered. Cancellation must close this connection.
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const python = String.raw`
import os, pty, termios, subprocess, sys, select, time, json
marker = sys.argv[1]
command = sys.argv[2:]
controls = b"Replay controls:" if "replay" in command else b"Watch controls:"
for attempt, key in enumerate((b"q", b"\x03"), 1):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
    output = b""
    try:
        deadline = time.monotonic() + 10
        started = False
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                output += os.read(master, 65536)
            if os.path.exists(marker):
                with open(marker) as file:
                    started = file.read() == str(attempt)
            if started and controls in output:
                break
        assert started, "Stalled metadata request was not reached"
        assert not termios.tcgetattr(slave)[3] & termios.ICANON, "Controls were not installed during join"
        os.write(master, key)
        deadline = time.monotonic() + 3
        while child.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                output += os.read(master, 65536)
        assert child.poll() == 0, "Cancellation failed to exit promptly"
        assert termios.tcgetattr(slave) == original, "Terminal settings not restored"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
print(json.dumps({"success": True, "viewer": "replay" if "replay" in command else "watch", "stalledJoinCancelled": True, "quitAndCtrlC": True, "terminalRestored": True}))
`;
  const result = await promisify(execFile)(
    "python3",
    [
      "-c",
      python,
      marker,
      process.execPath,
      resolve("packages/cli/dist/main.js"),
      replaying ? "replay" : "watch",
      "--stream",
      "join-probe",
      "--server",
      origin,
      "--anonymous",
      "--interactive",
      "--state-dir",
      root,
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  if (requests !== 2)
    throw new Error("Expected both join attempts to reach the server");
  if (!replaying) {
    // CLI watch uses this root; reopening proves cancellation released cache ownership.
    const cache = await SubscriberCache.open(join(root, "subscriber"), {
      serverOrigin: origin,
      streamId: "join-probe",
      initialize: async () => ({ revision: "probe-revision" }),
    });
    await cache.close();
  }
  process.stdout.write(result.stdout);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
