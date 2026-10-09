#!/usr/bin/env python3
"""Reply to OSC status detection before tmux answers the following DA probe."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import tty


class StatusQueries:
    def __init__(self, reply):
        self.reply = reply
        self.pending = b""
        self.queries = (b"\x1b]7501;?\x07", b"\x1b]7501;?\x1b\\")
        self.mode = "text"

    def feed(self, data):
        output = bytearray()
        index = 0
        while index < len(data):
            if self.mode == "text":
                escape = data.find(b"\x1b", index)
                if escape == -1:
                    output.extend(data[index:])
                    break
                output.extend(data[index:escape])
                self.pending = b"\x1b"
                self.mode = "escape"
                index = escape + 1
                continue
            byte = data[index]
            index += 1
            if self.mode == "escape":
                self.pending += bytes([byte])
                if byte == ord("]"):
                    self.mode = "candidate"
                else:
                    output.extend(self.pending)
                    self.pending = b""
                    self.mode = "opaque" if byte in b"PX^_" else "text"
            elif self.mode == "candidate":
                self.pending += bytes([byte])
                if self.pending in self.queries:
                    self.reply(b"\x1b]7501;?\x1b\\")
                    self.pending = b""
                    self.mode = "text"
                elif not any(query.startswith(self.pending) for query in self.queries):
                    output.extend(self.pending)
                    self.pending = b""
                    self.mode = "osc-escape" if byte == 0x1b else "osc"
                    if byte in (0x07, 0x18, 0x1a):
                        self.mode = "text"
            else:
                output.append(byte)
                if byte in (0x18, 0x1a) or (self.mode == "osc" and byte == 0x07):
                    self.mode = "text"
                elif self.mode.endswith("-escape"):
                    self.mode = "text" if byte == ord("\\") else self.mode[:-7]
                elif byte == 0x1b:
                    self.mode += "-escape"
        return bytes(output)


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def main():
    shell = sys.argv[1:] or [os.environ.get("SHELL", "/bin/sh"), "-l"]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(shell[0], shell)

    def resize(_signal=None, _frame=None):
        try:
            size = fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
            fcntl.ioctl(master, termios.TIOCSWINSZ, size)
        except OSError:
            pass

    def terminate(signum, _frame):
        try:
            os.killpg(pid, signum)
        except ProcessLookupError:
            pass

    resize()
    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)
    previous = termios.tcgetattr(0)
    queries = StatusQueries(lambda data: write_all(master, data))
    try:
        tty.setraw(0)
        while True:
            ready, _, _ = select.select([0, master], [], [])
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                write_all(1, queries.feed(data))
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    terminate(signal.SIGHUP, None)
                    break
                write_all(master, data)
    finally:
        write_all(1, queries.pending)
        termios.tcsetattr(0, termios.TCSANOW, previous)
        os.close(master)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
