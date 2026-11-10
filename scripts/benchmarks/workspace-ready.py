#!/usr/bin/env python3
"""Measure fresh/reopened main-workspace readiness with real tmux and dummy programs.

No existing sessions, credentials, agents or workspaces are used. OS caches are
not flushed. Optional subprocess tracing is a SEPARATE, perturbed run: Python
wrappers add overhead, so never compare its wall time with untraced samples.
"""
import argparse
from contextlib import contextmanager
import datetime
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import shlex
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import time


@contextmanager
def fixture_directory():
    root = tempfile.mkdtemp(prefix='pappa-ready-')
    try:
        yield root
    finally:
        # pipe-pane monitors can finish a final write after kill-server returns.
        for attempt in range(40):
            try:
                shutil.rmtree(root)
                break
            except OSError as exc:
                if exc.errno != errno.ENOTEMPTY or attempt == 39:
                    raise
                time.sleep(0.05)


def run_sample(binary, shell_delay_ms, traced, timeout, width=100, existing=False, workspaces=0, startup_trace=False, filter_cycles=0, tmux_delay_ms=0, max_filter_close_ms=None, outside_tmux=False, profile_emoji=None):
    with fixture_directory() as tmp:
        root = Path(tmp)
        home, repo, bin_dir = (root / name for name in ('home', 'repo', 'bin'))
        for directory in (home, repo, bin_dir, home / '.pappardelle'):
            directory.mkdir(parents=True, exist_ok=True)
        real_tools = {name: shutil.which(name) for name in ('tmux', 'git')}
        provider_log = root / 'providers.jsonl'
        provider_stub = f'''#!{sys.executable}
import json, os, re, sys
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
supported = (name == 'bd' and args and args[0] in ('list', 'show', 'ready')) or (name == 'gh' and args[:2] in (['repo', 'view'], ['api', 'graphql'], ['pr', 'view']))
fd = os.open({str(provider_log)!r}, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(dict(tool=name, args=args, supported=supported))+'\\n').encode())
os.close(fd)
if name == 'bd':
    keys = [key for arg in args if arg.startswith('--id=') for key in arg[5:].split(',')]
    print(json.dumps([dict(id=k, title='Fixture '+k, status='open') for k in keys]))
elif name == 'gh' and args[:2] == ['repo', 'view']:
    print('fixture/repo')
elif name == 'gh' and args[:2] == ['api', 'graphql']:
    query = next((a for a in args if a.startswith('query=')), '')
    print(json.dumps(dict(data={{key: dict(nodes=[]) for key in ['search', *re.findall(r'pr[0-9]+', query)]}})))
elif name == 'gh' and args[:2] == ['pr', 'view']:
    print('no pull requests found', file=sys.stderr)
    sys.exit(1)
else:
    print('Unexpected provider invocation', file=sys.stderr)
    sys.exit(97)
'''
        for name in ('bd', 'gh', 'glab', 'acli', 'claude', 'codex'):
            tool = bin_dir / name
            tool.write_text(provider_stub)
            tool.chmod(0o755)
        trace_file = root / 'commands.jsonl'
        if traced or tmux_delay_ms:
            wrapper = f'''#!{sys.executable}
import json, os, subprocess, sys, time
tools = {real_tools!r}
name = os.path.basename(sys.argv[0])
start = time.perf_counter_ns()
fd = os.open({str(trace_file)!r}, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(dict(tool=name, args=sys.argv[1:], startNs=start,
                            pid=os.getpid(), phase='start'))+'\\n').encode())
if name == 'tmux': time.sleep({tmux_delay_ms / 1000!r})
code = subprocess.call([tools[name], *sys.argv[1:]])
event = dict(tool=name, args=sys.argv[1:], startNs=start,
             durationNs=time.perf_counter_ns()-start, pid=os.getpid(), exitCode=code, phase='end')
os.write(fd, (json.dumps(event)+'\\n').encode())
os.close(fd)
sys.exit(code)
'''
            for name in (real_tools if traced else ('tmux',)):
                tool = bin_dir / name
                tool.write_text(wrapper)
                tool.chmod(0o755)
        fixture = root / 'ready.py'
        fixture.write_text('''import json, os, pathlib, signal, sys, time
kind = sys.argv[1]
pathlib.Path(sys.argv[2]).write_text(json.dumps({'readyNs': time.perf_counter_ns(), 'pid': os.getpid()}))
print(kind.upper() + '_READY', flush=True)
signal.pause()
''')
        def fixture_command(kind):
            return shlex.join([sys.executable, str(fixture), kind, str(root / (kind + '.json'))])
        (repo / '.pappardelle.yml').write_text(json.dumps({
            'version': 1, 'issue_tracker': {'provider': 'beads'},
            'vcs_host': {'provider': 'github'},
            'agent_profiles': {'fixture': {'command': fixture_command('agent')}},
            'agent_profile': 'fixture', 'companion_command': fixture_command('companion'),
            'profiles': {'dev': {'display_name': 'Dev'}}, 'default_profile': 'dev',
            **({'default_emoji': profile_emoji} if profile_emoji is not None else {}),
        }))
        (home / '.bashrc').write_text(f'sleep {shell_delay_ms / 1000}\n' if shell_delay_ms else '')
        (home / '.pappardelle/update-check.json').write_text(json.dumps({
            'checkedAt': int(time.time() * 1000), 'latestVersion': 'v0.0.0',
        }))
        env = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'USER': 'fixture',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        env.update(HOME=str(home), SHELL='/bin/bash', TERM='xterm-256color',
                   PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   XDG_CONFIG_HOME=str(home / '.config'), XDG_STATE_HOME=str(home / '.local/state'),
                   XDG_CACHE_HOME=str(home / '.cache'),
                   TMUX_TMPDIR=str(root), PAPPARDELLE_TMUX_SOCKET='bench-inner')
        if startup_trace:
            env['PAPPARDELLE_STARTUP_TRACE'] = '1'
        subprocess.run([real_tools['git'], 'init', '-q', '-b', 'main'], cwd=repo, env=env, check=True)
        subprocess.run([real_tools['git'], '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                        'commit', '--allow-empty', '-qm', 'Fixture'], cwd=repo, env=env, check=True)
        keys = [f'bench-{i+1}' for i in range(workspaces)]
        for key in keys:
            worktree = home / '.worktrees/repo' / key
            worktree.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([real_tools['git'], 'worktree', 'add', '-qb', key, str(worktree)],
                           cwd=repo, env=env, check=True)
        registry = home / '.pappardelle/repos/repo/open-spaces.json'
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text(json.dumps(keys))

        def tmux(socket, *args):
            # Observer calls bypass wrappers and are excluded from command traces.
            if outside_tmux and socket == 'bench-outer':
                socket = 'default'
                args = tuple('pappardelle-repo' + arg[5:] if arg == 'bench' or arg.startswith('bench:') else arg for arg in args)
            return subprocess.run([real_tools['tmux'], '-L', socket, *args],
                                  cwd=repo, env=env, capture_output=True, text=True, timeout=5)

        kinds = ('agent',) if width < 100 else ('agent', 'companion')

        def rail_visible(screen):
            return 'main' in screen and (not keys or keys[-1] in screen)

        def filter_roundtrip():
            def wait_screen(accept):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    drain_launchers()
                    screen = tmux('bench-outer', 'capture-pane', '-p', '-t', 'bench:0.0').stdout
                    if accept(screen):
                        return screen
                    time.sleep(0.005)
                raise RuntimeError('Rail transition timed out: ' + screen)
            start = time.perf_counter_ns()
            open_start = (start - start_ns) / 1e6
            tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', '/').check_returncode()
            opened = wait_screen(lambda screen: 'filter by key or title' in screen)
            open_ms = (time.perf_counter_ns() - start) / 1e6
            start = time.perf_counter_ns()
            close_start = (start - start_ns) / 1e6
            tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', 'Escape').check_returncode()
            closed = wait_screen(lambda screen: 'filter by key or title' not in screen and rail_visible(screen))
            close_ms = (time.perf_counter_ns() - start) / 1e6
            time.sleep(0.3)
            return dict(openStartMs=open_start, closeStartMs=close_start, openMs=open_ms, closeMs=close_ms, opened=opened, closed=closed)

        launchers = []

        def drain_launchers():
            for _, master in launchers:
                try:
                    while os.read(master, 65536):
                        pass
                except BlockingIOError:
                    pass
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise

        def launch():
            if outside_tmux:
                master, slave = pty.openpty()
                try:
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 52, width, 0, 0))
                    os.set_blocking(master, False)
                    launcher = subprocess.Popen([str(binary)], cwd=repo, env=env, stdin=slave,
                                                stdout=slave, stderr=slave, start_new_session=True)
                    launchers.append((launcher, master))
                except BaseException:
                    os.close(master)
                    raise
                finally:
                    os.close(slave)
                return
            result = tmux('bench-outer', '-f', '/dev/null', 'new-session', '-d',
                          '-x', str(width), '-y', '52', '-s', 'bench', shlex.quote(str(binary)))
            if result.returncode:
                raise RuntimeError(result.stderr)

        def observe(start_ns, retained=None):
            milestones, identities, screens = {}, {}, {}
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain_launchers()
                for kind in kinds:
                    ready = root / (kind + '.json')
                    if ready.exists():
                        try:
                            identity = json.loads(ready.read_text())
                            os.kill(identity['pid'], 0)
                            identities[kind] = identity
                            if retained is not None:
                                if identity != retained[kind]:
                                    raise RuntimeError(f'{kind} process was replaced on reopen')
                            else:
                                milestones[kind + 'ReadyMs'] = (identity['readyNs'] - start_ns) / 1e6
                        except json.JSONDecodeError:
                            pass  # The child may still be writing its timestamp.
                clients = tmux('bench-inner', 'list-clients', '-F', '#{client_session}').stdout.splitlines()
                for kind in kinds:
                    if kind + '-repo-main' in clients:
                        milestones.setdefault(kind + 'AttachedMs', (time.perf_counter_ns() - start_ns) / 1e6)
                panes = tmux('bench-outer', 'list-panes', '-t', 'bench', '-F', '#{pane_id}').stdout.splitlines()
                for pane in panes:
                    screen = tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout
                    screens[pane] = screen
                    if pane == panes[0] and rail_visible(screen):
                        milestones.setdefault('railVisibleMs', (time.perf_counter_ns() - start_ns) / 1e6)
                    for kind in kinds:
                        if kind.upper() + '_READY' in screen:
                            milestones.setdefault(kind + 'VisibleMs', (time.perf_counter_ns() - start_ns) / 1e6)
                required = ['railVisibleMs', *[kind + suffix for kind in kinds for suffix in ('AttachedMs', 'VisibleMs')]]
                if all(key in milestones for key in required) and len(identities) == len(kinds):
                    # Collect immediate follow-up relayouts, outside readiness timing.
                    time.sleep(0.3)
                    for kind, identity in identities.items():
                        os.kill(identity['pid'], 0)
                        if json.loads((root / (kind + '.json')).read_text()) != identity:
                            raise RuntimeError(f'{kind} process changed during observation window')
                    screens = {pane: tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout for pane in panes}
                    milestones['requiredClientsAttachedMs'] = max(milestones[k + 'AttachedMs'] for k in kinds)
                    milestones['requiredVisibleMs'] = max(milestones[k + 'VisibleMs'] for k in kinds)
                    return milestones, identities, screens
                time.sleep(0.02)
            raise RuntimeError(f'Timed out waiting for workspace readiness: {milestones}; screens={screens}')

        start_ns, wall_start_ns = time.perf_counter_ns(), time.time_ns()
        milestones, identities, screens, retained = {}, {}, {}, None
        error = None
        interactions = []
        try:
            if existing:
                launch()
                _, retained, _ = observe(start_ns)
                previous_pid = int(tmux('bench-outer', 'display-message', '-p', '-t', 'bench:0.0', '#{pane_pid}').stdout)
                tmux('bench-outer', 'kill-server')
                deadline = time.monotonic() + timeout
                while True:
                    try:
                        os.kill(previous_pid, 0)
                        previous_alive = True
                    except ProcessLookupError:
                        previous_alive = False
                    if not previous_alive and not tmux('bench-inner', 'list-clients').stdout.strip():
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Preparation TUI did not exit or its viewer clients did not detach')
                    time.sleep(0.02)
            start_ns, wall_start_ns = time.perf_counter_ns(), time.time_ns()
            launch()
            milestones, identities, screens = observe(start_ns, retained)
            for _ in range(filter_cycles):
                interaction = filter_roundtrip()
                interactions.append(interaction)
                if max_filter_close_ms is not None and interaction['closeMs'] > max_filter_close_ms:
                    raise RuntimeError(f'Rail return took {interaction["closeMs"]:.1f} ms; budget {max_filter_close_ms} ms')
            if startup_trace:
                pid = int(tmux('bench-outer', 'display-message', '-p', '-t', 'bench:0.0', '#{pane_pid}').stdout)
                deadline = time.monotonic() + timeout
                while True:
                    drain_launchers()
                    records = [json.loads(line.partition('[startup] ')[2])
                               for p in (home / '.pappardelle/logs').glob('*.log')
                               for line in p.read_text().splitlines() if '[startup] {' in line]
                    finished = [r for r in records if r['pid'] == pid and r['stage'] == 'finished']
                    if finished:
                        if finished[-1]['outcome'] != 'ok':
                            raise RuntimeError('Startup trace ended incomplete')
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Startup trace did not finish')
                    time.sleep(0.02)
        except Exception as exc:
            error = str(exc).replace(tmp, '<fixture>')
        finally:
            log = '\n'.join(p.read_text() for p in sorted((home / '.pappardelle/logs').glob('*.log')))
            # Read traces before teardown so killed viewer wrappers stay incomplete.
            command_lines = trace_file.read_text().splitlines() if trace_file.exists() else []
            providers = [json.loads(line) for line in provider_log.read_text().splitlines()] if provider_log.exists() else []
            if any(not call['supported'] for call in providers):
                error = error or 'Unexpected provider invocation; inspect providerCalls'
            tmux('bench-outer', 'kill-server')
            tmux('bench-inner', 'kill-server')
            for launcher, master in launchers:
                try:
                    launcher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    launcher.kill()
                    launcher.wait()
                finally:
                    os.close(master)
        events = []
        for line in log.splitlines():
            try:
                stamp = datetime.datetime.fromisoformat(line.split(' ')[0].replace('Z', '+00:00')).timestamp()
            except ValueError:
                continue
            if stamp * 1e9 < wall_start_ns:
                continue
            events.append({'elapsedMs': (stamp * 1e9 - wall_start_ns) / 1e6,
                           'message': line.partition(' ')[2].replace(tmp, '<fixture>')})
        commands, pending = [], {}
        if command_lines:
            for line in command_lines:
                event = json.loads(line)
                if event['startNs'] < start_ns:
                    continue
                event['elapsedMs'] = (event.pop('startNs') - start_ns) / 1e6
                event['args'] = [arg.replace(tmp, '<fixture>') for arg in event['args']]
                if event.pop('phase') == 'start':
                    pending[event['pid']] = event
                    continue
                pending.pop(event['pid'], None)
                event['durationMs'] = event.pop('durationNs') / 1e6
                commands.append(event)
        return dict(shellDelayMs=shell_delay_ms, traced=traced, startupTrace=startup_trace, width=width, existing=existing,
                    tmuxDelayMs=tmux_delay_ms, interactions=interactions,
                    outsideTmux=outside_tmux, profileEmoji=profile_emoji,
                    workspaces=workspaces, success=error is None, error=error,
                    readiness='pre-existing' if existing else 'new', identities=identities,
                    retainedIdentities=retained, milestones=milestones, screens=screens,
                    logEvents=events, commands=commands, incompleteCommands=list(pending.values()),
                    providerCalls=providers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path('dist/pappardelle'))
    parser.add_argument('--candidate', type=Path, help='Alternate baseline/candidate order within each case')
    parser.add_argument('--widths', type=int, nargs='+', default=[80, 100, 160])
    parser.add_argument('--workspaces', type=int, nargs='+', default=[0, 3])
    parser.add_argument('--modes', choices=['fresh', 'existing'], nargs='+', default=['fresh', 'existing'])
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--shell-delay-ms', type=int, default=1000)
    parser.add_argument('--trace', action='store_true')
    parser.add_argument('--startup-trace', action='store_true', help='Enable application spans; do not mix these timings with trace-disabled medians')
    parser.add_argument('--compare-tracing', action='store_true', help='Alternate trace-disabled/enabled launches of the same binary')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--filter-cycles', type=int, default=0, help='Measure / then Escape until workspace rows return')
    parser.add_argument('--tmux-delay-ms', type=int, default=0, help='Synthetic per-call tmux delay; also incurs Python wrapper overhead, not native timing')
    parser.add_argument('--max-filter-close-ms', type=float, help='Optional diagnostic assertion for rail-return latency')
    parser.add_argument('--outside-tmux', action='store_true', help='Launch on an isolated PTY, including the parent launcher and delegated TUI')
    parser.add_argument('--profile-emoji', help='Configure the fixture rail emoji to exercise Unicode width measurement')
    parser.add_argument('--output', type=Path, required=True, help='New artifact path; historical results are never overwritten')
    args = parser.parse_args()
    if args.runs < 1 or args.shell_delay_ms < 0 or args.timeout <= 0 or args.filter_cycles < 0 or args.tmux_delay_ms < 0:
        parser.error('runs and timeout must be positive; shell delay must be nonnegative')
    if not args.binary.is_file() or not all(shutil.which(name) for name in ('tmux', 'git')):
        parser.error('build the native binary and install tmux and git first')
    if args.output.exists():
        parser.error('output exists; choose a new artifact path')
    if args.compare_tracing and (args.candidate or args.startup_trace or args.trace):
        parser.error('--compare-tracing cannot be combined with --candidate, --startup-trace or --trace')
    if any(w < 1 for w in args.widths) or any(w < 0 for w in args.workspaces):
        parser.error('widths must be positive and workspace counts nonnegative')
    binaries = {'baseline': args.binary.resolve()}
    if args.compare_tracing:
        binaries = {'traceDisabled': args.binary.resolve(), 'traceEnabled': args.binary.resolve()}
    if args.candidate:
        if not args.candidate.is_file():
            parser.error('candidate executable does not exist')
        binaries['candidate'] = args.candidate.resolve()
    samples = {}
    result = {'environment': {
        'platform': platform.platform(), 'python': platform.python_version(),
        'tmux': subprocess.check_output(['tmux', '-V'], text=True).strip(),
        'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'git': subprocess.check_output(['git', '--version'], text=True).strip(),
        'shell': subprocess.check_output(['/bin/bash', '--version'], text=True).splitlines()[0],
        'executables': {name: {'binary': str(binary),
                              'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                              'installationRoot': str(binary.parent.parent)}
                        for name, binary in binaries.items()},
        'bun': subprocess.check_output(['bun', '--version'], text=True).strip(),
        'terminal': ('PTY launcher with attached real tmux' if args.outside_tmux else 'detached real tmux') + ', variable width x 52',
        'scope': 'isolated HOME/repo/servers; OS caches NOT flushed; dummy Python agents; bd/gh stubbed; update cache primed; no real agent startup',
        'observation': '20 ms polling plus observer subprocess overhead; readiness files timestamped by fixtures; client attachment and visible markers sampled separately',
    }, 'settings': vars(args) | {'binary': str(args.binary), 'candidate': str(args.candidate) if args.candidate else None,
                                'output': str(args.output)}, 'samples': samples}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        result['summary'] = {}
        for name, runs in samples.items():
            valid = [s for s in runs if s['success']]
            result['summary'][name] = {
                'successes': len(valid), 'failures': len(runs) - len(valid),
                'milestonesMs': {key: {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
                                 for key in (valid[0]['milestones'] if valid else [])
                                 for values in [[s['milestones'][key] for s in valid]]},
            }
            for metric in ('openMs', 'closeMs'):
                values = [i[metric] for s in runs for i in s['interactions']]
                if values:
                    result['summary'][name]['filter' + metric[0].upper() + metric[1:]] = {
                        'median': statistics.median(values), 'min': min(values), 'max': max(values),
                        'observations': len(values),
                    }
        args.output.write_text(json.dumps(result, indent=2) + '\n')

    cases = [(width, workspaces, mode, delay)
             for width in args.widths for workspaces in args.workspaces for mode in args.modes
             for delay in ([0, args.shell_delay_ms] if mode == 'fresh' and args.shell_delay_ms else [0])]
    for index in range(args.runs):
        for width, workspaces, mode, delay in cases:
            order = list(binaries) if index % 2 == 0 else list(reversed(binaries))
            for name in order:
                key = f'{name}/{width}x52/{workspaces}spaces/{mode}/{delay}ms-shell'
                sample = run_sample(binaries[name], delay, False, args.timeout, width, mode == 'existing', workspaces, args.startup_trace or name == 'traceEnabled', args.filter_cycles, args.tmux_delay_ms, args.max_filter_close_ms, args.outside_tmux, args.profile_emoji)
                samples.setdefault(key, []).append(sample)
                save()
                print(key, index + 1, json.dumps(sample['milestones'] if sample['success'] else sample['error']), flush=True)
    if args.trace:
        trace = run_sample(binaries['baseline'], 0, True, args.timeout, 100, False, 3, args.startup_trace, args.filter_cycles, args.tmux_delay_ms, args.max_filter_close_ms, args.outside_tmux, args.profile_emoji)
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
    save()
    failures = sum(s['failures'] for s in result['summary'].values())
    print(f'{sum(len(s) for s in samples.values())} samples; {failures} failures; {args.output}')
    if failures or (args.trace and not result['instrumentedSample']['success']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
