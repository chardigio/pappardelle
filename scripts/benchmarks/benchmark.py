#!/usr/bin/env python3
"""Same-machine PTY comparison; no services, agents, or network requests required.
Usage: python3 scripts/benchmarks/benchmark.py --baseline /path/to/ink-checkout --runs 7
Install dependencies and build both checkouts first. Requires Node for the baseline only.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import tempfile
import time
from pty_benchmark import command, run_pty

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', required=True, type=Path)
parser.add_argument('--runs', type=int, default=7)
parser.add_argument('--output', type=Path, default=Path('benchmark-results/opentui-benchmark.json'))
parser.add_argument('--production', action='store_true', help='Use production React for both variants')
args = parser.parse_args()
if args.production:
    os.environ['NODE_ENV'] = 'production'
current = Path(__file__).resolve().parents[2]
fixture = Path(__file__).with_name('tui-fixture.mjs')


cpu = platform.processor()
if not cpu and Path('/proc/cpuinfo').exists():
    cpu = next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), '')
variants = [('ink', args.baseline.resolve(), 'node'), ('opentui', current, 'bun')]
results = {'environment': {'platform': platform.platform(), 'cpu': cpu, 'logicalCpus': os.cpu_count(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'bun': subprocess.check_output(['bun', '--version'], text=True).strip(), 'terminal': 'PTY, 80x30, TERM=xterm-256color', 'runs': args.runs, 'order': 'alternating variants each run; warm filesystem caches', 'productionBothVariants': args.production, 'candidatePackaging': 'standalone ESM bytecode; production React'}, 'variants': {}}
scripts = []
try:
    for name, checkout, runtime in variants:
        results['variants'][name] = {'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip(), 'buildMs': [], 'checkAndBuildMs': [], 'cliVersionMs': [], 'cliFirstWorkspaceMs': [], 'tui': []}
        script = checkout / '.pappardelle-benchmark.mjs'
        if script.exists():
            raise RuntimeError(str(script) + ' already exists')
        if name == 'ink':
            shutil.copyfile(fixture, script)
        else:
            command(['bun', 'scripts/benchmarks/build-fixture.ts', 'bytecode', str(script)], checkout)
        scripts.append(script)
        command(([str(checkout / 'dist/pappardelle')] if name == 'opentui' else [runtime, 'dist/cli.js']) + ['--version'], checkout)
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
            data['cliVersionMs'].append(command(([str(checkout / 'dist/pappardelle')] if name == 'opentui' else [runtime, 'dist/cli.js']) + ['--version'], checkout))
            with tempfile.TemporaryDirectory(prefix='pappa-bench-') as tmp:
                home = Path(tmp)
                repo = home / 'repo'
                repo.mkdir()
                subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=repo, check=True)
                (repo / '.pappardelle.yml').write_text('version: 1\nissue_tracker:\n  provider: beads\nprofiles: {}\n')
                (home / '.pappardelle').mkdir()
                (home / '.pappardelle/update-check.json').write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'latestVersion': 'v0.0.0'}))
                env = {**os.environ, 'NODE_ENV': 'production' if name == 'opentui' or args.production else os.environ.get('NODE_ENV', ''), 'HOME': tmp, 'TERM': 'xterm-256color', 'NO_COLOR': '', 'BENCH_FRAMEWORK': name, 'BENCH_RESULT': str(home / 'frames.jsonl')}
                for key in ['TMUX', 'TMUX_PANE', 'PAPPARDELLE_PROJECT_ROOT', 'PAPPARDELLE_MAIN_REPO_ROOT', 'PAPPARDELLE_BENCHMARK']:
                    env.pop(key, None)
                launch, _ = run_pty(([str(checkout / 'dist/pappardelle')] if name == 'opentui' else [runtime, str(checkout / 'dist/cli.js')]) + ['--no-layout'], repo, env, stop_at=b'main')
                if launch is None:
                    raise RuntimeError('No workspace frame observed')
                data['cliFirstWorkspaceMs'].append(launch)
                _, byte_count = run_pty([str(script)] if name == 'opentui' else [runtime, str(script)], checkout, env, done=home / 'frames.jsonl')
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
