#!/usr/bin/env python3
"""Measure idow's local orchestration cost without touching real workspaces.

Usage: python3 integration-tests/benchmark-workspace-startup.py --baseline /path/to/base
Requires bash, yq (Mike Farah), jq, and git. Tracker, VCS, worktree creation,
terminal launchers and Claude are stubbed: timings exclude network, checkout,
user commands and agent startup. Both revisions use the same three config
layers, ten init commands (run on create) and ten open commands (run on
reopen), and run in alternating order.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import statistics
import subprocess
import tempfile
import time


def write_script(filename, body):
    filename.write_text("#!/bin/bash\nset -e\n" + body + "\n")
    filename.chmod(0o755)


class Fixture:
    def __init__(self, root, repo, yq):
        self.root = root
        home, project, bin_dir, scripts = (root / name for name in ("home", "repo", "bin", "scripts"))
        for directory in (home, project, bin_dir, scripts, home / ".pappardelle"):
            directory.mkdir(parents=True, exist_ok=True)
        for source in (repo / "scripts").iterdir():
            if source.is_file():
                shutil.copy(source, scripts / source.name)
        write_script(bin_dir / "bd", "echo '{\"id\":\"bench-123\",\"title\":\"Benchmark\",\"description\":\"\"}'")
        write_script(bin_dir / "tmux", "exit 1")
        write_script(bin_dir / "gh", "echo https://example.test/pr/1")
        write_script(bin_dir / "open", ":")
        # Both names, so a baseline from before the agent-profile rename still runs.
        for session_script in ("start-claude-session.sh", "start-agent-session.sh"):
            write_script(scripts / session_script, ":")
        write_script(scripts / "create-worktree.sh", '''mkdir -p "$HOME/.worktrees/repo/bench-123"
printf '{"worktree_path":"%s"}\\n' "$HOME/.worktrees/repo/bench-123"''')
        for launcher in (
            "open-iterm-claude.sh", "open-default-terminal-claude.sh", "open-ghostty-claude.sh",
            "open-iterm-agent.sh", "open-default-terminal-agent.sh", "open-ghostty-agent.sh",
        ):
            write_script(scripts / launcher, ":")
        write_script(bin_dir / "yq", 'echo "$1" >> "$BENCH_YQ_LOG"\nexec ' + shlex.quote(yq) + ' "$@"')
        config = {
            "version": 1, "team_prefix": "bench", "default_profile": "dev",
            "issue_tracker": {"provider": "beads"}, "terminal": {"app": "none"},
            "profiles": {"dev": {"display_name": "Dev", "commands": [
                {"name": f"Command {i}", "run": ":"} for i in range(10)
            ]}},
            "post_workspace_init": [{"name": f"Init {i}", "run": ":"} for i in range(10)],
        }
        (project / ".pappardelle.yml").write_text(json.dumps(config))
        (project / ".pappardelle.local.yml").write_text("claude:\n  model: sonnet\n")
        (home / ".pappardelle" / ".pappardelle.yml").write_text("claude:\n  effort: high\n")
        self.env = {
            **os.environ, "HOME": str(home), "PATH": f'{bin_dir}:{os.environ["PATH"]}',
            "PAPPARDELLE_PROJECT_ROOT": str(project), "PAPPARDELLE_MAIN_REPO_ROOT": str(project),
            "BENCH_YQ_LOG": str(root / "yq-calls"),
        }

    def run(self, mode):
        worktree = self.root / "home/.worktrees/repo/bench-123"
        if mode == "create":
            shutil.rmtree(worktree, ignore_errors=True)
        else:
            worktree.mkdir(parents=True, exist_ok=True)
        log = self.root / "yq-calls"
        log.write_text("")
        args = ["--resume", "--open"] if mode == "reopen" else []
        start = time.perf_counter()
        result = subprocess.run(
            ["bash", str(self.root / "scripts/idow"), *args, "--issue-key", "bench-123"],
            cwd=self.root / "repo", env=self.env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, text=True,
        )
        elapsed = (time.perf_counter() - start) * 1000
        if result.returncode != 0:
            raise SystemExit(
                f"idow {mode} failed in {self.root.name} (exit {result.returncode}):\n{result.stderr}"
            )
        calls = log.read_text().splitlines()
        return elapsed, len(calls), calls.count("eval-all")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--samples", type=int, default=7)
    args = parser.parse_args()
    yq = shutil.which("yq")
    if not yq:
        parser.error("yq must be on PATH")
    if args.samples < 1:
        parser.error("--samples must be positive")
    for name in ("baseline", "candidate"):
        if not (getattr(args, name) / "scripts" / "idow").is_file():
            parser.error(f"--{name} must be a Pappardelle checkout (no scripts/idow in {getattr(args, name)})")
    with tempfile.TemporaryDirectory(prefix="pappardelle-benchmark-") as tmp:
        fixtures = {
            name: Fixture(Path(tmp) / name, repo.resolve(), yq)
            for name, repo in (("baseline", args.baseline), ("candidate", args.candidate))
        }
        print("mode       revision    median ms    yq calls    config merges")
        for mode in ("create", "reopen"):
            samples = {name: [] for name in fixtures}
            for index in range(args.samples + 1):
                order = list(fixtures) if index % 2 else list(reversed(fixtures))
                for name in order:
                    sample = fixtures[name].run(mode)
                    if index:  # Discard each revision's warmup.
                        samples[name].append(sample)
            for name, runs in samples.items():
                elapsed, calls, merges = (statistics.median(column) for column in zip(*runs))
                print(f"{mode:<10} {name:<11} {elapsed:9.1f} {calls:11g} {merges:16g}")


if __name__ == "__main__":
    main()
