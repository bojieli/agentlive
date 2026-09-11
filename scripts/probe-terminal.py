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
