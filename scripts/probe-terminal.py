"""Exercise the real CLI through a POSIX pseudo-terminal; no native user data."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request


def release_flow(node, cli, origin, stream, state, late_gate, exit_gate):
    """Drive the release-gate viewer journey against a live recording.

    Follow live, pause, step backward, rewind 30 seconds, catch up to events
    published while paused, and quit. Called by probe-release-flow.mjs, which
    owns the server, the synthetic agent and the gate files named here.
    """
    checks = []
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    child = subprocess.Popen(
        [node, cli, "watch", "--stream", stream, "--server", origin,
         "--state-dir", state, "--interactive"],
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    output = bytearray()

    def pump(timeout=0.05):
        if select.select([master], [], [], timeout)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return b""
                raise
            output.extend(data)
            return data
        return b""

    def read_until(predicate, mark=0, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(bytes(output[mark:])):
                return
            pump()
        raise AssertionError(
            "Expected viewer output missing; exit=%s tail=%r"
            % (child.poll(), bytes(output[-2000:]))
        )

    def settle(seconds=1.0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump(0.05)

    def shown(mark, seconds=1.0):
        # Let the rest of a small snapshot arrive before asserting absent text.
        settle(seconds)
        return bytes(output[mark:]).decode("utf-8", "replace").replace("\r\n", "\n")

    def timeline_ms():
        with open(os.path.join(state, "owner.json"), encoding="utf-8") as owner:
            secret = json.load(owner)["secret"]
        request = urllib.request.Request(
            "%s/api/v1/streams/%s" % (origin, stream),
            headers={"authorization": "Bearer " + secret},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)["timelineMs"]

    try:
        read_until(lambda data: b"STAGE-THREE-LATEST" in data)
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        settle()
        checks.append("watch: follows a live recording while the agent runs")

        os.write(master, b" ")
        settle(0.5)
        mark = len(output)
        os.write(master, b",")
        read_until(lambda data: b"Playback state" in data, mark)
        stepped = shown(mark)
        assert stepped.startswith("[90.000s] Playback state"), stepped
        assert "user: incomplete\n  STAGE-THREE-LATEST" in stepped, stepped
        assert "STAGE-TWO-MIDDLE" in stepped, stepped
        checks.append("watch: pause and step backward show the preceding event state")

        mark = len(output)
        os.write(master, b"[")
        read_until(lambda data: b"Playback state" in data, mark)
        rewound = shown(mark)
        assert rewound.startswith("[60.000s] Playback state"), rewound
        assert "STAGE-TWO-MIDDLE" in rewound, rewound
        assert "STAGE-ONE-OPENING" in rewound, rewound
        assert "STAGE-THREE-LATEST" not in rewound, rewound
        checks.append("watch: [ rewinds 30 seconds and shows the earlier state")

        # Publish a further event while the viewer stays paused, and wait for
        # the server to hold it before asking the viewer to catch up.
        open(late_gate, "w").close()
        deadline = time.monotonic() + 60
        while timeline_ms() != 135000:
            if time.monotonic() > deadline:
                raise AssertionError("Paused-viewer event never reached the server")
            settle(0.25)
        idle = shown(len(output), 1.0)
        assert idle == "", "Paused viewer presented new events: %r" % idle
        checks.append("watch: receipt continues while presentation stays paused")

        mark = len(output)
        os.write(master, b"l")
        read_until(lambda data: b"STAGE-FOUR-WHILE-PAUSED" in data, mark)
        caught = shown(mark)
        assert "STAGE-THREE-LATEST" in caught, caught
        assert "[135.000s]" in caught, caught
        checks.append("watch: l catches up live through events published while paused")

        os.write(master, b"q")
        deadline = time.monotonic() + 30
        while child.poll() is None and time.monotonic() < deadline:
            pump()
        assert child.poll() == 0, "Viewer exit status %s" % child.poll()
        assert termios.tcgetattr(slave) == original
        assert b"\x1b" not in output
        checks.append("watch: q exits zero and restores the terminal")
        return {
            "success": True,
            "checks": checks,
            "markers": [
                line
                for line in bytes(output).decode("utf-8", "replace").split("\n")
                if "STAGE-" in line
            ],
        }
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        # The synthetic agent waits for this gate, so release it on every path.
        open(exit_gate, "w").close()
        os.close(master)
        os.close(slave)


if sys.argv[1] == "release-flow":
    print(json.dumps(release_flow(*sys.argv[2:])))
    sys.exit(0)

node, cli, archive, origin, stream, state = sys.argv[1:]
checks = []


def stop_probe(_signal, _frame):
    raise TimeoutError("Terminal probe deadline exceeded")


signal.signal(signal.SIGTERM, stop_probe)


def exercise(command, arguments, quit_key):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    child = subprocess.Popen(
        [node, cli, command, *arguments, "--interactive", "--from-ms", "999999", "--state-dir", state],
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    output = bytearray()

    def read_until(predicate, timeout=10):
        start = len(output)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(bytes(output[start:])):
                return bytes(output[start:])
            if select.select([master], [], [], 0.05)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                output.extend(data)
            if child.poll() is not None:
                break
        raise AssertionError(f"{command}: expected terminal output missing; exit={child.poll()}, output={bytes(output[-2000:])!r}")

    def snapshot(key, expected, absent=None):
        os.write(master, key)
        data = read_until(lambda data: b"Playback state" in data and expected in data)
        # Drain the remainder of the small snapshot before checking absent content.
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                more = os.read(master, 65536)
                output.extend(more)
                data += more
        if absent:
            assert absent not in data, (command, data)
        return data

    try:
        read_until(lambda data: b"third-part" in data)
        assert not termios.tcgetattr(slave)[3] & termios.ICANON
        checks.append(command + ": raw terminal input")
        snapshot(b"\x1b[D", b"third-part")  # Undo completion; text remains.
        os.write(master, b"\x1b")
        time.sleep(0.05)
        os.write(master, b"[")
        time.sleep(0.05)
        snapshot(b"D", b"second-part", b"third-part")
        checks.append(command + ": fragmented left arrow selects previous event")
        snapshot(b"\x1bOC", b"third-part")
        checks.append(command + ": SS3 right arrow selects next event")
        os.write(master, b"\x1b[200~q[]0.,\x1b[201~")
        time.sleep(0.1)
        assert child.poll() is None
        # If pasted navigation leaked, the following exact backward step differs.
        snapshot(b",", b"second-part", b"third-part")
        checks.append(command + ": bracketed paste ignored")
        for columns, rows in [(120, 40), (60, 20), (80, 24)]:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            snapshot(b".", b"third-part")
            snapshot(b",", b"second-part", b"third-part")
        checks.append(command + ": stepping survives 120x40, 60x20 and 80x24 resize")
        os.write(master, quit_key)
        assert child.wait(timeout=10) == 0
        assert termios.tcgetattr(slave) == original
        assert b"\x1b" not in output  # Published content cannot inject terminal controls.
        checks.append(command + ": clean exit and terminal mode restored")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        os.close(master)
        os.close(slave)


exercise("replay", ["--source", archive], b"q")
exercise("watch", ["--server", origin, "--stream", stream, "--anonymous"], b"\x03")
plain = subprocess.run([node, cli, "replay", "--source", archive], capture_output=True, timeout=15)
assert plain.returncode == 0 and b"third-part" in plain.stdout and b"\x1b" not in plain.stdout
checks.append("redirected replay: exact content remains available without terminal escapes")
rejected = subprocess.run([node, cli, "replay", "--source", archive, "--interactive"], capture_output=True, timeout=15)
assert rejected.returncode != 0 and b"requires a terminal" in rejected.stderr
checks.append("redirected interactive replay: explicit terminal requirement")
print(json.dumps({"success": True, "checks": checks}))
