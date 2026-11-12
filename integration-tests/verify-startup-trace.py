#!/usr/bin/env python3
"""Verify startup correlation across an existing tmux server and real CLI restart."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import runpy
import shlex
import struct
import subprocess
import sys
import termios
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path('dist/pappardelle'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    harness = runpy.run_path(str(Path(__file__).resolve().parent.parent / 'scripts/benchmarks/workspace-ready.py'))
    with harness['fixture_directory']() as tmp:
        root = Path(tmp)
        home, repo, bin_dir = [root / part for part in ('home', 'repo', 'bin')]
        for directory in (home, repo, bin_dir):
            directory.mkdir()
        env = dict(HOME=str(home), SHELL='/bin/bash', TERM='xterm-256color',
                   PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   TMUX_TMPDIR=str(root), PAPPARDELLE_TMUX_SOCKET='trace-inner',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
        # With the flag on the TUI starts a status daemon that outlives it. The
        # fixture's teardown stops every process that carries this marker.
        env[harness['FIXTURE_MARKER']] = tmp
        # Beside the database under HOME, the socket's path is too long for
        # macOS, whose temp directory is deep.
        env['PAPPARDELLE_STATUS_SOCKET'] = str(root / 'status-1.sock')
        # The fixture's HOME has no config, so the state mode comes from the override.
        if 'PAPPARDELLE_SQLITE_STATE' in os.environ:
            env['PAPPARDELLE_SQLITE_STATE'] = os.environ['PAPPARDELLE_SQLITE_STATE']
        for tool in ('bd', 'gh', 'glab', 'acli', 'claude', 'codex'):
            target = bin_dir / tool
            target.write_text(f'#!{sys.executable}\nprint("[]")\n')
            target.chmod(0o755)
        ready = root / 'agent.py'
        ready.write_text('import signal\nprint("FIXTURE_READY", flush=True)\nsignal.pause()\n')
        command = shlex.join([sys.executable, str(ready)])
        (repo / '.pappardelle.yml').write_text(json.dumps({
            'version': 1, 'issue_tracker': {'provider': 'beads'}, 'vcs_host': {'provider': 'github'},
            'agent_profiles': {'fixture': {'command': command}}, 'agent_profile': 'fixture',
            'companion_command': command, 'profiles': {'dev': {'display_name': 'Dev'}},
            'default_profile': 'dev',
        }))
        subprocess.run(['git', 'init', '-qb', 'main'], cwd=repo, env=env, check=True)

        def tmux(*argv, socket='default'):
            return subprocess.run(['tmux', '-L', socket, *argv], cwd=repo, env=env,
                                  capture_output=True, text=True, timeout=5)

        def records():
            return [json.loads(line.partition('[startup] ')[2])
                    for file in (home / '.pappardelle/logs').glob('*.log')
                    for line in file.read_text().splitlines() if '[startup] {' in line]

        def wait_ready(excluding=None):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                drain_terminal()
                completed = [r for r in records() if r['stage'] == 'finished' and r['outcome'] == 'ok'
                             and r['launchId'] != excluding]
                if completed:
                    return completed[-1]
                time.sleep(0.02)
            raise RuntimeError('Startup trace did not finish: ' + repr(records()))

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 52, 100, 0, 0))
        os.set_blocking(master, False)

        def drain_terminal():
            try:
                while os.read(master, 65536):
                    pass
            except BlockingIOError:
                pass

        launcher = None
        try:
            # This server predates the tracing environment; client inheritance cannot enable it.
            tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'sentinel', '-x', '100', '-y', '52').check_returncode()
            assert tmux('show-environment', '-g', 'PAPPARDELLE_STARTUP_TRACE').returncode != 0
            env['PAPPARDELLE_STARTUP_TRACE'] = '1'
            launcher = subprocess.Popen([str(binary)], cwd=repo, env=env, stdin=slave,
                                        stdout=slave, stderr=slave, start_new_session=True)
            first = wait_ready()
            launches = records()
            parent = next(r for r in launches if r['pid'] == launcher.pid)
            assert first['pid'] != launcher.pid
            assert first['parentLaunchId'] == parent['launchId']
            persisted = tmux('display-message', '-p', '-t', '=pappardelle-repo:^', '#{pane_start_command}').stdout
            assert first['launchId'] not in persisted and parent['launchId'] not in persisted
            before_help = len(launches)
            subprocess.run([str(binary), '--help'], env=env, cwd=repo, capture_output=True, check=True, timeout=5)
            assert len(records()) == before_help
            restarted = subprocess.run([str(binary), 'restart'], env=env, cwd=repo,
                                       capture_output=True, text=True, timeout=15)
            restarted.check_returncode()
            second = wait_ready(excluding=first['launchId'])
            assert second['pid'] != first['pid'] and second['launchId'] != first['launchId']
            assert second['parentLaunchId'] == parent['launchId']
            assert not any(r['stage'] == 'finished' and r['outcome'] != 'ok' for r in records() if r['pid'] != launcher.pid)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(dict(first=first, restarted=second, parent=parent,
                                                  restartOutput=restarted.stdout.replace(tmp, '<fixture>'),
                                                  records=records()), indent=2) + '\n')
            print('Existing-server propagation, fresh launch IDs/PIDs, restart command and subcommand isolation passed')
        finally:
            tmux('kill-server')
            tmux('kill-server', socket='trace-inner')
            if launcher:
                try:
                    launcher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    launcher.kill()
                    launcher.wait()
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    main()
