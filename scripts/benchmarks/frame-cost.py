#!/usr/bin/env python3
"""CPU and memory a viewer pane costs while its program streams output.

Compares a pane running the frame host around `tmux attach` with a pane
running `tmux attach` directly, at 50, 500 and 5000 lines a second.
Everything runs on tmux sockets in a temporary directory.

Usage: frame-cost.py path/to/dist/pappardelle
"""
import fcntl
import importlib.util
import json
import os
import pathlib
import pty
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

HARNESS = pathlib.Path(__file__).with_name('workspace-ready.py')
BINARY = str(pathlib.Path(sys.argv[1]).resolve())
TICKS = os.sysconf('SC_CLK_TCK')
PAGE = os.sysconf('SC_PAGE_SIZE')

spec = importlib.util.spec_from_file_location('wr', HARNESS)
wr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wr)


class Discard:
    def extend(self, data):
        pass


STREAM = '''import sys, time
rate = int(sys.argv[1])
line = "\\x1b[32m%06d\\x1b[0m " + "the quick brown fox jumps over the lazy dog " * 2 + "\\n"
n = 0
start = time.monotonic()
while True:
    n += 1
    sys.stdout.write(line % n)
    sys.stdout.flush()
    wait = start + n / rate - time.monotonic()
    if wait > 0:
        time.sleep(wait)
'''


def stat(pid):
    try:
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        rss = int(pathlib.Path(f'/proc/{pid}/statm').read_text().split()[1]) * PAGE
    except (FileNotFoundError, ProcessLookupError):
        return None
    return dict(ppid=int(fields[1]), cpu=(int(fields[11]) + int(fields[12])) / TICKS, rss=rss)


def tree(root):
    """CPU seconds and resident bytes of a process and its descendants."""
    stats = {int(p.name): stat(int(p.name)) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()}
    stats = {pid: s for pid, s in stats.items() if s}
    members, grew = {root}, True
    while grew:
        grew = False
        for pid, s in stats.items():
            if s['ppid'] in members and pid not in members:
                members.add(pid)
                grew = True
    return dict(cpu=sum(stats[p]['cpu'] for p in members if p in stats),
                rss=sum(stats[p]['rss'] for p in members if p in stats))


def run(mode, rate, seconds=6):
    root = pathlib.Path(tempfile.mkdtemp(prefix='pappa-frame-cost-'))
    (root / 'stream.py').write_text(STREAM)
    env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
    env.update(TMUX_TMPDIR=str(root), TERM='xterm-256color')
    outer = ['tmux', '-S', str(root / 'outer'), '-f', '/dev/null']
    inner = ['tmux', '-S', str(root / 'inner'), '-f', '/dev/null']

    def tmux(base, *args):
        return subprocess.run([*base, *args], env=env, cwd=root, capture_output=True, text=True)

    attach = f"env -u TMUX -u TMUX_PANE tmux -S {root / 'inner'} attach -t s"
    viewer = attach if mode == 'direct' else f"{BINARY} --internal-pane-frame --title agent -- {attach}"
    try:
        tmux(inner, 'new-session', '-d', '-x', '100', '-y', '50', '-s', 's',
             f'{sys.executable} {root / "stream.py"} {rate}').check_returncode()
        tmux(inner, 'set-option', '-t', 's', 'status', 'off')
        tmux(outer, 'new-session', '-d', '-x', '100', '-y', '52', '-s', 'o', viewer).check_returncode()
        tmux(outer, 'set-option', '-t', 'o', 'status', 'off')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 52, 100, 0, 0))
        client = subprocess.Popen([*outer, 'attach-session', '-t', 'o'], env=env, cwd=root,
                                  stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        threading.Thread(target=wr.answer_terminal_queries, args=(master, {'columns': 100}, Discard()),
                         daemon=True).start()
        time.sleep(2)
        pids = dict(
            viewer=int(tmux(outer, 'display-message', '-p', '-t', 'o', '#{pane_pid}').stdout),
            outerServer=int(tmux(outer, 'display-message', '-p', '#{pid}').stdout),
            innerServer=int(tmux(inner, 'display-message', '-p', '#{pid}').stdout),
        )
        screen = tmux(outer, 'capture-pane', '-p', '-t', 'o').stdout
        if 'quick brown fox' not in screen:
            raise RuntimeError('viewer shows no stream: ' + screen[:300])
        before = {name: tree(pid) for name, pid in pids.items()}
        time.sleep(seconds)
        after = {name: tree(pid) for name, pid in pids.items()}
        return {name: dict(cpuPercent=round((after[name]['cpu'] - before[name]['cpu']) / seconds * 100, 1),
                           rssMb=round(after[name]['rss'] / 1e6, 1)) for name in pids}
    finally:
        tmux(outer, 'kill-server')
        tmux(inner, 'kill-server')
        shutil.rmtree(root, ignore_errors=True)


for rate in (50, 500, 5000):
    for mode in ('direct', 'frame'):
        print(mode, rate, json.dumps(run(mode, rate)), flush=True)
