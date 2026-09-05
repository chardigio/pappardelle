#!/usr/bin/env python3
"""Shared tracker detection for Pappardelle's Claude Code hooks."""

import os
import re
import subprocess
from typing import Optional

_MAX_PARENT_WALK = 20

_MAIN_REPO_ROOT_CACHE: dict[str, Optional[str]] = {}

# Linear/Jira: uppercase alphabetic prefix, numeric suffix (STA-123).
_CLASSIC_KEY_RE = re.compile(r"^[A-Z]+-\d+$")

_PROVIDER_RE = re.compile(r"issue_tracker:\s*\n(?:\s*#[^\n]*\n)*\s+provider:\s*(\w+)")
_TEAM_PREFIX_RE = re.compile(
    r"^team_prefix:[ \t]*[\"']?([A-Za-z0-9_-]+)[\"']?[ \t]*(?:#[^\n]*)?$", re.MULTILINE
)
_BEADS_PREFIX_RE = re.compile(
    r"^issue-prefix:[ \t]*[\"']?([A-Za-z0-9_-]+)[\"']?[ \t]*(?:#[^\n]*)?$", re.MULTILINE
)

# Per-profile prefix sources, which are indented and therefore missed by the
# anchored top-level patterns above. `tracker_projects` entries name beads ID
# prefixes the same way they name Linear/Jira projects for the other trackers.
_PROFILE_TEAM_PREFIX_RE = re.compile(
    r"^[ \t]+team_prefix:[ \t]*[\"']?([A-Za-z0-9_-]+)[\"']?[ \t]*(?:#[^\n]*)?$",
    re.MULTILINE,
)
_TRACKER_PROJECTS_BLOCK_RE = re.compile(
    r"^[ \t]+tracker_projects:[ \t]*(?:#[^\n]*)?$((?:\n[ \t]*-[^\n]*)+)", re.MULTILINE
)
# The flow-sequence spelling of the same list. YAML accepts both, config.ts goes
# through a real parser and so accepts both, and a hook that understood only the
# block form left those workspaces unmatched.
_TRACKER_PROJECTS_INLINE_RE = re.compile(
    r"^[ \t]+tracker_projects:[ \t]*\[([^\]\n]*)\]", re.MULTILINE
)
_LIST_ITEM_RE = re.compile(r"^[ \t]*-[ \t]*([^\n]*)$", re.MULTILINE)
_TRAILING_COMMENT_RE = re.compile(r"(?:^|\s)#.*$")


def _scalar(raw: str) -> str:
    """A YAML scalar reduced to its value: trailing comment and quotes removed."""
    value = _TRAILING_COMMENT_RE.sub("", raw.strip()).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


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

    `.pappardelle.yml` and `.beads/` are usually excluded rather than committed,
    so only the main checkout has one; `.pappardelle.local.yml` is copied into
    each worktree, so the worktree's copy wins. Resolving per file rather than
    per directory lets both be true at once. Mirrors `findRepoConfig` in
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


def get_beads_prefix(start: Optional[str] = None) -> Optional[str]:
    """The beads ID prefix for this repo.

    Prefers an explicit `issue-prefix` in .beads/config.yaml; falls back to
    pappardelle's own `team_prefix`, which serves the same role for the other
    trackers. Returns None when neither is set, in which case callers should
    keep the strict Linear/Jira key matching rather than guess.
    """
    match = _BEADS_PREFIX_RE.search(
        _read(find_repo_config(os.path.join(".beads", "config.yaml"), start))
    )
    if match:
        return match.group(1).strip().lower()

    match = _TEAM_PREFIX_RE.search(_read(find_repo_config(".pappardelle.yml", start)))
    if match:
        return match.group(1).strip().lower()

    return None


