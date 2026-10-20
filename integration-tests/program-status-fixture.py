#!/usr/bin/env python3
"""Interactive, account-free terminal emitter for the real tmux checks."""

import base64
import fcntl
import json
import os
from pathlib import Path
import select
import struct
import sys
import termios
import time
import tty


def emit(body, terminator="st"):
    os.write(1, b"\x1b]7501;" + body.encode() + (b"\x07" if terminator == "bel" else b"\x1b\\"))


previous = termios.tcgetattr(0)
try:
    tty.setraw(0)
    os.write(1, b"\x1b]7501;?\x1b\\\x1b[c")
    response = b""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not response.endswith(b"c"):
        if select.select([0], [], [], 0.1)[0]:
            response += os.read(0, 65536)
    assert response.startswith(b"\x1b[?") and response.endswith(b"c"), repr(response)
    assert b"7501" not in response, repr(response)
    Path(sys.argv[1]).write_text(json.dumps({"reply": response.hex()}))
    emit("state=idle:app=fixture")
    pending = b""
    while True:
        pending += os.read(0, 65536)
        while b"\r" in pending or b"\n" in pending:
            end = min(i for i in [pending.find(b"\r"), pending.find(b"\n")] if i >= 0)
            line, pending = pending[:end], pending[end + 1:]
            start = line.find(b"{")
            if start == -1:
                continue
            command = json.loads(line[start:])
            if "body" in command:
                emit(command["body"], command.get("terminator", "st"))
            elif "raw" in command:
                os.write(1, base64.b64decode(command["raw"]))
            elif "size" in command:
                rows, columns, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8)))
                Path(command["size"]).write_text(json.dumps({"rows": rows, "columns": columns}))
            elif "exit" in command:
                sys.exit(0)
finally:
    termios.tcsetattr(0, termios.TCSANOW, previous)
