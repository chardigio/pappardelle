"""Shared process and real-PTY measurements for the benchmark commands."""
import fcntl
import os
import pty
import select
import struct
import subprocess
import termios
import time


def command(argv, cwd):
    start = time.perf_counter()
    subprocess.run(argv, cwd=cwd, stdout=subprocess.DEVNULL, check=True)
    return (time.perf_counter() - start) * 1000


def run_pty(argv, cwd, env, done=None, stop_at=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 80, 0, 0))
    start = time.perf_counter()
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    captured = bytearray()
    next_key = 0
    first_ms = None
    input_ready_at = None
    try:
        while time.perf_counter() - start < 20:
            if done and done.exists():
                events = done.read_text().splitlines()
                if events and any('"phase":"input"' in line for line in events):
                    if input_ready_at is None:
                        # Drain the final saturation frame before measuring input.
                        input_ready_at = time.perf_counter() + .15
                    if time.perf_counter() >= max(next_key, input_ready_at):
                        os.write(master, b'j')
                        next_key = time.perf_counter() + .1
            if select.select([master], [], [], .005)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                captured.extend(data)
                if stop_at and stop_at in captured:
                    first_ms = (time.perf_counter() - start) * 1000
                    os.write(master, b'q')
                    stop_at = None
            if child.poll() is not None:
                break
        else:
            raise RuntimeError('PTY timed out: ' + repr(argv) + '\n' + captured[-4000:].decode(errors='replace'))
        child.wait(timeout=3)
        if child.returncode:
            raise RuntimeError(captured[-5000:].decode(errors='replace'))
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    return first_ms, len(captured)


