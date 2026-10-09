"""
Record the session id of a space's agent in its space-state file.

Pappardelle relaunches an agent by resuming this id when its agent profile's
resume_args carry {session_id}. "Most recent" resume flags aren't scoped to the
directory (codex's `resume --last` resumes whichever space ran codex last), so
the id is what keeps each space on its own conversation.

The agent session carries three variables, set by start-agent-session.sh and
buildAgentSessionEnvArgs() in source/spawn-env.ts:
    PAPPARDELLE_AGENT_PROFILE  - the agent profile the pane runs, from `agent_profiles:`
    PAPPARDELLE_AGENT_COMMAND  - that agent profile's command
    PAPPARDELLE_SPACE_STATE    - the space-state file to write

Anything the agent spawns inherits them, including other agents: Claude
running codex for a review, or `claude -p` in a script. Those must not
overwrite the id, so a session is only recorded when its agent is the only run
of non-shell processes under tmux, and that run is the agent profile's command.
A different agent started by hand in the pane is rejected by the same check.

codex 0.159+ runs hooks in its shared app-server daemon, which is not under
tmux and carries the env of whichever pane started it. For a hook outside tmux
the variables come from the agent session whose directory holds the payload's
cwd instead, and the command check runs against the hook's whole ancestry.
"""

import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

RECORDED_EVENTS = {"SessionStart", "UserPromptSubmit"}

SHELLS = {"sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"}

SESSION_VARIABLES = (
    "PAPPARDELLE_AGENT_PROFILE",
    "PAPPARDELLE_AGENT_COMMAND",
    "PAPPARDELLE_SPACE_STATE",
)

# pid: (ppid, command line)
ProcessTable = dict[int, tuple[int, str]]


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


def _runs_command(args: str, command: str) -> bool:
    # The second word catches interpreters: `node .../bin/codex`, `bash ~/bin/agent`.
    return command in (_basename(word) for word in args.split()[:2])


def ancestors(hook_pid: int, table: ProcessTable) -> tuple[list[str], bool]:
    """
    The command lines above the hook process, nearest first, and whether the
    walk reached tmux (the chain stops below it).
    """
    chain: list[str] = []
    seen: set[int] = set()
    pid = table[hook_pid][0] if hook_pid in table else 0
    while pid in table and pid not in seen:
        seen.add(pid)
        ppid, args = table[pid]
        if _name(args).startswith("tmux"):
            return chain, True
        chain.append(args)
        pid = ppid
    return chain, False


def sole_agent_run(chain: list[str]) -> Optional[list[str]]:
    """
    The pane's agent processes, when the chain holds exactly one run of
    non-shell processes. Under tmux it reads: the shell running the hook, the
    agent's processes (codex is a node wrapper around a native binary, so there
    can be several), then the launch shells. A nested agent adds a second run.
    """
    runs: list[list[str]] = []
    in_run = False
    for args in chain:
        if _name(args) in SHELLS:
            in_run = False
        elif in_run:
            runs[-1].append(args)
        else:
            runs.append([args])
            in_run = True
    return runs[0] if len(runs) == 1 else None


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

    output = run("show-environment", "-t", f"={matches[0][1]}")
    if output is None:
        return None
    env: dict[str, str] = {}
    for line in output.splitlines():
        key, sep, value = line.partition("=")
        if sep and key in SESSION_VARIABLES:
            env[key] = value
    return env


def record_agent_session(
    payload: dict[str, Any],
    environ: Optional[dict[str, str]] = None,
    hook_pid: Optional[int] = None,
    process_table: Callable[[], ProcessTable] = read_process_table,
    session_env_for_cwd: Callable[[str], Optional[dict[str, str]]] = tmux_agent_session_env,
) -> bool:
    """Write {agentProfile, id} to the space-state file. Returns whether it wrote."""
    env = os.environ if environ is None else environ
    session_id = payload.get("session_id")
    if (
        payload.get("hook_event_name") not in RECORDED_EVENTS
        or not isinstance(session_id, str)
        or not session_id
    ):
        return False

    # UserPromptSubmit fires on every prompt; the process walk only runs when
    # the id would change.
    env_state = read_state(env.get("PAPPARDELLE_SPACE_STATE", "").strip())
    env_profile = env.get("PAPPARDELLE_AGENT_PROFILE", "").strip()
    if env_state and env_state.get("agentSession") == {"agentProfile": env_profile, "id": session_id}:
        return False

    chain, in_tmux = ancestors(hook_pid or os.getpid(), process_table())
    if in_tmux:
        agent_processes = sole_agent_run(chain)
        session_env: Optional[Mapping[str, str]] = env
    else:
        cwd = payload.get("cwd")
        agent_processes = chain
        session_env = session_env_for_cwd(cwd) if isinstance(cwd, str) and cwd else None
    if agent_processes is None or session_env is None:
        return False

    agent_profile = session_env.get("PAPPARDELLE_AGENT_PROFILE", "").strip()
    command = session_env.get("PAPPARDELLE_AGENT_COMMAND", "").strip()
    state_path = session_env.get("PAPPARDELLE_SPACE_STATE", "").strip()
    if not agent_profile or not command or not state_path:
        return False
    command_name = _basename(command.split()[0])
    if not any(_runs_command(args, command_name) for args in agent_processes):
        return False

    path = Path(state_path)
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError:
        state = {}
    except (OSError, ValueError):
        # A half-written file; writing over it would drop the TUI's fields.
        return False
    if not isinstance(state, dict):
        return False

    recorded = {"agentProfile": agent_profile, "id": session_id}
    if state.get("agentSession") == recorded:
        return False
    state["agentSession"] = recorded
    state["updatedAt"] = (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        tmp.write_text(json.dumps(state, indent=2) + "\n")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return True


def read_state(state_path: str) -> Optional[dict[str, Any]]:
    if not state_path:
        return None
    try:
        state = json.loads(Path(state_path).read_text())
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None
