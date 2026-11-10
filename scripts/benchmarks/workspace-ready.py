#!/usr/bin/env python3
"""Measure fresh/reopened main-workspace readiness with real tmux and dummy programs.

No existing sessions, credentials, agents or workspaces are used. OS caches are
not flushed. Optional subprocess tracing is a SEPARATE, perturbed run: Python
wrappers add overhead, so never compare its wall time with untraced samples.
"""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import re
import shlex
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


FIXTURE_PREFIX = 'pappa-ready-'
# Every fixture process inherits this, including the tmux servers, the TUI and
# the status monitors tmux spawns. Teardown finds them by it, because they are
# not children of this script and outlive kill-server.
FIXTURE_MARKER = 'PAPPA_BENCH_FIXTURE'


def fixture_processes():
    """Map each live process carrying the fixture marker to its fixture root."""
    found = {}
    needle = f'{FIXTURE_MARKER}='
    if os.path.isdir('/proc/self'):
        for entry in os.listdir('/proc'):
            if not entry.isdigit() or int(entry) == os.getpid():
                continue
            try:
                with open(f'/proc/{entry}/environ', 'rb') as f:
                    variables = f.read().decode(errors='replace').split('\0')
            except OSError:
                continue
            for variable in variables:
                if variable.startswith(needle):
                    found[int(entry)] = variable[len(needle):]
    else:
        # macOS: -E appends the environment of the user's own processes.
        out = subprocess.run(['ps', '-axwwE', '-o', 'pid=', '-o', 'command='],
                             capture_output=True, text=True).stdout
        for line in out.splitlines():
            pid, _, rest = line.strip().partition(' ')
            if needle not in rest or not pid.isdigit() or int(pid) == os.getpid():
                continue
            found[int(pid)] = rest.split(needle, 1)[1].split(' ', 1)[0]
    return found


def terminate_fixture(root):
    pids = [pid for pid, owner in fixture_processes().items() if owner == root]
    for sig, grace in ((signal.SIGTERM, 3), (signal.SIGKILL, 1)):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + grace
        while pids and time.monotonic() < deadline:
            pids = [pid for pid in pids if pid_alive(pid)]
            time.sleep(0.02)
        if not pids:
            return


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); it holds no files, so treat it as gone.
    try:
        with open(f'/proc/{pid}/stat') as f:
            return f.read().rsplit(')', 1)[1].split()[0] != 'Z'
    except OSError:
        return True


def remove_fixture(root):
    terminate_fixture(root)
    shutil.rmtree(root, ignore_errors=True)
    if os.path.exists(root):
        print(f'warning: could not remove fixture {root}', file=sys.stderr)


def sweep_stale_fixtures():
    """Remove fixtures whose run died before teardown, e.g. killed by a timeout.

    The directory name carries the owning run's PID. Its tmux servers and
    monitors may still be alive; they are terminated with the directory.
    """
    for root in Path(tempfile.gettempdir()).glob(f'{FIXTURE_PREFIX}*'):
        owner = root.name[len(FIXTURE_PREFIX):].split('-', 1)[0]
        if root.is_dir() and owner.isdigit() and not pid_alive(int(owner)):
            remove_fixture(str(root))


TERMINAL_QUERY = re.compile(rb'\x1b\](4;\d+|1[0-2]);\?(?:\x07|\x1b\\)|\x1b\[(>?)0?c|\x1b\[>0?q|\x1b\[1[48]t|\x1b\[\?2026\$p')


