#!/usr/bin/env python3
"""Shared tracker detection for Pappardelle's Claude Code hooks."""

import os
import re
import subprocess
from typing import Optional

_MAX_PARENT_WALK = 20

_MAIN_REPO_ROOT_CACHE: dict[str, Optional[str]] = {}

_PROVIDER_RE = re.compile(r"issue_tracker:\s*\n(?:\s*#[^\n]*\n)*\s+provider:\s*(\w+)")


def find_up(filename: str, start: Optional[str] = None) -> Optional[str]:
    """Walk up from `start` (default cwd) looking for `filename`.

    The walk stops at the working tree it started in — the first ancestor
    holding a `.git` entry — so a stray `.pappardelle.yml` in a parent of the
    repo is never picked up. `findRepoConfig` in source/config.ts tests the
    working-tree root and nothing above it, and a hook that read further would
    resolve a different provider than the TUI for the same workspace.
    """
    try:
        current = start if start is not None else os.getcwd()
    except OSError:
        return None

    for _ in range(_MAX_PARENT_WALK):
        candidate = os.path.join(current, filename)
        if os.path.exists(candidate):
            return candidate
        if os.path.exists(os.path.join(current, ".git")):
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    return None


def _read(path: Optional[str]) -> str:
    if not path:
        return ""
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def find_repo_config(filename: str, start: Optional[str] = None) -> Optional[str]:
    """Locate a repo-level config file, resolving through linked worktrees.

    Working tree first, main checkout second, resolved per file. A committed
    `.pappardelle.yml` is checked out into the worktree and found there; one kept
    out of git, and `.beads/`, exist only in the main checkout.
    `.pappardelle.local.yml` is gitignored but copied into each worktree by
    workspace setup, so the worktree's copy wins. Mirrors `findRepoConfig` in
    source/config.ts.
    """
    try:
        origin = start if start is not None else os.getcwd()
    except OSError:
        return None

    found = find_up(filename, origin)
    if found:
        return found

    main_root = get_main_repo_root(origin)
    if not main_root or main_root == origin:
        return None

    return find_up(filename, main_root)


def get_tracker_provider(start: Optional[str] = None) -> str:
    """Read issue_tracker.provider from .pappardelle.yml. Defaults to "linear"."""
    match = _PROVIDER_RE.search(_read(find_repo_config(".pappardelle.yml", start)))
    return match.group(1).strip() if match else "linear"


def get_main_repo_root(start: Optional[str] = None) -> Optional[str]:
    """The main repository root, resolved through worktrees.

    Every bd invocation must run here so all worktrees share one canonical
    database. A worktree carries its own checked-out `.beads/` directory, so
    running bd from inside one makes it auto-discover that copy and write the
    comment somewhere the ticket rail never reads.

    Memoized because a hook event can ask for it twice, once to find the
    provider's config and once to run bd, and each miss would otherwise fork
    git.
    """
    key = start if start is not None else ""
    if key in _MAIN_REPO_ROOT_CACHE:
        return _MAIN_REPO_ROOT_CACHE[key]

    root = _resolve_main_repo_root(start)
    _MAIN_REPO_ROOT_CACHE[key] = root
    return root


def _resolve_main_repo_root(start: Optional[str]) -> Optional[str]:
    # Set on the workspace's tmux session when pappardelle created it, so a hook
    # running inside a worktree is told the main checkout instead of forking git
    # for it on every tool use. An explicit `start` overrides: the caller is
    # asking about some other directory, not this workspace.
    injected = os.environ.get("PAPPARDELLE_MAIN_REPO_ROOT")
    if start is None and injected:
        return injected

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=start,
        )
        if result.returncode == 0 and result.stdout.strip():
            return os.path.dirname(result.stdout.strip().rstrip("/"))
    except (OSError, subprocess.SubprocessError):
        pass

    return None
