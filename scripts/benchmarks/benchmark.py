#!/usr/bin/env python3
"""Same-machine PTY comparison; no services, agents, or network requests required.
Usage: python3 scripts/benchmarks/benchmark.py --baseline /path/to/ink-checkout --runs 7
Install dependencies and build both checkouts first. Requires Node for the baseline only.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import pty
import select
import shutil
import statistics
import struct
import subprocess
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', required=True, type=Path)
parser.add_argument('--runs', type=int, default=7)
parser.add_argument('--output', type=Path, default=Path('docs/opentui-benchmark.json'))
args = parser.parse_args()
current = Path(__file__).resolve().parents[2]
fixture = Path(__file__).with_name('tui-fixture.mjs')


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
    try:
        while time.perf_counter() - start < 20:
            if done and done.exists():
                events = done.read_text().splitlines()
                if events and any('"phase":"input"' in line for line in events) and time.perf_counter() >= next_key:
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


cpu = platform.processor()
if not cpu and Path('/proc/cpuinfo').exists():
    cpu = next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), '')
variants = [('ink', args.baseline.resolve(), 'node'), ('opentui', current, 'bun')]
results = {'environment': {'platform': platform.platform(), 'cpu': cpu, 'logicalCpus': os.cpu_count(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'bun': subprocess.check_output(['bun', '--version'], text=True).strip(), 'terminal': 'PTY, 80x30, TERM=xterm-256color', 'runs': args.runs, 'order': 'alternating variants each run; warm filesystem caches'}, 'variants': {}}
scripts = []
try:
    for name, checkout, runtime in variants:
        results['variants'][name] = {'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip(), 'buildMs': [], 'checkAndBuildMs': [], 'cliVersionMs': [], 'cliFirstWorkspaceMs': [], 'tui': []}
        script = checkout / '.pappardelle-benchmark.mjs'
        if script.exists():
            raise RuntimeError(str(script) + ' already exists')
        shutil.copyfile(fixture, script)
        scripts.append(script)
        command([runtime, 'dist/cli.js', '--version'], checkout)
    for _ in range(args.runs):
        for name, checkout, runtime in variants:
            data = results['variants'][name]
            script = checkout / '.pappardelle-benchmark.mjs'
            if name == 'ink':
                build = command(['node', 'node_modules/typescript/bin/tsc'], checkout)
                data['buildMs'].append(build)
                data['checkAndBuildMs'].append(build)
            else:
                build = command(['bun', 'scripts/build.ts'], checkout)
                data['buildMs'].append(build)
                check = command(['bun', 'node_modules/typescript/bin/tsc', '--noEmit'], checkout)
                data['checkAndBuildMs'].append(build + check)
            data['cliVersionMs'].append(command([runtime, 'dist/cli.js', '--version'], checkout))
            with tempfile.TemporaryDirectory(prefix='pappa-bench-') as tmp:
                home = Path(tmp)
                repo = home / 'repo'
                repo.mkdir()
                subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=repo, check=True)
                (repo / '.pappardelle.yml').write_text('version: 1\nissue_tracker:\n  provider: beads\nprofiles: {}\n')
                (home / '.pappardelle').mkdir()
                (home / '.pappardelle/update-check.json').write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'latestVersion': 'v0.0.0'}))
                env = {**os.environ, 'HOME': tmp, 'TERM': 'xterm-256color', 'NO_COLOR': '', 'BENCH_FRAMEWORK': name, 'BENCH_RESULT': str(home / 'frames.jsonl')}
                for key in ['TMUX', 'TMUX_PANE', 'PAPPARDELLE_PROJECT_ROOT', 'PAPPARDELLE_MAIN_REPO_ROOT', 'PAPPARDELLE_BENCHMARK']:
                    env.pop(key, None)
                launch, _ = run_pty([runtime, str(checkout / 'dist/cli.js'), '--no-layout'], repo, env, stop_at=b'main')
                if launch is None:
                    raise RuntimeError('No workspace frame observed')
                data['cliFirstWorkspaceMs'].append(launch)
                _, byte_count = run_pty([runtime, str(script)], checkout, env, done=home / 'frames.jsonl')
                events = [json.loads(line) for line in (home / 'frames.jsonl').read_text().splitlines()]
                summary = next(event['summary'] for event in events if 'summary' in event)
                summary['outputBytes'] = byte_count
                data['tui'].append(summary)
                print(name, len(data['tui']), 'launch ms', round(launch, 2), 'fps', round(summary['activeFrames'] / (summary['phaseCpu']['saturation']['wallMs'] / 1000), 2), flush=True)
    for name, checkout, runtime in variants:
        data = results['variants'][name]
        data['distBytes'] = sum(p.stat().st_size for p in (checkout / 'dist').rglob('*') if p.is_file())
        data['dependencyBytes'] = sum(p.stat().st_size for p in (checkout / 'node_modules').rglob('*') if p.is_file() and not p.is_symlink())
finally:
    for script in scripts:
        script.unlink()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(results, indent=2) + '\n')
for name, data in results['variants'].items():
    print(name, {key: round(statistics.median(data[key]), 2) for key in ['buildMs', 'checkAndBuildMs', 'cliVersionMs', 'cliFirstWorkspaceMs']})
