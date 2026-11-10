#!/usr/bin/env python3
"""Measure fresh main-workspace readiness using real tmux and dummy programs.

No existing sessions, credentials, agents or workspaces are used. OS caches are
not flushed. Optional subprocess tracing is a SEPARATE, perturbed run: Python
wrappers add overhead, so never compare its wall time with untraced samples.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


def run_sample(binary, shell_delay_ms, traced, timeout):
    with tempfile.TemporaryDirectory(prefix='pappa-ready-') as tmp:
        root = Path(tmp)
        home, repo, bin_dir = (root / name for name in ('home', 'repo', 'bin'))
        for directory in (home, repo, bin_dir, home / '.pappardelle'):
            directory.mkdir(parents=True, exist_ok=True)
        real_tools = {name: shutil.which(name) for name in ('tmux', 'git')}
        trace_file = root / 'commands.jsonl'
        if traced:
            wrapper = f'''#!{sys.executable}
import json, os, subprocess, sys, time
tools = {real_tools!r}
name = os.path.basename(sys.argv[0])
start = time.perf_counter_ns()
code = subprocess.call([tools[name], *sys.argv[1:]])
event = dict(tool=name, args=sys.argv[1:], startNs=start,
             durationNs=time.perf_counter_ns()-start, pid=os.getpid(), exitCode=code)
fd = os.open({str(trace_file)!r}, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(event)+'\\n').encode())
os.close(fd)
sys.exit(code)
'''
            for name in real_tools:
                tool = bin_dir / name
                tool.write_text(wrapper)
                tool.chmod(0o755)
        fixture = root / 'ready.py'
        fixture.write_text('''import json, pathlib, sys, time
kind = sys.argv[1]
pathlib.Path(sys.argv[2]).write_text(json.dumps({'readyNs': time.perf_counter_ns()}))
print(kind.upper() + '_READY', flush=True)
time.sleep(120)
''')
        def fixture_command(kind):
            return shlex.join([sys.executable, str(fixture), kind, str(root / (kind + '.json'))])
        (repo / '.pappardelle.yml').write_text(json.dumps({
            'version': 1, 'issue_tracker': {'provider': 'beads'},
            'agent_profiles': {'fixture': {'command': fixture_command('agent')}},
            'agent_profile': 'fixture', 'companion_command': fixture_command('companion'),
            'profiles': {'dev': {'display_name': 'Dev'}}, 'default_profile': 'dev',
        }))
        (home / '.bashrc').write_text(f'sleep {shell_delay_ms / 1000}\n' if shell_delay_ms else '')
        (home / '.pappardelle/update-check.json').write_text(json.dumps({
            'checkedAt': int(time.time() * 1000), 'latestVersion': 'v0.0.0',
        }))
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(('PAPPARDELLE_', 'BEADS_', 'BD_')) or key in ('TMUX', 'TMUX_PANE', 'BASH_ENV', 'ENV'):
                env.pop(key)
        env.update(HOME=str(home), SHELL='/bin/bash', TERM='xterm-256color',
                   PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   TMUX_TMPDIR=str(root), PAPPARDELLE_TMUX_SOCKET='bench-inner')
        subprocess.run([real_tools['git'], 'init', '-q', '-b', 'main'], cwd=repo, env=env, check=True)

        def tmux(socket, *args):
            # Observer calls bypass wrappers and are excluded from command traces.
            return subprocess.run([real_tools['tmux'], '-L', socket, *args],
                                  cwd=repo, env=env, capture_output=True, text=True, timeout=5)

        start_ns, wall_start_ns = time.perf_counter_ns(), time.time_ns()
        milestones = {}
        log = ''
        try:
            result = tmux('bench-outer', '-f', '/dev/null', 'new-session', '-d',
                          '-x', '100', '-y', '52', '-s', 'bench', str(binary))
            if result.returncode:
                raise RuntimeError(result.stderr)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                for kind in ('agent', 'companion'):
                    ready = root / (kind + '.json')
                    if ready.exists() and kind + 'ReadyMs' not in milestones:
                        try:
                            milestones[kind + 'ReadyMs'] = (json.loads(ready.read_text())['readyNs'] - start_ns) / 1e6
                        except json.JSONDecodeError:
                            pass  # The child may still be writing its timestamp.
                clients = tmux('bench-inner', 'list-clients', '-F', '#{client_session}').stdout.splitlines()
                if {'agent-repo-main', 'companion-repo-main'}.issubset(clients):
                    milestones.setdefault('bothClientsAttachedMs', (time.perf_counter_ns() - start_ns) / 1e6)
                panes = tmux('bench-outer', 'list-panes', '-t', 'bench', '-F', '#{pane_id}').stdout.splitlines()
                for pane in panes:
                    screen = tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout
                    for kind in ('agent', 'companion'):
                        if kind.upper() + '_READY' in screen:
                            milestones.setdefault(kind + 'VisibleMs', (time.perf_counter_ns() - start_ns) / 1e6)
                required = ('agentReadyMs', 'companionReadyMs', 'bothClientsAttachedMs', 'agentVisibleMs', 'companionVisibleMs')
                if all(key in milestones for key in required):
                    # Collect immediate follow-up relayouts, outside readiness timing.
                    time.sleep(0.3)
                    break
                time.sleep(0.02)
            else:
                raise RuntimeError(f'Timed out waiting for workspace readiness: {milestones}')
        finally:
            log = '\n'.join(p.read_text() for p in sorted((home / '.pappardelle/logs').glob('*.log')))
            tmux('bench-outer', 'kill-server')
            tmux('bench-inner', 'kill-server')
        milestones['bothVisibleMs'] = max(milestones['agentVisibleMs'], milestones['companionVisibleMs'])
        events = []
        for line in log.splitlines():
            try:
                stamp = datetime.datetime.fromisoformat(line.split(' ')[0].replace('Z', '+00:00')).timestamp()
            except ValueError:
                continue
            events.append({'elapsedMs': (stamp * 1e9 - wall_start_ns) / 1e6,
                           'message': line.partition(' ')[2].replace(tmp, '<fixture>')})
        commands = []
        if trace_file.exists():
            for line in trace_file.read_text().splitlines():
                event = json.loads(line)
                event['elapsedMs'] = (event.pop('startNs') - start_ns) / 1e6
                event['durationMs'] = event.pop('durationNs') / 1e6
                event['args'] = [arg.replace(tmp, '<fixture>') for arg in event['args']]
                commands.append(event)
        return dict(shellDelayMs=shell_delay_ms, traced=traced, milestones=milestones,
                    logEvents=events, commands=commands)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path('dist/pappardelle'))
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--shell-delay-ms', type=int, default=1000)
    parser.add_argument('--trace', action='store_true')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--output', type=Path, default=Path('benchmark-results/workspace-startup-benchmark.json'))
    args = parser.parse_args()
    if args.runs < 1 or args.shell_delay_ms < 0 or args.timeout <= 0:
        parser.error('runs and timeout must be positive; shell delay must be nonnegative')
    if not args.binary.is_file() or not all(shutil.which(name) for name in ('tmux', 'git')):
        parser.error('build the native binary and install tmux and git first')
    binary = args.binary.resolve()
    samples = {'cleanShell': [], 'delayedShell': []}
    for index in range(args.runs):
        order = list(samples) if index % 2 == 0 else list(reversed(samples))
        for name in order:
            sample = run_sample(binary, 0 if name == 'cleanShell' else args.shell_delay_ms, False, args.timeout)
            samples[name].append(sample)
            print(name, index + 1, json.dumps(sample['milestones']), flush=True)
    result = {'environment': {
        'platform': platform.platform(), 'python': platform.python_version(),
        'tmux': subprocess.check_output(['tmux', '-V'], text=True).strip(),
        'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'binary': str(args.binary), 'binarySha256': hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest(),
        'bun': subprocess.check_output(['bun', '--version'], text=True).strip(),
        'terminal': 'detached real tmux, 100x52',
        'scope': 'fresh isolated HOME/repo/servers/sessions; OS caches NOT flushed; dummy Python agents; no network or real agent startup',
        'observation': '20 ms polling plus observer subprocess overhead; readiness files timestamped by fixtures; client attachment and visible markers sampled separately',
    }, 'samples': samples, 'mediansMs': {
        name: {key: statistics.median(s['milestones'][key] for s in runs) for key in runs[0]['milestones']}
        for name, runs in samples.items()
    }}
    if args.trace:
        trace = run_sample(binary, 0, True, args.timeout)
        result['instrumentedSample'] = trace
        chrome = {'traceEvents': [dict(name=e['tool'] + ' ' + shlex.join(e['args']),
                   cat='subprocess', ph='X', ts=e['elapsedMs'] * 1000,
                   dur=e['durationMs'] * 1000, pid=e['pid'], tid=1,
                   args={'exitCode': e['exitCode']}) for e in trace['commands']]}
        chrome['traceEvents'] += [dict(name=e['message'], cat='application-log', ph='i', s='g',
                                      ts=e['elapsedMs'] * 1000, pid=0, tid=0) for e in trace['logEvents']]
        chrome['traceEvents'] += [dict(name=k, cat='readiness', ph='i', s='g', ts=v * 1000,
                                      pid=0, tid=0) for k, v in trace['milestones'].items()]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.with_suffix('.trace.json').write_text(json.dumps(chrome, indent=2) + '\n')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['mediansMs'], indent=2))


if __name__ == '__main__':
    main()
