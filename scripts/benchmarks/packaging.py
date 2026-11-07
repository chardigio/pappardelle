#!/usr/bin/env python3
"""Compare Bun packaging modes on the same source, dependencies, and PTY workload.
All modes use the application runtime/resource and monitor dispatch implementation.
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
parser.add_argument('--runs', type=int, default=5)
parser.add_argument('--output', type=Path, default=Path('docs/opentui-packaging-benchmark.json'))
args = parser.parse_args()
project = Path(__file__).resolve().parents[2]
fixture = Path(__file__).with_name('tui-fixture.mjs')
modes = ['modules-development', 'modules-production', 'bundle', 'full-bundle', 'standalone', 'bytecode']
results = {'environment': {'platform': platform.platform(), 'bun': subprocess.check_output(['bun', '--version'], text=True).strip(), 'runs': args.runs, 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=project, text=True).strip(), 'terminal': 'PTY 80x30; alternating modes; warm filesystem caches'}, 'variants': {}}
with tempfile.TemporaryDirectory(prefix='pappa-packaging-') as build_tmp:
    build_root = Path(build_tmp)
    for mode in modes:
        root = build_root / mode
        root.mkdir()
        (root / 'dist').mkdir()
        (root / 'node_modules').symlink_to(project / 'node_modules', target_is_directory=True)
        (root / 'scripts').symlink_to(project / 'scripts', target_is_directory=True)
        shutil.copyfile(project / 'package.json', root / 'package.json')
        compiled = mode in ['standalone', 'bytecode']
        if compiled:
            build = ['bun', 'scripts/benchmarks/build-standalone.ts', str(root / 'dist/pappardelle')]
            if mode == 'bytecode':
                build.append('bytecode')
        else:
            build = ['bun', 'scripts/build.ts', '--bundle-only', '--outdir=' + str(root / 'dist')]
            if mode.startswith('modules-'):
                build.append('--modules')
            elif mode == 'full-bundle':
                build.append('--full-bundle')
        data = {'buildMs': [command(build, project) for _ in range(args.runs)], 'cliVersionMs': [], 'cliFirstWorkspaceMs': [], 'tui': []}
        data['artifactBytes'] = (root / 'dist/pappardelle').stat().st_size if compiled else sum(p.stat().st_size for p in (root / 'dist').rglob('*') if p.is_file())
        if mode.startswith('modules-'):
            shutil.copyfile(fixture, root / 'fixture.mjs')
        else:
            command(['bun', 'scripts/benchmarks/build-fixture.ts', mode, str(root / ('fixture' if compiled else 'fixture.mjs'))], project)
        results['variants'][mode] = data
    # All builds finish before runtime measurements begin.
    for run in range(args.runs):
        for mode in modes:
            root = build_root / mode
            data = results['variants'][mode]
            compiled = mode in ['standalone', 'bytecode']
            cli = [str(root / 'dist/pappardelle')] if compiled else ['bun', str(root / 'dist/cli.js')]
            workload = [str(root / 'fixture')] if compiled else ['bun', str(root / 'fixture.mjs')]
            env_mode = '' if mode == 'modules-development' else 'production'
            with tempfile.TemporaryDirectory(prefix='pappa-packaging-home-') as tmp:
                home = Path(tmp)
                repo = home / 'repo'
                repo.mkdir()
                subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=repo, check=True)
                (repo / '.pappardelle.yml').write_text('version: 1\nissue_tracker:\n  provider: beads\nprofiles: {}\n')
                (home / '.pappardelle').mkdir()
                (home / '.pappardelle/update-check.json').write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'latestVersion': 'v0.0.0'}))
                env = {**os.environ, 'HOME': tmp, 'TERM': 'xterm-256color', 'NODE_ENV': env_mode, 'BENCH_FRAMEWORK': 'opentui', 'BENCH_RESULT': str(home / 'frames.jsonl')}
                for key in ['TMUX', 'TMUX_PANE', 'PAPPARDELLE_PROJECT_ROOT', 'PAPPARDELLE_MAIN_REPO_ROOT']:
                    env.pop(key, None)
                start = time.perf_counter()
                version = subprocess.run(cli + ['--version'], cwd=repo, env=env, capture_output=True, check=True)
                if not version.stdout.strip():
                    raise RuntimeError(mode + ' did not resolve its package version')
                data['cliVersionMs'].append((time.perf_counter() - start) * 1000)
                launch, _ = run_pty(cli + ['--no-layout'], repo, env, stop_at=b'main')
                if launch is None:
                    raise RuntimeError(mode + ' did not display a workspace')
                data['cliFirstWorkspaceMs'].append(launch)
                _, byte_count = run_pty(workload, repo, env, done=home / 'frames.jsonl')
                summary = next(json.loads(line)['summary'] for line in (home / 'frames.jsonl').read_text().splitlines() if '"summary"' in line)
                if len(summary['latencies']) < 15:
                    raise RuntimeError(mode + ' had too few input samples')
                summary['outputBytes'] = byte_count
                data['tui'].append(summary)
                print(mode, run + 1, 'launch ms', round(launch, 2), flush=True)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(results, indent=2) + '\n')
for mode, data in results['variants'].items():
    print(mode, {key: round(statistics.median(data[key]), 2) for key in ['buildMs', 'cliVersionMs', 'cliFirstWorkspaceMs']})