def answer_terminal_queries(master, columns, rows=52):
    """Stand in for the terminal emulator behind the outer tmux client.

    tmux 3.6+ forwards a pane's palette query to its client's terminal. With
    nothing answering, each viewer frame waits out the renderer's 300 ms probe
    before it starts its program, which a real terminal never makes it do.

    tmux also asks the terminal what it is (device attributes and version),
    how large its window is and whether it has synchronized output when a
    client attaches. Until those are answered it
    holds a lone Escape typed at the client for 500 ms instead of its
    escape-time.
    """
    pending = b''
    try:
        while data := os.read(master, 65536):
            pending += data
            end = 0
            for match in TERMINAL_QUERY.finditer(pending):
                if match[1]:
                    reply = b'\x1b]' + match[1] + b';rgb:8080/8080/8080\x1b\\'
                elif match[0].endswith(b'q'):
                    reply = b'\x1bP>|fixture 0\x1b\\'
                elif match[0].endswith(b'p'):
                    reply = b'\x1b[?2026;2$y'
                elif match[0].endswith(b'18t'):
                    reply = b'\x1b[8;%d;%dt' % (rows, columns)
                elif match[0].endswith(b'14t'):
                    reply = b'\x1b[4;%d;%dt' % (rows * 20, columns * 10)
                else:
                    reply = b'\x1b[>0;0;0c' if match[2] else b'\x1b[?62;22c'
                os.write(master, reply)
                end = match.end()
            pending = pending[end:][-64:]
    except OSError:
        pass  # The client exited and closed its side of the pty.


@contextmanager
def fixture_directory():
    root = tempfile.mkdtemp(prefix=f'{FIXTURE_PREFIX}{os.getpid()}-')
    try:
        yield root
    finally:
        remove_fixture(root)


# The start of the search row's placeholder; a narrow rail cuts the rest off.
SEARCH_PLACEHOLDER = 'filter by key'


def run_sample(binary, shell_delay_ms, traced, timeout, width=100, existing=False, workspaces=0, startup_trace=False, filter_cycles=0, tmux_delay_ms=0, max_filter_close_ms=None, outside_tmux=False, profile_emoji=None, cold_switch=False, status_checks=0, skill_count=0, observe_seconds=0, poll_interval_ms=20, search_modes=(), agent_keys=0):
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
    aliases = ['search', *re.findall(r'pr[0-9]+', query)]
    checks = [dict(__typename='CheckRun', status='COMPLETED', conclusion='SUCCESS', name='fixture-check-'+str(i)) for i in range({status_checks})]
    node = dict(number=42, mergeable='MERGEABLE', commits=dict(nodes=[dict(commit=dict(statusCheckRollup=dict(contexts=dict(nodes=checks))))]), reviewThreads=dict(nodes=[dict(isResolved=False)]))
    print(json.dumps(dict(data={{key: dict(nodes=[node] if {status_checks} else []) for key in aliases}})))
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
space = pathlib.Path.cwd().name
ready = pathlib.Path(sys.argv[2])
if space != 'repo':
    ready = ready.with_name(kind + '-' + space + '.json')
