"""
Record the session id of a space's agent in its agent-sessions file.

Pappardelle relaunches an agent by resuming this id when its agent profile's
resume_args carry {session_id}. "Most recent" resume flags aren't scoped to the
directory (codex's `resume --last` resumes whichever space ran codex last), so
the id is what keeps each space on its own conversation. The ids get a file of
their own, beside the space-state file the TUI rewrites after every rail poll,
so neither writer can drop the other's update.

The agent session carries three variables, set by start-agent-session.sh and
buildAgentSessionEnvArgs() in source/spawn-env.ts:
    PAPPARDELLE_AGENT_PROFILE   - the agent profile the pane runs, from `agent_profiles:`
    PAPPARDELLE_AGENT_IS_CLAUDE - whether that agent profile is a claude one
    PAPPARDELLE_AGENT_SESSIONS  - the agent-sessions file to write

Anything the agent spawns inherits them, including other agents: Claude
running codex for a review, or `claude -p` in a script. Those must not
overwrite the id. Each hook knows which kind of agent fired it (update-status.py
is Claude's, record-agent-session.py everyone else's), so an agent of the other
kind is rejected outright, whatever the agent profile's command is called. One
of the same kind is rejected when a shell separates it from the pane's agent: a
session is only recorded when its agent is the only run of non-shell processes
under tmux. The variables are set on the whole tmux session, so an agent in a
pane split off the agent's own (an Agent Teams teammate) is rejected too.

An agent that spawns another of its own kind without a shell between them (an
MCP server running `claude -p`) makes one run, so the run alone can't tell them
apart. Each id is recorded with the pid of the agent process that fired the
hook, and only that process may replace it while it lives. The pane's agent
records first, at SessionStart; it keeps its pid across `/clear` or a new
chat, and a relaunch ends it.

codex 0.159+ runs hooks in its shared app-server daemon, which is not under
tmux and carries the env of whichever pane started it. For a hook outside tmux
the variables come from the agent session whose directory holds the payload's
cwd instead, and only that managed daemon may record: an agent in another
terminal, or the app-server the Claude codex plugin runs, can share the
worktree without being the pane's agent.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

RECORDED_EVENTS = {"SessionStart", "UserPromptSubmit"}

SHELLS = {"sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"}

SESSION_VARIABLES = (
    "PAPPARDELLE_AGENT_PROFILE",
    "PAPPARDELLE_AGENT_IS_CLAUDE",
    "PAPPARDELLE_AGENT_SESSIONS",
)

# pid: (ppid, command line)
ProcessTable = dict[int, tuple[int, str]]

# The ancestors of a hook process, nearest first: (pid, command line).
Chain = list[tuple[int, str]]


def read_process_table() -> ProcessTable:
    output = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,args="],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    ).stdout
    table: ProcessTable = {}
    for line in output.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            table[int(parts[0])] = (int(parts[1]), parts[2])
    return table


def _basename(word: str) -> str:
    # Login shells show up as "-zsh".
    return os.path.basename(word).lstrip("-")


def _name(args: str) -> str:
    words = args.split()
    return _basename(words[0]).lower() if words else ""


def _is_managed_daemon(args: str) -> bool:
    words = args.split()
    return "app-server" in words and "--managed-daemon" in words


def ancestors(hook_pid: int, table: ProcessTable) -> tuple[Chain, bool]:
    """
    The processes above the hook process, nearest first, and whether the walk
    reached tmux (the chain stops below it).
    """
    chain: Chain = []
    seen: set[int] = set()
    pid = table[hook_pid][0] if hook_pid in table else 0
    while pid in table and pid not in seen:
        seen.add(pid)
        ppid, args = table[pid]
        if _name(args).startswith("tmux"):
            return chain, True
        chain.append((pid, args))
        pid = ppid
    return chain, False


def sole_agent_run(chain: Chain) -> Optional[list[str]]:
    """
    The pane's agent processes, when the chain holds exactly one run of
    non-shell processes. Under tmux it reads: the shell running the hook, the
    agent's processes (codex is a node wrapper around a native binary, so there
    can be several), then the launch shells. A nested agent adds a second run.
    """
    runs: list[list[str]] = []
    in_run = False
    for _pid, args in chain:
        if _name(args) in SHELLS:
            in_run = False
        elif in_run:
            runs[-1].append(args)
        else:
            runs.append([args])
            in_run = True
    return runs[0] if len(runs) == 1 else None


def hook_agent_pid(chain: Chain) -> Optional[int]:
    """The agent process that fired the hook: its nearest non-shell ancestor."""
    return next((pid for pid, args in chain if _name(args) not in SHELLS), None)


def process_start(pid: int) -> Optional[str]:
    """When the process started, or None once it has exited. Pids are reused,
    so a pid alone can't say the recording agent is still running."""
    result = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        capture_output=True,
        text=True,
        timeout=5,
        env={**os.environ, "LC_ALL": "C"},
    )
    started = result.stdout.strip()
    return started if result.returncode == 0 and started else None


