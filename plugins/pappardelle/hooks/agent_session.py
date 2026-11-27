"""
Record the session id of a space's agent in the state database.

Pappardelle relaunches an agent by resuming this id when its agent profile's
resume_args carry {session_id}. "Most recent" resume flags aren't scoped to the
directory (codex's `resume --last` resumes whichever space ran codex last), so
the id is what keeps each space on its own conversation.

The space is the one the tmux session's PAPPARDELLE_REPO and PAPPARDELLE_SPACE
name. The main space's sessions have no PAPPARDELLE_SPACE (buildSessionEnvArgs
in source/spawn-env.ts), so a repo without a space is main. The space's record
says which agent profile its agent session was last started with and whether
it is a claude one (SpaceState.agentProfile in source/space-state.ts), and the
id is recorded under that agent profile, in the state database (state_db.py).

The companion session carries the same space variables, so the hook only
records from the first pane of the space's agent session, the session stored
for the space. An agent run
by hand in the companion, or in a pane split off the agent's own (an Agent
Teams teammate), is not the space's agent.

Anything the agent spawns runs in its pane too, including other agents: Claude
running codex for a review, or `claude -p` in a script. Those must not
overwrite the id. Each hook knows which kind of agent fired it (update-status.py
is Claude's, record-agent-session.py everyone else's), so an agent of the other
kind is rejected outright, whatever the agent profile's command is called. One
of the same kind is rejected when a shell separates it from the pane's agent: a
session is only recorded when its agent is the only run of non-shell processes
under tmux.

An agent that spawns another of its own kind without a shell between them (an
MCP server running `claude -p`) makes one run, so the run alone can't tell them
apart. Each id is recorded with the pid of the agent process that fired the
hook, and only that process may replace it while it lives. The pane's agent
records first, at SessionStart; it keeps its pid across `/clear` or a new
chat, and a relaunch ends it.

codex 0.159+ runs hooks in its shared app-server daemon. The daemon carries the
env of whichever codex started it, which may be no agent at all, and sits under
that codex's tmux pane until it exits. Neither says which conversation fired a
hook, so for a hook the daemon runs, the space is the one whose agent session
holds the payload's cwd instead. Only the daemon itself may
record this way: it also runs codex's shell commands, so `codex exec` or
`claude -p` run through one sits under the daemon with hooks of its own, and
an agent in another terminal, or the app-server the Claude codex plugin runs,
can share the worktree without being the pane's agent. Every codex
conversation sends its hooks through the same daemon, and the payload names no
client, so one run by hand in the companion pane looks just like the pane's
own. The id is recorded under the pid of the agent running in the agent
session's first pane instead, and is never replaced while that agent lives:
its first conversation keeps it until the agent exits.

agy fires PreInvocation with each conversation id under the same agy pid, so a
`/clear` updates the recorded id while that process lives (though if an agy
subagent fires PreInvocation from the same pid, its id may replace the recorded
one until the next top-level turn). Another agy process still cannot overwrite a
live owner's id.
"""

import importlib.util
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping, NamedTuple, Optional


def _load_state_db() -> Any:
    """state_db.py, loaded by path as the hook scripts load this module."""
    spec = importlib.util.spec_from_file_location("state_db", Path(__file__).parent / "state_db.py")
    if spec is None or spec.loader is None:
        raise ImportError("Could not load state_db")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state_db = _load_state_db()

RECORDED_EVENTS = {"SessionStart", "UserPromptSubmit"}

SHELLS = {"sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"}

# pid: (ppid, command line)
ProcessTable = dict[int, tuple[int, str]]

# The ancestors of a hook process, nearest first: (pid, command line).
Chain = list[tuple[int, str]]


class Space(NamedTuple):
    repo: str
    key: str


class AgentPane(NamedTuple):
    """The space whose agent session holds a directory, and the pid of that session's first pane."""

    space: Space
    pid: int


class PaneSession(NamedTuple):
    """The tmux session a pane is in, and whether it is the session's first
    pane, where the agent was launched."""

    name: str
    first: bool


def env_space(environ: Mapping[str, str]) -> Optional[Space]:
    repo = environ.get("PAPPARDELLE_REPO", "").strip()
    if not repo:
        return None
    return Space(repo, environ.get("PAPPARDELLE_SPACE", "").strip() or state_db.MAIN_KEY)


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


def pane_agent_pid(pane_pid: int, table: ProcessTable) -> Optional[int]:
    """The agent under a pane's launch shells: the first non-shell process."""
    pids = [pane_pid]
    while pids:
        pid = pids.pop(0)
        if pid in table and _name(table[pid][1]) not in SHELLS:
            return pid
        pids.extend(child for child, (ppid, _args) in table.items() if ppid == pid)
    return None


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


def tmux_socket_args(socket: str) -> list[str]:
    """tmux's flag for a socket: a path, or a name under tmux's own directory
    (statusSocketFlag in source/program-status-monitor.ts)."""
    return ["-S" if socket.startswith("/") else "-L", socket]