ready.write_text(json.dumps({'readyNs': time.perf_counter_ns(), 'pid': os.getpid()}))
print(kind.upper() + '_READY ' + space, flush=True)
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
        for index in range(skill_count):
            skill = home / '.claude/skills' / f'fixture-{index}' / 'SKILL.md'
            skill.parent.mkdir(parents=True)
            skill.write_text(f'---\nname: fixture-{index}\ndescription: Fixture skill {index}\n---\nFixture content.\n')
        env = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'USER': 'fixture',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        env[FIXTURE_MARKER] = tmp
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

        def wait_screen(accept, pane='bench:0.0'):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                screen = tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout
                if accept(screen):
                    return screen
                time.sleep(0.005)
            raise RuntimeError('Pane transition timed out: ' + screen)

        def search_select(target, mode):
            """Search for one workspace by the end of its key and select it with Enter."""
            query, pane = target[-4:], 'bench:0.0'
            result = dict(mode=mode, target=target)
            start = time.perf_counter_ns()
            if mode == 'burst':
                # The whole interaction reaches the rail before it can draw the search row.
                tmux('bench-outer', 'send-keys', '-t', pane, '-l', '/' + query, ';',
                     'send-keys', '-t', pane, 'Enter').check_returncode()
            else:
                tmux('bench-outer', 'send-keys', '-t', pane, '/').check_returncode()
                wait_screen(lambda screen: SEARCH_PLACEHOLDER in screen)
                result['openMs'] = (time.perf_counter_ns() - start) / 1e6
                typed = time.perf_counter_ns()
                for character in query:
                    tmux('bench-outer', 'send-keys', '-t', pane, '-l', character).check_returncode()
                result['screen'] = wait_screen(lambda screen: '(1 match)' in screen and target in screen)
                result['filterMs'] = (time.perf_counter_ns() - typed) / 1e6
                result['zoomed'] = tmux('bench-outer', 'display-message', '-p', '-t', pane, '#{window_zoomed_flag}').stdout.strip() == '1'
                start = time.perf_counter_ns()
                tmux('bench-outer', 'send-keys', '-t', pane, 'Enter').check_returncode()
                # A short rail scrolls to the selected row, so the first rows may be out of view.
                wait_screen(lambda screen: 'match' not in screen and target in screen)
                result['closeMs'] = (time.perf_counter_ns() - start) / 1e6
            result['viewersMs'] = observe(start, selected=target, rail_shown=lambda screen: target in screen)[0]['requiredVisibleMs']
            return result

        def filter_roundtrip():
            start = time.perf_counter_ns()
            open_start = (start - start_ns) / 1e6
            tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', '/').check_returncode()
            opened = wait_screen(lambda screen: SEARCH_PLACEHOLDER in screen)
            open_ms = (time.perf_counter_ns() - start) / 1e6
            start = time.perf_counter_ns()
            close_start = (start - start_ns) / 1e6
            tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', 'Escape').check_returncode()
            closed = wait_screen(lambda screen: SEARCH_PLACEHOLDER not in screen and rail_visible(screen))
            close_ms = (time.perf_counter_ns() - start) / 1e6
            time.sleep(0.3)
            return dict(openStartMs=open_start, closeStartMs=close_start, openMs=open_ms, closeMs=close_ms, opened=opened, closed=closed)

        launchers = []

        def agent_key_echo():
            """Type into the agent's viewer pane through the client terminal, as a keyboard does.

            The fixture agent leaves its terminal in line mode, so the kernel echoes
            each key (Escape as ^[) and the time measured is the path there and back.
            """
            panes = tmux('bench-outer', 'list-panes', '-t', 'bench', '-F', '#{pane_id}').stdout.splitlines()
            pane = next(p for p in panes if 'AGENT_READY' in tmux('bench-outer', 'capture-pane', '-p', '-t', p).stdout)
            tmux('bench-outer', 'select-pane', '-t', pane).check_returncode()
            time.sleep(0.3)
            result = {}
            for metric, data, shown in (('letterMs', b'x', 'x'), ('escapeMs', b'\x1b', '^[')):
                before = tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout.count(shown)
                start = time.perf_counter_ns()
                os.write(launchers[-1][1], data)
                wait_screen(lambda screen: screen.count(shown) > before, pane)
                result[metric] = (time.perf_counter_ns() - start) / 1e6
                time.sleep(0.2)
            return result

        def attach_terminal(command):
            master, slave = pty.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 52, width, 0, 0))
                client = subprocess.Popen(command, cwd=repo, env=env, stdin=slave,
                                          stdout=slave, stderr=slave, start_new_session=True)
            except BaseException:
                os.close(master)
                raise
            finally:
                os.close(slave)
            terminal = threading.Thread(target=answer_terminal_queries, args=(master, width), daemon=True)
            terminal.start()
            launchers.append((client, master, terminal))

        def launch():
            if outside_tmux:
                attach_terminal([str(binary)])
                return
            # Status off as the real launcher sets it, so the window keeps all 52 rows.
            result = tmux('bench-outer', '-f', '/dev/null', 'new-session', '-d',
                          '-x', str(width), '-y', '52', '-s', 'bench', shlex.quote(str(binary)),
                          ';', 'set-option', '-t', 'bench', 'status', 'off')
            if result.returncode:
                raise RuntimeError(result.stderr)
            attach_terminal([real_tools['tmux'], '-L', 'bench-outer', 'attach-session', '-t', 'bench'])

        def observe(start_ns, retained=None, selected=None, rail_shown=rail_visible):
            milestones, identities, screens = {}, {}, {}
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                for kind in kinds:
                    ready = root / (kind + ('-' + selected if selected else '') + '.json')
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
                    if kind + '-repo-' + (selected or 'main') in clients:
                        milestones.setdefault(kind + 'AttachedMs', (time.perf_counter_ns() - start_ns) / 1e6)
                panes = tmux('bench-outer', 'list-panes', '-t', 'bench', '-F', '#{pane_id}').stdout.splitlines()
                for pane in panes:
                    screen = tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout
                    screens[pane] = screen
                    if pane == panes[0] and rail_shown(screen):
                        milestones.setdefault('railVisibleMs', (time.perf_counter_ns() - start_ns) / 1e6)
                    for kind in kinds:
                        if kind.upper() + '_READY ' + (selected or 'repo') in screen:
                            milestones.setdefault(kind + 'VisibleMs', (time.perf_counter_ns() - start_ns) / 1e6)
                required = ['railVisibleMs', *[kind + suffix for kind in kinds for suffix in ('AttachedMs', 'VisibleMs')]]
                if all(key in milestones for key in required) and len(identities) == len(kinds):
                    # Collect immediate follow-up relayouts, outside readiness timing.
                    time.sleep(0.3)
                    for kind, identity in identities.items():
                        os.kill(identity['pid'], 0)
                        if json.loads((root / (kind + ('-' + selected if selected else '') + '.json')).read_text()) != identity:
                            raise RuntimeError(f'{kind} process changed during observation window')
                    screens = {pane: tmux('bench-outer', 'capture-pane', '-p', '-t', pane).stdout for pane in panes}
                    milestones['requiredClientsAttachedMs'] = max(milestones[k + 'AttachedMs'] for k in kinds)
                    milestones['requiredVisibleMs'] = max(milestones[k + 'VisibleMs'] for k in kinds)
                    return milestones, identities, screens
                time.sleep(poll_interval_ms / 1000)
            raise RuntimeError(f'Timed out waiting for workspace readiness: {milestones}; screens={screens}')

        start_ns, wall_start_ns = time.perf_counter_ns(), time.time_ns()
        milestones, identities, screens, retained = {}, {}, {}, None
        error = None
        interactions = []
        searches = []
        typed = []
        cold = None
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
            observation_start = time.monotonic()
            while time.monotonic() - observation_start < observe_seconds:
                tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', 'F12').check_returncode()
                time.sleep(.02)
            for _ in range(filter_cycles):
                interaction = filter_roundtrip()
                interactions.append(interaction)
                if max_filter_close_ms is not None and interaction['closeMs'] > max_filter_close_ms:
                    raise RuntimeError(f'Rail return took {interaction["closeMs"]:.1f} ms; budget {max_filter_close_ms} ms')
            for target, mode in zip(keys, search_modes):
                searches.append(search_select(target, mode))
            if cold_switch:
                cold_start = time.perf_counter_ns()
                tmux('bench-outer', 'send-keys', '-t', 'bench:0.0', 'j').check_returncode()
                cold_milestones, cold_identities, cold_screens = observe(cold_start, selected=keys[-1])
                cold = dict(milestones=cold_milestones, identities=cold_identities, screens=cold_screens, startOffsetMs=(cold_start - start_ns) / 1e6)
            for _ in range(agent_keys):
                typed.append(agent_key_echo())
            if startup_trace:
                pid = int(tmux('bench-outer', 'display-message', '-p', '-t', 'bench:0.0', '#{pane_pid}').stdout)
                deadline = time.monotonic() + timeout
                while True:
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
            for launcher, master, terminal in launchers:
                try:
                    launcher.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    launcher.kill()
                    launcher.wait()
                finally:
                    terminal.join(timeout=2)
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
                    statusChecks=status_checks, skillCount=skill_count, observeSeconds=observe_seconds,
                    tmuxDelayMs=tmux_delay_ms, interactions=interactions, searches=searches, agentKeys=typed,
                    outsideTmux=outside_tmux, profileEmoji=profile_emoji, coldSwitch=cold, wallStartMs=wall_start_ns / 1e6,
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
    parser.add_argument('--poll-interval-ms', type=float, default=20, help='Readiness polling sleep; smaller values add observer overhead')
    parser.add_argument('--shell-delay-ms', type=int, default=1000)
    parser.add_argument('--trace', action='store_true')
    parser.add_argument('--startup-trace', action='store_true', help='Enable application spans; do not mix these timings with trace-disabled medians')
    parser.add_argument('--compare-tracing', action='store_true', help='Alternate trace-disabled/enabled launches of the same binary')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--filter-cycles', type=int, default=0, help='Measure / then Escape until workspace rows return')
    parser.add_argument('--search', choices=['typed', 'burst'], nargs='+', default=[], help='After startup, search for a workspace and select it: typed waits for each step to draw, burst sends / query Enter at once. Each mode selects a different workspace')
    parser.add_argument('--agent-keys', type=int, default=0, help='After startup, type a letter and Escape into the agent pane this many times and time each echo')
    parser.add_argument('--tmux-delay-ms', type=int, default=0, help='Synthetic per-call tmux delay; also incurs Python wrapper overhead, not native timing')
    parser.add_argument('--max-filter-close-ms', type=float, help='Optional diagnostic assertion for rail-return latency')
    parser.add_argument('--status-checks', type=int, default=0)
    parser.add_argument('--skill-count', type=int, default=0)
    parser.add_argument('--observe-seconds', type=float, default=0, help='Send harmless input while background refreshes run before switching')
    parser.add_argument('--cold-switch', action='store_true', help='After startup select the next workspace and measure its new sessions')
    parser.add_argument('--outside-tmux', action='store_true', help='Launch on an isolated PTY, including the parent launcher and delegated TUI')
    parser.add_argument('--profile-emoji', help='Configure the fixture rail emoji to exercise Unicode width measurement')
    parser.add_argument('--output', type=Path, required=True, help='New artifact path; historical results are never overwritten')
    args = parser.parse_args()
    sweep_stale_fixtures()
    if args.runs < 1 or args.shell_delay_ms < 0 or args.timeout <= 0 or min(args.filter_cycles, args.agent_keys) < 0 or args.tmux_delay_ms < 0:
        parser.error('runs and timeout must be positive; shell delay must be nonnegative')
    if args.poll_interval_ms <= 0 or min(args.status_checks, args.skill_count, args.observe_seconds) < 0:
        parser.error('poll interval must be positive; stress counts and observation duration must be nonnegative')
    if not args.binary.is_file() or not all(shutil.which(name) for name in ('tmux', 'git')):
        parser.error('build the native binary and install tmux and git first')
    if args.output.exists():
        parser.error('output exists; choose a new artifact path')
    if args.compare_tracing and (args.candidate or args.startup_trace or args.trace):
        parser.error('--compare-tracing cannot be combined with --candidate, --startup-trace or --trace')
    if any(w < 1 for w in args.widths) or any(w < 0 for w in args.workspaces):
        parser.error('widths must be positive and workspace counts nonnegative')
    if args.search and args.cold_switch:
        parser.error('--cold-switch starts from the main row, which --search leaves')
    if args.search and any(n < len(args.search) for n in args.workspaces):
        parser.error('--search needs one registered workspace per mode')
    if args.cold_switch and any(n < 1 for n in args.workspaces):
        parser.error('--cold-switch requires at least one registered workspace')
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
        'loadAverageStart': os.getloadavg(),
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
        'terminal': ('PTY launcher with attached real tmux' if args.outside_tmux else 'real tmux with a PTY client attached') + ', variable width x 52; the PTY answers OSC 4/10/11/12 colour queries, device attributes, XTVERSION, window size and synchronized output',
        'scope': 'isolated HOME/repo/servers; OS caches NOT flushed; dummy Python agents; bd/gh stubbed; update cache primed; no real agent startup',
        'observation': f'{args.poll_interval_ms:g} ms polling plus observer subprocess overhead; readiness files timestamped by fixtures; client attachment and visible markers sampled separately',
    }, 'settings': vars(args) | {'binary': str(args.binary), 'candidate': str(args.candidate) if args.candidate else None,
                                'output': str(args.output)}, 'samples': samples}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        result['environment']['loadAverageLatest'] = os.getloadavg()
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
            for mode in args.search:
                done = [search for s in runs for search in s['searches'] if search['mode'] == mode]
                result['summary'][name]['search' + mode.capitalize()] = {
                    'selected': len(done), 'attempts': len(runs),
                    **{metric: {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
                       for metric in ('openMs', 'filterMs', 'closeMs', 'viewersMs')
                       for values in [[search[metric] for search in done if metric in search]] if values}}
            for metric in ('letterMs', 'escapeMs'):
                values = [echo[metric] for s in runs for echo in s['agentKeys'] if metric in echo]
                if values:
                    result['summary'][name]['agentKey' + metric[0].upper() + metric[1:]] = {
                        'median': statistics.median(values), 'min': min(values), 'max': max(values),
                        'observations': len(values),
                    }
            cold_samples = [s['coldSwitch']['milestones'] for s in valid if s.get('coldSwitch')]
            if cold_samples:
                result['summary'][name]['coldSwitchMs'] = {
                    key: {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
                    for key in cold_samples[0]
                    for values in [[s[key] for s in cold_samples]]}
        args.output.write_text(json.dumps(result, indent=2) + '\n')

    cases = [(width, workspaces, mode, delay)
             for width in args.widths for workspaces in args.workspaces for mode in args.modes
             for delay in ([0, args.shell_delay_ms] if mode == 'fresh' and args.shell_delay_ms else [0])]
    for index in range(args.runs):
        for width, workspaces, mode, delay in cases:
            order = list(binaries) if index % 2 == 0 else list(reversed(binaries))
            for name in order:
                key = f'{name}/{width}x52/{workspaces}spaces/{mode}/{delay}ms-shell'
                sample = run_sample(
                    binaries[name], delay, False, args.timeout,
                    width=width, existing=mode == 'existing', workspaces=workspaces,
                    startup_trace=args.startup_trace or name == 'traceEnabled',
                    filter_cycles=args.filter_cycles, tmux_delay_ms=args.tmux_delay_ms,
                    max_filter_close_ms=args.max_filter_close_ms, outside_tmux=args.outside_tmux,
                    profile_emoji=args.profile_emoji, cold_switch=args.cold_switch,
                    status_checks=args.status_checks, skill_count=args.skill_count,
                    observe_seconds=args.observe_seconds, poll_interval_ms=args.poll_interval_ms,
                    search_modes=args.search, agent_keys=args.agent_keys)
                samples.setdefault(key, []).append(sample)
                save()
                print(key, index + 1, json.dumps(sample['milestones'] if sample['success'] else sample['error']), flush=True)
    if args.trace:
        trace = run_sample(
            binaries['baseline'], 0, True, args.timeout, width=100, existing=False, workspaces=3,
            startup_trace=args.startup_trace, filter_cycles=args.filter_cycles,
            tmux_delay_ms=args.tmux_delay_ms, max_filter_close_ms=args.max_filter_close_ms,
            outside_tmux=args.outside_tmux, profile_emoji=args.profile_emoji, cold_switch=args.cold_switch,
            status_checks=args.status_checks, skill_count=args.skill_count,
            observe_seconds=args.observe_seconds, poll_interval_ms=args.poll_interval_ms,
            search_modes=args.search, agent_keys=args.agent_keys)
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
