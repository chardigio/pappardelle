"""
Record the session id of a space's agent in its space-state file.

Pappardelle relaunches an agent by resuming this id when its agent profile's
resume_args carry {session_id}. "Most recent" resume flags aren't scoped to the
directory (codex's `resume --last` resumes whichever space ran codex last), so
the id is what keeps each space on its own conversation.

The agent session carries two variables, set by start-agent-session.sh and
buildAgentSessionEnvArgs() in source/spawn-env.ts:
    PAPPARDELLE_AGENT_PROFILE  - the agent profile the pane runs, from `agent_profiles:`
    PAPPARDELLE_SPACE_STATE    - the space-state file to write

Anything the agent spawns inherits them, including other agents: Claude
running codex for a review, or `claude -p` in a script. Those must not
overwrite the id, so a session is only recorded when its agent is the first
non-shell process under tmux.
"""

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

RECORDED_EVENTS = {"SessionStart", "UserPromptSubmit"}

SHELLS = {"sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"}

ProcessTable = dict[int, tuple[int, str]]


def read_process_table() -> ProcessTable:
    output = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,comm="],
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


def _name(comm: str) -> str:
    # Login shells show up as "-zsh"; macOS reports a full path for some.
    return os.path.basename(comm.strip()).lstrip("-")


def is_top_level_agent(pid: int, table: ProcessTable) -> bool:
    """
    Whether the process that ran this hook is the pane's own agent.

    The ancestry of a hook in the pane's agent reads, from the hook up:
    the hook and the shell running it, the agent's processes (codex is a node
    wrapper around a native binary, so there can be several), the launch
    shells, then tmux. A nested agent adds a second run of non-shell
    processes (the agent that spawned it) between those shells and tmux.
    """
    runs = 0
    in_run = False
    seen: set[int] = set()
    while pid in table and pid not in seen:
        seen.add(pid)
        ppid, comm = table[pid]
        name = _name(comm).lower()
        if name.startswith("tmux"):
            return runs == 1
        if name in SHELLS or name.startswith("python"):
            in_run = False
        elif not in_run:
            runs += 1
            in_run = True
        pid = ppid
    return False


def record_agent_session(
    payload: dict[str, Any],
    environ: Optional[dict[str, str]] = None,
    hook_pid: Optional[int] = None,
    process_table: Callable[[], ProcessTable] = read_process_table,
) -> bool:
    """Write {agentProfile, id} to the space-state file. Returns whether it wrote."""
    env = os.environ if environ is None else environ
    agent_profile = env.get("PAPPARDELLE_AGENT_PROFILE", "").strip()
    state_path = env.get("PAPPARDELLE_SPACE_STATE", "").strip()
    session_id = payload.get("session_id")
    if (
        not agent_profile
        or not state_path
        or payload.get("hook_event_name") not in RECORDED_EVENTS
        or not isinstance(session_id, str)
        or not session_id
    ):
        return False

    path = Path(state_path)
    try:
        state = json.loads(path.read_text())
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}

    recorded = {"agentProfile": agent_profile, "id": session_id}
    # UserPromptSubmit fires on every prompt; the process walk only runs when
    # the id would change.
    if state.get("agentSession") == recorded:
        return False
    if not is_top_level_agent(hook_pid or os.getpid(), process_table()):
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