def tmux_agent_session_env(cwd: str) -> Optional[dict[str, str]]:
    """The session variables of the agent session whose directory holds cwd."""
    tmux = shutil.which("tmux")
    if not tmux:
        return None
    socket = os.environ.get("PAPPARDELLE_TMUX_SOCKET") or "pappardelle_inner"

    def run(*args: str) -> Optional[str]:
        result = subprocess.run(
            [tmux, "-L", socket, *args], capture_output=True, text=True, timeout=5
        )
        return result.stdout if result.returncode == 0 else None

    sessions = run("list-sessions", "-F", "#{session_name}\t#{session_path}")
    if sessions is None:
        return None
    target = os.path.realpath(cwd)
    matches: list[tuple[int, str]] = []
    for line in sessions.splitlines():
        name, _, session_path = line.partition("\t")
        if not name.startswith("agent-") or not session_path:
            continue
        root = os.path.realpath(session_path)
        if target == root or target.startswith(root + os.sep):
            matches.append((len(root), name))
    if not matches:
        return None
    matches.sort(reverse=True)
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        return None

    output = run("show-environment", "-t", f"={matches[0][1]}:")
    if output is None:
        return None
    env: dict[str, str] = {}
    for line in output.splitlines():
        key, sep, value = line.partition("=")
        if sep and key in SESSION_VARIABLES:
            env[key] = value
    return env


def in_split_pane(environ: Mapping[str, str]) -> bool:
    """
    Whether the hook runs in a pane other than the first one of its tmux
    session, which is where the agent was launched. False when that can't be
    told.
    """
    pane = environ.get("TMUX_PANE", "")
    tmux = shutil.which("tmux")
    if not pane or not environ.get("TMUX") or not tmux:
        return False
    # With TMUX set, tmux talks to the server the pane belongs to.
    result = subprocess.run(
        [tmux, "list-panes", "-s", "-t", pane, "-F", "#{pane_id}"],
        capture_output=True,
        text=True,
        timeout=5,
        env=dict(environ),
    )
    panes = result.stdout.split()
    return result.returncode == 0 and bool(panes) and panes[0] != pane


def record_agent_session(
    payload: dict[str, Any],
    is_claude_hook: bool,
    environ: Optional[Mapping[str, str]] = None,
    hook_pid: Optional[int] = None,
    process_table: Callable[[], ProcessTable] = read_process_table,
    session_env_for_cwd: Callable[[str], Optional[dict[str, str]]] = tmux_agent_session_env,
    split_pane: Callable[[Mapping[str, str]], bool] = in_split_pane,
    started: Optional[Callable[[int], Optional[str]]] = None,
) -> bool:
    """
    Record the id and the agent's pid under the agent profile's name in the
    agent-sessions file. is_claude_hook says whether Claude Code fired the
    hook. Returns whether it wrote.
    """
    env = os.environ if environ is None else environ
    started = started or process_start
    session_id = payload.get("session_id")
    if (
        payload.get("hook_event_name") not in RECORDED_EVENTS
        or not isinstance(session_id, str)
        or not session_id
    ):
        return False

    # UserPromptSubmit fires on every prompt; the process walk only runs when
    # the entry would change. A relaunch resuming the same id still records its
    # new pid.
    env_sessions_path = env.get("PAPPARDELLE_AGENT_SESSIONS", "").strip()
    if env_sessions_path:
        env_profile = env.get("PAPPARDELLE_AGENT_PROFILE", "").strip()
        recorded = read_sessions(Path(env_sessions_path))
        entry = recorded.get(env_profile) if recorded is not None else None
        if entry_session_id(entry) == session_id and owner_alive(entry, started):
            return False
    elif is_claude_hook:
        # Only codex's daemon runs hooks away from the agent's own env, so a
        # Claude without the variables isn't a pappardelle agent.
        return False

    chain, in_tmux = ancestors(hook_pid or os.getpid(), process_table())
    session_env: Optional[Mapping[str, str]]
    if in_tmux:
        if sole_agent_run(chain) is None or split_pane(env):
            return False
        session_env = env
    else:
        cwd = payload.get("cwd")
        if not any(_is_managed_daemon(args) for _pid, args in chain):
            return False
        session_env = session_env_for_cwd(cwd) if isinstance(cwd, str) and cwd else None
    agent_pid = hook_agent_pid(chain)
    if session_env is None or agent_pid is None:
        return False

    agent_profile = session_env.get("PAPPARDELLE_AGENT_PROFILE", "").strip()
    sessions_path = session_env.get("PAPPARDELLE_AGENT_SESSIONS", "").strip()
    is_claude = session_env.get("PAPPARDELLE_AGENT_IS_CLAUDE", "").strip() == "true"
    if not agent_profile or not sessions_path or is_claude != is_claude_hook:
        return False

    path = Path(sessions_path)
    sessions = read_sessions(path)
    if sessions is None:
        # A half-written file; writing over it would drop other agent profiles' ids.
        return False
    entry = sessions.get(agent_profile)
    owner = entry.get("pid") if isinstance(entry, dict) else None
    if owner != agent_pid and owner_alive(entry, started):
        return False
    recording = {"session_id": session_id, "pid": agent_pid, "started": started(agent_pid)}
    if entry == recording:
        return False
    sessions[agent_profile] = recording
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        tmp.write_text(json.dumps(sessions, indent=2) + "\n")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return True


def entry_session_id(entry: Any) -> Optional[str]:
    session_id = entry.get("session_id") if isinstance(entry, dict) else None
    return session_id if isinstance(session_id, str) else None


def owner_alive(entry: Any, started: Callable[[int], Optional[str]]) -> bool:
    if not isinstance(entry, dict):
        return False
    pid, recorded_start = entry.get("pid"), entry.get("started")
    return isinstance(pid, int) and recorded_start is not None and started(pid) == recorded_start


def read_sessions(path: Path) -> Optional[dict[str, Any]]:
    """The recorded ids, {} for a missing file, or None for an unreadable one."""
    try:
        sessions = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    return sessions if isinstance(sessions, dict) else None