def tmux_agent_pane(cwd: str) -> Optional[AgentPane]:
    """The space whose agent session holds cwd, and that session's first pane,
    on the tmux server the space was created on."""
    tmux = shutil.which("tmux")
    if not tmux:
        return None
    row = state_db.space_at_path(cwd)
    if row is None:
        return None
    target = f"={row.agent_session}:"
    result = subprocess.run(
        [tmux, *tmux_socket_args(row.tmux_socket), "list-panes", "-s", "-t", target, "-F", "#{pane_pid}"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    panes = result.stdout if result.returncode == 0 else None
    if not panes or not panes.split()[0].isdigit():
        return None
    return AgentPane(Space(row.repo, row.key), int(panes.split()[0]))


def tmux_pane_session(environ: Mapping[str, str]) -> Optional[PaneSession]:
    """The tmux session the hook's pane is in, or None outside tmux."""
    pane = environ.get("TMUX_PANE", "")
    tmux = shutil.which("tmux")
    if not pane or not environ.get("TMUX") or not tmux:
        return None
    # With TMUX set, tmux talks to the server the pane belongs to.
    result = subprocess.run(
        [tmux, "list-panes", "-s", "-t", pane, "-F", "#{pane_id}\t#{session_name}"],
        capture_output=True,
        text=True,
        timeout=5,
        env=dict(environ),
    )
    first, _, session = result.stdout.partition("\n")[0].partition("\t")
    if result.returncode != 0 or not session:
        return None
    return PaneSession(session, first == pane)


def is_agy_payload(payload: Any) -> bool:
    return isinstance(payload, dict) and "conversationId" in payload


def record_agent_session(
    payload: dict[str, Any],
    is_claude_hook: bool,
    environ: Optional[Mapping[str, str]] = None,
    hook_pid: Optional[int] = None,
    process_table: Callable[[], ProcessTable] = read_process_table,
    agent_pane_for_cwd: Callable[[str], Optional[AgentPane]] = tmux_agent_pane,
    pane_session: Callable[[Mapping[str, str]], Optional[PaneSession]] = tmux_pane_session,
    started: Optional[Callable[[int], Optional[str]]] = None,
) -> bool:
    """
    Record the id and the agent's pid under the launched agent profile's name
    in the state database's agent_sessions table. is_claude_hook says whether
    Claude Code fired the hook. Returns whether it wrote.
    """
    env = os.environ if environ is None else environ
    started = started or process_start
    # agy's hooks send camelCase fields and no event name; it registers only
    # the events worth recording (the plugin's root hooks.json).
    is_agy = is_agy_payload(payload)
    if is_agy:
        session_id = payload.get("conversationId")
    else:
        session_id = payload.get("session_id")
        if payload.get("hook_event_name") not in RECORDED_EVENTS:
            return False
    if not isinstance(session_id, str) or not session_id:
        return False

    pane_space = env_space(env)
    if pane_space is None and (is_claude_hook or is_agy):
        # Only codex's daemon runs hooks away from the agent's own env, so
        # another agent outside a space's sessions isn't a pappardelle agent.
        return False
    # UserPromptSubmit fires on every prompt; the process walk only runs when
    # the entry would change. A relaunch resuming the same id still records its
    # new pid.
    if pane_space is not None:
        launched = state_db.launched_agent(*pane_space)
        entry = state_db.agent_session_entry(*pane_space, launched.profile) if launched else None
        if entry is not None and entry.session_id == session_id and owner_alive(entry, started):
            return False

    table = process_table()
    chain, in_tmux = ancestors(hook_pid or os.getpid(), table)
    hook_agent = hook_agent_pid(chain)
    daemons = {pid for pid, args in chain if _is_managed_daemon(args)}
    from_daemon = hook_agent in daemons
    space: Optional[Space]
    if from_daemon:
        cwd = payload.get("cwd")
        pane = agent_pane_for_cwd(cwd) if isinstance(cwd, str) and cwd else None
        space = pane.space if pane else None
        agent_pid = pane_agent_pid(pane.pid, table) if pane else None
    elif in_tmux and not daemons and pane_space is not None:
        if sole_agent_run(chain) is None:
            return False
        session = pane_session(env)
        if session is None or not session.first or state_db.agent_session_name(*pane_space) != session.name:
            return False
        space = pane_space
        agent_pid = hook_agent
    else:
        return False
    if space is None or agent_pid is None:
        return False

    launched = state_db.launched_agent(*space)
    if launched is None or launched.is_claude != is_claude_hook:
        return False
    agent_profile = launched.profile
    # Forks ps, so it runs before the write lock is taken.
    recording = state_db.SessionEntry(session_id, agent_pid, started(agent_pid))

    # The read, the ownership check and the write run in one write
    # transaction, so a profile rename (source/config-migration.ts) cannot
    # land between them.
    def statements(connection: Any) -> list[tuple[str, tuple[Any, ...]]]:
        entry = state_db.agent_session_row(connection, space.repo, space.key, agent_profile)
        if entry is not None and (entry.pid != agent_pid or from_daemon) and owner_alive(entry, started):
            return []
        if entry == recording:
            return []
        return [
            (
                """INSERT INTO agent_sessions (repo, key, agent_profile, session_id, pid, started)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo, key, agent_profile) DO UPDATE SET
                    session_id = excluded.session_id, pid = excluded.pid, started = excluded.started""",
                (space.repo, space.key, agent_profile, *recording),
            )
        ]

    outcome = state_db.write_rows(state_db.state_db_path(), f"the agent session of {space.key}", statements)
    return outcome is state_db.WriteOutcome.COMMITTED


def owner_alive(entry: Any, started: Callable[[int], Optional[str]]) -> bool:
    """Whether the agent that recorded the entry is still running."""
    return entry.pid is not None and entry.started is not None and started(entry.pid) == entry.started