def get_beads_prefixes(start: Optional[str] = None) -> list[str]:
    """Every beads ID prefix this repo can mint keys under.

    A database is not limited to one prefix: profiles carry their own
    `team_prefix`, and their `tracker_projects` name beads prefixes the way they
    name Linear/Jira projects for the other trackers. A workspace created under
    any of them is a real workspace, so matching only the database prefix leaves
    those hooks publishing under the fallback branch key and skipping comments.

    Mirrors `getBeadsPrefixes` in source/config.ts. Order is stable but not
    meaningful; callers test membership.
    """
    prefixes: list[str] = []

    def add(value: Optional[str]) -> None:
        if not value:
            return
        cleaned = value.strip().lower()
        if cleaned and cleaned not in prefixes:
            prefixes.append(cleaned)

    add(get_beads_prefix(start))

    config = _read(find_repo_config(".pappardelle.yml", start))
    for match in _TEAM_PREFIX_RE.finditer(config):
        add(match.group(1))
    for match in _PROFILE_TEAM_PREFIX_RE.finditer(config):
        add(match.group(1))

    for block in _TRACKER_PROJECTS_BLOCK_RE.finditer(config):
        for item in _LIST_ITEM_RE.finditer(block.group(1)):
            add(_scalar(item.group(1)))

    for inline in _TRACKER_PROJECTS_INLINE_RE.finditer(config):
        for item in inline.group(1).split(","):
            add(_scalar(item))

    return prefixes


def get_main_repo_root(start: Optional[str] = None) -> Optional[str]:
    """The main repository root, resolved through worktrees.

    Every bd invocation must run here so all worktrees share one canonical
    database. A worktree carries its own checked-out `.beads/` directory, so
    running bd from inside one makes it auto-discover that copy and write the
    comment somewhere the ticket rail never reads.

    Memoized because config lookup falls back to it several times per hook
    event — once each for the provider, the beads prefix, and the profile
    prefixes — and each miss would otherwise fork git.
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


def _looks_like_beads_key(part: str, prefix: str) -> bool:
    return bool(re.fullmatch(re.escape(prefix) + r"-[a-z0-9_]+(\.\d+){0,3}", part.lower()))


def _looks_like_classic_key(part: str) -> bool:
    return bool(_CLASSIC_KEY_RE.fullmatch(part))


def _key_candidates(cwd: str) -> list[tuple[str, str]]:
    """Every path segment that could be an issue key, as (full path, segment).

    Deepest first: the repo directory sits above the workspace directory and can
    be key-shaped itself, since a beads prefix defaults to a repo directory name
    and may be a strict prefix of it (`vendor` under
    ~/.worktrees/vendor-sdk/vendor-sdk-a1b2). Scanning root-first returned the
    repo directory and filed status and comments against a nonexistent issue.
    """
    segments = cwd.split("/")
    return [
        ("/".join(segments[: i + 1]), segments[i])
        for i in reversed(range(len(segments)))
        if "-" in segments[i]
    ]


def _find_beads_key(candidates: list[tuple[str, str]], cwd: str) -> Optional[str]:
    beads_prefixes = get_beads_prefixes(cwd)
    if not beads_prefixes:
        return None

    # Ordering only saves the key-shaped repo directory when something deeper
    # outranks it. In the main checkout nothing does, so `vendor-sdk` under a
    # `vendor` prefix matched itself and this returned a key for the one path
    # the contract says has none. The main root is never a workspace, so drop
    # it by identity rather than trying to out-rank it. get_beads_prefixes has
    # already resolved and cached this, so it costs no extra git call.
    main_root = get_main_repo_root(cwd)
    main_real = os.path.realpath(main_root) if main_root else None

    for candidate_path, part in candidates:
        if main_real and os.path.realpath(candidate_path) == main_real:
            continue
        if any(_looks_like_beads_key(part, prefix) for prefix in beads_prefixes):
            return part

    return None


def find_issue_key(cwd: Optional[str] = None) -> Optional[str]:
    """Recover the workspace's issue key from a worktree path.

    Expected shape: ~/.worktrees/<repo>/<issue-key>/...
    Returns None for the main worktree or any path with no issue in it.

    The Linear/Jira shape is checked first because it needs no file I/O, and
    update-status.py calls this on every hook event. Only when nothing matches
    does the beads path read config to learn the repo's issue prefixes.
    """
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            return None

    candidates = _key_candidates(cwd)

    for _, part in candidates:
        if _looks_like_classic_key(part):
            return part

    if not candidates or get_tracker_provider(cwd) != "beads":
        return None

    return _find_beads_key(candidates, cwd)
