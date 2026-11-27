#!/usr/bin/env python3
"""Tests for agent_session.py: recording a space's agent session id."""

import importlib.util
import os
import shutil
import sqlite3
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import record_space

_spec = importlib.util.spec_from_file_location(
    "agent_session", Path(__file__).parent / "agent_session.py"
)
assert _spec is not None and _spec.loader is not None
agent_session = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_session)

record_agent_session = agent_session.record_agent_session
ancestors = agent_session.ancestors
sole_agent_run = agent_session.sole_agent_run
tmux_pane_session = agent_session.tmux_pane_session
PaneSession = agent_session.PaneSession
Space = agent_session.Space
AgentPane = agent_session.AgentPane

HOOK_PID = 100
AGENT_PANE_PID = 50

# pid: (ppid, command line), from the hook process up to tmux.
TOP_LEVEL_CLAUDE = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/update-status.py"),
    99: (98, "/bin/sh -c python3 ~/.pappardelle/hooks/update-status.py"),
    98: (97, "claude --model opus"),
    97: (96, "/bin/zsh -ic claude --model opus"),
    96: (95, "/bin/sh -c \"$1\" -ic \"$2\""),
    95: (1, "/opt/homebrew/bin/tmux -L pappardelle_inner new-session"),
}

# codex installed through npm: a node wrapper around the native binary.
TOP_LEVEL_CODEX = {
    100: (99, "Python record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (97, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex --yolo"),
    97: (96, "node /opt/homebrew/bin/codex --yolo"),
    96: (95, "zsh -ic codex --yolo"),
    95: (94, "sh -c"),
    94: (1, "/usr/local/bin/tmux"),
}

# Claude running codex for a review: codex's hook sees Claude's env.
CODEX_INSIDE_CLAUDE = {
    100: (99, "python3 record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (97, "codex exec review"),
    97: (96, "node /opt/homebrew/bin/codex exec review"),
    96: (95, "node mcp-server.js"),
    95: (94, "zsh -c codex exec review"),
    94: (93, "claude"),
    93: (92, "zsh -ic claude"),
    92: (91, "sh -c"),
    91: (1, "tmux"),
}

# An MCP server Claude started runs codex with no shell in between, so the
# two agents form one run.
CODEX_IN_CLAUDE_MCP = {
    100: (99, "python3 record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (97, "codex mcp-server"),
    97: (96, "node /opt/homebrew/bin/codex mcp-server"),
    96: (95, "node mcp-bridge.js"),
    95: (94, "claude"),
    94: (93, "zsh -ic claude"),
    93: (92, "sh -c"),
    92: (1, "tmux"),
}

# An MCP server the pane's claude started runs `claude -p` with no shell in
# between, so the two claudes form one run.
CLAUDE_IN_CLAUDE_MCP = {
    **TOP_LEVEL_CLAUDE,
    99: (90, "/bin/sh -c python3 ~/.pappardelle/hooks/update-status.py"),
    90: (91, "claude -p summarize"),
    91: (98, "node mcp-server.js"),
}

# The space's codex after a relaunch: a new process for the same pane.
RELAUNCHED_CODEX = {
    100: (99, "Python record-agent-session.py"),
    99: (88, "sh -c python3 record-agent-session.py"),
    88: (87, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex --yolo"),
    87: (86, "node /opt/homebrew/bin/codex --yolo"),
    86: (85, "zsh -ic codex --yolo"),
    85: (84, "sh -c"),
    84: (1, "/usr/local/bin/tmux"),
}

# A Python agent that runs its hooks without a shell in between.
TOP_LEVEL_PYTHON_AGENT = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    99: (98, "python3 /usr/local/bin/aider"),
    98: (97, "-zsh"),
    97: (1, "tmux"),
}

# codex 0.159+ runs hooks in its shared app-server daemon, outside tmux.
CODEX_DAEMON = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (1, "/Users/me/.codex/packages/app-server-daemon/bin/codex app-server --managed-daemon"),
}

# The space's agent pane, as the daemon's hook finds it by cwd.
AGENT_PANE = {
    50: (49, "/bin/sh -c \"$1\" -ic \"$2\"; exec \"$1\" -l"),
    51: (50, "zsh -ic codex --yolo"),
    52: (51, "node /opt/homebrew/bin/codex --yolo"),
    53: (52, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex --yolo"),
    49: (1, "/usr/local/bin/tmux"),
}

# The agent quit, and codex was started again by hand in the pane's login shell.
AGENT_PANE_RESTARTED = {
    50: (49, "-zsh"),
    54: (50, "node /opt/homebrew/bin/codex"),
    49: (1, "/usr/local/bin/tmux"),
}


@pytest.mark.parametrize(
    ("table", "in_tmux", "run"),
    [
        (TOP_LEVEL_CLAUDE, True, ["claude --model opus"]),
        (
            TOP_LEVEL_CODEX,
            True,
            [
                "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex --yolo",
                "node /opt/homebrew/bin/codex --yolo",
            ],
        ),
        (CODEX_INSIDE_CLAUDE, True, None),
        (TOP_LEVEL_PYTHON_AGENT, True, ["python3 /usr/local/bin/aider"]),
        (CODEX_DAEMON, False, None),
    ],
)
def test_the_agent_run_under_tmux(table, in_tmux, run):
    chain, reached_tmux = ancestors(HOOK_PID, table)
    assert reached_tmux is in_tmux
    assert (sole_agent_run(chain) if reached_tmux else None) == run


# A claude-local wrapper script that runs claude without exec.
CLAUDE_WRAPPER = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/update-status.py"),
    99: (98, "/bin/sh -c python3 ~/.pappardelle/hooks/update-status.py"),
    98: (97, "claude --settings /Users/me/.claude-local.json"),
    97: (96, "bash /Users/me/bin/claude-local"),
    96: (95, "/bin/zsh -ic claude-local"),
    95: (1, "/opt/homebrew/bin/tmux -L pappardelle_inner new-session"),
}


# agy runs its hook commands without a shell in between (seen on agy 1.5.0).
TOP_LEVEL_AGY = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    99: (98, "agy --model gemini-4-argon-medium -i /idow STA-1"),
    98: (97, "zsh -ic agy --model gemini-4-argon-medium -i '/idow STA-1'"),
    97: (96, "/bin/sh -c \"$1\" -ic \"$2\""),
    96: (1, "/opt/homebrew/bin/tmux -L pappardelle_inner new-session"),
}

# The space's agy after a relaunch.
RELAUNCHED_AGY = {
    100: (89, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    89: (88, "agy --model gemini-4-argon-medium --conversation first"),
    88: (87, "zsh -ic agy --model gemini-4-argon-medium --conversation first"),
    87: (86, "/bin/sh -c \"$1\" -ic \"$2\""),
    86: (1, "/opt/homebrew/bin/tmux -L pappardelle_inner new-session"),
}

# codex running agy through its shell tool, in an agy profile's pane.
AGY_INSIDE_CODEX = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    99: (98, "agy -p review"),
    98: (97, "/bin/bash -c agy -p review"),
    97: (96, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex"),
    96: (95, "zsh -ic codex"),
    95: (1, "/usr/local/bin/tmux"),
}


STARTED = "Mon Oct 26 09:00:00 2026"


@pytest.fixture(autouse=True)
def every_process_alive(monkeypatch):
    monkeypatch.setattr(agent_session, "process_start", lambda _pid: STARTED)


@pytest.fixture(autouse=True)
def _db(state_db: Path) -> None:
    """Every recording reads and writes the state database."""


def agent_session_name(key: str) -> str:
    return f"agent-repo-{key}"


def launch(key: str = "STA-1", agent_profile: str = "codex", is_claude: bool = False) -> None:
    """Store what Pappardelle stores when it starts the space's agent session:
    the space's identity and the agent profile it started."""
    connection = sqlite3.connect(os.environ["PAPPARDELLE_STATE_DB"])
    try:
        connection.execute(
            """INSERT OR IGNORE INTO space_identities
            (repo, key, worktree_path, tmux_socket, agent_session, companion_session)
            VALUES ('repo', ?, ?, 'pappardelle_inner', ?, ?)""",
            (key, f"/w/{key}", agent_session_name(key), f"companion-repo-{key}"),
        )
        connection.execute(
            """INSERT INTO space_state (repo, key, agent_profile, agent_is_claude)
            VALUES ('repo', ?, ?, ?)
            ON CONFLICT (repo, key) DO UPDATE SET agent_profile = excluded.agent_profile,
                agent_is_claude = excluded.agent_is_claude""",
            (key, agent_profile, int(is_claude)),
        )
        connection.commit()
    finally:
        connection.close()


def env_for(key: str = "STA-1") -> dict[str, str]:
    """The space variables of a space's sessions. Main's name no space."""
    return {"PAPPARDELLE_REPO": "repo", **({} if key == "main" else {"PAPPARDELLE_SPACE": key})}


def in_agent_pane(environ) -> PaneSession:
    return PaneSession(agent_session_name(environ.get("PAPPARDELLE_SPACE") or "main"), True)


def record(payload, is_claude: bool, env, table, pane_for_cwd=None, session=None, **kwargs) -> bool:
    """The hook, run from the pane `session` names: by default the first pane
    of the agent session of the space `env` names."""
    return record_agent_session(
        payload,
        is_claude,
        env,
        HOOK_PID,
        table,
        pane_for_cwd or no_session,
        pane_session=(lambda _env: session) if session else in_agent_pane,
        **kwargs,
    )


def payload(session_id: str = "01a117bd-5978", event: str = "SessionStart", cwd: str = ""):
    return {"session_id": session_id, "hook_event_name": event, "cwd": cwd}


def session_rows(sql: str = "SELECT repo, key, agent_profile, session_id, pid, started FROM agent_sessions ORDER BY rowid"):
    connection = sqlite3.connect(os.environ["PAPPARDELLE_STATE_DB"])
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def entries(key: str = "STA-1"):
    """The sessions recorded for a space, by agent profile."""
    return {
        profile: {"session_id": session_id, "pid": pid, "started": started}
        for repo, row_key, profile, session_id, pid, started in session_rows()
        if (repo, row_key) == ("repo", key)
    }


def recorded(key: str = "STA-1"):
    return {profile: entry["session_id"] for profile, entry in entries(key).items()}


def no_session(_cwd: str):
    raise AssertionError("looked up a session by cwd for a hook under tmux")


def no_process_walk():
    raise AssertionError("read the process table")


def test_records_the_session_under_the_agent_profile_the_space_launched():
    launch(agent_profile="codex-high")
    assert record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert recorded() == {"codex-high": "01a117bd-5978"}


def test_the_main_space_records_into_main():
    launch("main")
    assert record(payload(), False, env_for("main"), lambda: TOP_LEVEL_CODEX)
    assert recorded("main") == {"codex": "01a117bd-5978"}


def test_a_space_with_no_launched_agent_profile_records_nothing():
    assert not record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert entries() == {}


def test_a_new_conversation_replaces_the_recorded_one():
    launch()
    record(payload("first"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    record(payload("second", "UserPromptSubmit"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert recorded() == {"codex": "second"}


def test_a_nested_agent_does_not_overwrite_the_id():
    launch(agent_profile="claude", is_claude=True)
    record(payload("claude-id"), True, env_for(), lambda: TOP_LEVEL_CLAUDE)
    assert not record(payload("codex-id"), False, env_for(), lambda: CODEX_INSIDE_CLAUDE)
    assert recorded() == {"claude": "claude-id"}


def test_each_agent_profile_keeps_its_own_id():
    launch()
    record(payload("codex-id"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    launch(agent_profile="opus-high", is_claude=True)
    record(payload("claude-id"), True, env_for(), lambda: TOP_LEVEL_CLAUDE)
    assert recorded() == {"codex": "codex-id", "opus-high": "claude-id"}


@pytest.mark.parametrize(
    "session",
    [
        # An Agent Teams teammate in a pane split off the agent's own.
        PaneSession(agent_session_name("STA-1"), False),
        # An agent run by hand in the companion, which carries the same space.
        PaneSession("companion-repo-STA-1", True),
    ],
)
def test_an_agent_outside_the_agent_sessions_first_pane_is_not_recorded(session):
    launch()
    assert not record(payload("other-id"), False, env_for(), lambda: TOP_LEVEL_CODEX, session=session)
    assert entries() == {}


def test_an_agent_outside_tmux_panes_is_not_recorded():
    launch()
    assert not record_agent_session(
        payload(), False, env_for(), HOOK_PID, lambda: TOP_LEVEL_CODEX, no_session, lambda _env: None
    )
    assert entries() == {}


def test_only_the_stored_agent_session_is_the_spaces():
    # Another space's agent session carrying this space's variables.
    launch()
    launch("STA-2")
    assert not record(
        payload(), False, env_for(), lambda: TOP_LEVEL_CODEX, session=PaneSession(agent_session_name("STA-2"), True)
    )
    assert entries() == {}


def guarded_tmux_tmpdir() -> str:
    """The test tmux guard's private TMUX_TMPDIR. It keeps a test's servers off
    the user's, and the run fails when one is left running there."""
    if not os.environ.get("PAPPARDELLE_TEST_TMUX_REFUSALS"):
        pytest.fail(
            "this test starts tmux: run through test/helpers/tmux-guard-run.sh"
            " (test/helpers/tmux-guard-run.sh pytest plugins/pappardelle/hooks/ -v)"
        )
    return os.environ["TMUX_TMPDIR"]


@pytest.mark.skipif(not shutil.which("tmux"), reason="tmux not installed")
def test_the_hooks_pane_is_found_in_its_session():
    socket = os.path.join(guarded_tmux_tmpdir(), f"hooks-pane-{uuid.uuid4().hex[:8]}")

    def tmux(*args: str) -> str:
        return subprocess.run(
            ["tmux", "-S", socket, *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    try:
        first = tmux("new-session", "-d", "-s", "agent-repo-STA-1", "-P", "-F", "#{pane_id}", "sleep 30")
        split = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", first, "sleep 30")
        env = {"TMUX": f"{socket},1,0"}
        assert tmux_pane_session({**env, "TMUX_PANE": first}) == PaneSession("agent-repo-STA-1", True)
        assert tmux_pane_session({**env, "TMUX_PANE": split}) == PaneSession("agent-repo-STA-1", False)
        assert tmux_pane_session({"TMUX_PANE": split}) is None
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True)


def test_the_agent_process_is_recorded_with_its_id():
    launch()
    record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert entries() == {"codex": {"session_id": "01a117bd-5978", "pid": 98, "started": STARTED}}


def test_an_agent_of_the_same_kind_spawned_without_a_shell_does_not_overwrite_the_id():
    launch(agent_profile="claude", is_claude=True)
    record(payload("pane-id"), True, env_for(), lambda: TOP_LEVEL_CLAUDE)
    assert not record(payload("nested-id"), True, env_for(), lambda: CLAUDE_IN_CLAUDE_MCP)
    assert recorded() == {"claude": "pane-id"}


def test_a_relaunched_agent_takes_over_once_the_old_one_has_exited():
    launch()
    record(payload("first"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert not record(payload("second"), False, env_for(), lambda: RELAUNCHED_CODEX)
    assert record(
        payload("second"),
        False,
        env_for(),
        lambda: RELAUNCHED_CODEX,
        started=lambda pid: None if pid == 98 else STARTED,
    )
    assert entries() == {"codex": {"session_id": "second", "pid": 88, "started": STARTED}}


def test_resuming_the_recorded_id_after_a_relaunch_takes_it_over():
    launch()
    record(payload("same"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert record(
        payload("same"),
        False,
        env_for(),
        lambda: RELAUNCHED_CODEX,
        started=lambda pid: None if pid == 98 else STARTED,
    )
    assert entries() == {"codex": {"session_id": "same", "pid": 88, "started": STARTED}}


def test_a_reused_pid_does_not_keep_the_lock():
    launch()
    record(payload("first"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert record(
        payload("second"),
        False,
        env_for(),
        lambda: RELAUNCHED_CODEX,
        started=lambda pid: "Tue Oct 27 10:00:00 2026" if pid == 98 else STARTED,
    )
    assert entries() == {"codex": {"session_id": "second", "pid": 88, "started": STARTED}}


def test_an_entry_without_a_start_time_has_no_owner():
    launch()
    connection = sqlite3.connect(os.environ["PAPPARDELLE_STATE_DB"])
    connection.execute("INSERT INTO agent_sessions VALUES ('repo', 'STA-1', 'codex', 'first', 98, NULL)")
    connection.commit()
    connection.close()
    assert record(payload("second"), False, env_for(), lambda: RELAUNCHED_CODEX)
    assert recorded() == {"codex": "second"}


def test_a_nested_agent_without_a_shell_between_is_not_recorded():
    launch(agent_profile="claude", is_claude=True)
    assert not record(payload("codex-id"), False, env_for(), lambda: CODEX_IN_CLAUDE_MCP)
    assert entries() == {}


# The agent profile's command isn't the agent's process: claude-local runs
# claude, and `env FOO=1 codex` execs codex.
@pytest.mark.parametrize(
    ("is_claude", "table"),
    [(True, CLAUDE_WRAPPER), (False, TOP_LEVEL_CODEX)],
)
def test_an_agent_launched_through_a_wrapper_records_its_session(is_claude, table):
    launch(agent_profile="wrapped", is_claude=is_claude)
    assert record(payload(), is_claude, env_for(), lambda: table)
    assert recorded() == {"wrapped": "01a117bd-5978"}


def test_an_unchanged_id_skips_the_process_walk():
    launch()
    record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert not record(payload(event="UserPromptSubmit"), False, env_for(), no_process_walk)


def test_a_claude_outside_pappardelle_skips_the_process_walk():
    assert not record(payload(cwd="/tmp"), True, {}, no_process_walk)


def test_a_codex_under_tmux_outside_a_spaces_sessions_is_not_recorded():
    launch()
    assert not record(payload(), False, {}, lambda: TOP_LEVEL_CODEX)
    assert entries() == {}


@pytest.mark.parametrize("event", ["PreToolUse", "Stop", "SessionEnd"])
def test_other_events_are_ignored(event: str):
    launch()
    assert not record(payload(event=event), False, env_for(), no_process_walk)


def test_a_python_agent_records_its_session():
    launch(agent_profile="aider")
    assert record(payload(), False, env_for(), lambda: TOP_LEVEL_PYTHON_AGENT)
    assert recorded() == {"aider": "01a117bd-5978"}


def test_an_agent_of_the_other_kind_run_by_hand_in_the_pane_is_not_recorded():
    launch()
    record(payload("codex-id"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert not record(payload("claude-id"), True, env_for(), lambda: TOP_LEVEL_CLAUDE)
    assert recorded() == {"codex": "codex-id"}


def pane_of(key: str):
    return lambda _cwd: AgentPane(Space("repo", key), AGENT_PANE_PID)


def test_the_codex_daemon_records_into_the_space_holding_its_cwd():
    # The daemon was started from STA-1's pane, so it carries STA-1's env.
    launch("STA-1")
    launch("STA-2")
    lookups: list[str] = []

    def pane_for(cwd: str):
        lookups.append(cwd)
        return AgentPane(Space("repo", "STA-2"), AGENT_PANE_PID)

    assert record(
        payload(cwd="/Users/me/.worktrees/repo/STA-2"),
        False,
        env_for("STA-1"),
        lambda: {**CODEX_DAEMON, **AGENT_PANE},
        pane_for,
    )
    assert lookups == ["/Users/me/.worktrees/repo/STA-2"]
    assert entries("STA-2") == {"codex": {"session_id": "01a117bd-5978", "pid": 52, "started": STARTED}}
    assert entries("STA-1") == {}


def test_the_codex_daemon_keeps_the_first_id_while_the_pane_agent_lives():
    # codex run by hand in the companion pane shares the daemon and the cwd.
    launch()

    def run(session_id: str, pane, started):
        return record(
            payload(session_id, cwd="/Users/me/.worktrees/repo/STA-1"),
            False,
            {},
            lambda: {**CODEX_DAEMON, **pane},
            pane_of("STA-1"),
            started=started,
        )

    assert run("pane-convo", AGENT_PANE, lambda _pid: STARTED)
    assert not run("companion-convo", AGENT_PANE, lambda _pid: STARTED)
    assert recorded() == {"codex": "pane-convo"}

    assert run("restarted-convo", AGENT_PANE_RESTARTED, lambda pid: None if pid == 52 else STARTED)
    assert entries() == {"codex": {"session_id": "restarted-convo", "pid": 54, "started": STARTED}}


def test_the_codex_daemon_records_nothing_while_the_pane_runs_no_agent():
    launch()
    assert not record(
        payload(cwd="/Users/me/.worktrees/repo/STA-1"),
        False,
        {},
        lambda: {**CODEX_DAEMON, 50: (49, "-zsh"), 49: (1, "tmux")},
        pane_of("STA-1"),
    )
    assert entries() == {}


def test_the_codex_daemon_does_not_record_into_a_claude_space():
    launch(agent_profile="claude", is_claude=True)
    assert not record(
        payload(cwd="/Users/me/.worktrees/repo/STA-1"),
        False,
        {},
        lambda: {**CODEX_DAEMON, **AGENT_PANE},
        pane_of("STA-1"),
    )
    assert entries() == {}


# The daemon runs codex's shell commands, so an agent the pane's codex runs
# through its shell tool sits under the daemon with its own hooks.
CODEX_EXEC_UNDER_DAEMON = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (97, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex exec review"),
    97: (96, "node /opt/homebrew/bin/codex exec review"),
    96: (95, "/bin/bash -c codex exec review"),
    95: (1, "/Users/me/.codex/packages/app-server-daemon/bin/codex app-server --managed-daemon"),
}

CLAUDE_UNDER_DAEMON = {
    100: (99, "python3 /Users/me/.pappardelle/hooks/update-status.py"),
    99: (98, "/bin/sh -c python3 ~/.pappardelle/hooks/update-status.py"),
    98: (96, "claude -p summarize"),
    96: (95, "/bin/bash -c claude -p summarize"),
    95: (1, "/Users/me/.codex/packages/app-server-daemon/bin/codex app-server --managed-daemon"),
}


@pytest.mark.parametrize(
    ("is_claude", "table"), [(False, CODEX_EXEC_UNDER_DAEMON), (True, CLAUDE_UNDER_DAEMON)]
)
def test_an_agent_run_by_the_daemons_shell_tool_is_not_recorded(is_claude, table):
    launch(agent_profile="claude" if is_claude else "codex", is_claude=is_claude)
    assert not record(
        payload(cwd="/Users/me/.worktrees/repo/STA-1"),
        is_claude,
        env_for(),
        lambda: {**table, **AGENT_PANE},
        pane_of("STA-1"),
    )
    assert entries() == {}


# As seen on Linux with codex 0.169: the hook runs straight under the daemon,
# which a pid-update-loop restarts on auto-update.
CODEX_DAEMON_UNDER_UPDATER = {
    100: (98, "python3 /home/me/.pappardelle/hooks/record-agent-session.py"),
    98: (97, "/home/me/.codex/packages/app-server-daemon/releases/0.169.1/bin/codex app-server --listen unix:// --managed-daemon"),
    97: (1, "/home/me/.codex/packages/app-server-daemon/releases/0.169.1/bin/codex app-server daemon pid-update-loop"),
}

# Until the codex that started the daemon exits, the daemon is its child, under
# that codex's tmux pane, with that pane's env.
CODEX_DAEMON_UNDER_ITS_STARTER = {
    **CODEX_DAEMON_UNDER_UPDATER,
    97: (60, "/home/me/.codex/packages/app-server-daemon/releases/0.169.1/bin/codex app-server daemon pid-update-loop"),
    60: (59, "/home/me/.local/share/mise/installs/codex/latest/bin/codex --yolo"),
    59: (58, "zsh -ic codex --yolo"),
    58: (1, "/usr/bin/tmux -L pappardelle_inner new-session"),
}


@pytest.mark.parametrize("daemon", [CODEX_DAEMON_UNDER_UPDATER, CODEX_DAEMON_UNDER_ITS_STARTER])
def test_the_codex_daemon_records_into_the_space_holding_the_cwd_not_its_starters(daemon):
    launch("STA-1")
    launch("STA-2")
    assert record(
        payload(cwd="/home/me/.worktrees/repo/STA-2"),
        False,
        env_for("STA-1"),
        lambda: {**daemon, **AGENT_PANE},
        pane_of("STA-2"),
    )
    assert entries("STA-2")["codex"]["pid"] == 52
    assert entries("STA-1") == {}


@pytest.mark.parametrize(
    "spawned",
    [
        # codex runs some shell-tool commands straight from argv.
        {100: (99, "python3 record-agent-session.py"), 99: (98, "codex exec review")},
        {
            100: (99, "python3 record-agent-session.py"),
            99: (90, "codex exec review"),
            90: (98, "/bin/bash -c codex exec review"),
        },
    ],
)
def test_an_agent_the_daemon_runs_under_its_starters_pane_is_not_recorded(spawned):
    launch()
    assert not record(
        payload(cwd="/home/me/.worktrees/repo/STA-1"),
        False,
        env_for(),
        lambda: {**CODEX_DAEMON_UNDER_ITS_STARTER, **spawned},
    )
    assert entries() == {}


@pytest.mark.parametrize(
    ("is_claude_hook", "table"),
    [
        # claude in a second terminal, cd'd into the space's worktree.
        (
            True,
            {
                100: (99, "python3 /Users/me/.pappardelle/hooks/update-status.py"),
                99: (98, "claude"),
                98: (97, "-zsh"),
                97: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"),
            },
        ),
        # The Claude codex plugin's own app-server, not the managed daemon.
        (
            False,
            {
                100: (99, "python3 /Users/me/.pappardelle/hooks/record-agent-session.py"),
                99: (98, "codex app-server"),
                98: (1, "node /Users/me/.claude/plugins/codex/scripts/app-server-broker.mjs serve"),
            },
        ),
    ],
)
def test_an_agent_outside_tmux_other_than_the_codex_daemon_is_not_recorded(
    is_claude_hook, table
):
    launch(agent_profile="agent", is_claude=is_claude_hook)
    assert not record(payload(cwd="/Users/me/.worktrees/repo/STA-1"), is_claude_hook, env_for(), lambda: table)
    assert entries() == {}


def test_a_hook_outside_tmux_and_any_space_is_not_recorded():
    launch()
    assert not record(payload(cwd="/tmp/elsewhere"), False, env_for(), lambda: CODEX_DAEMON, lambda _cwd: None)
    assert entries() == {}


@pytest.fixture(params=["-L", "-S"])
def tmux_server(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    """A tmux server on a socket stored either way a space can store it: a name
    under TMUX_TMPDIR, or a path. Yields the tmux flag and the stored socket."""
    if not shutil.which("tmux"):
        pytest.skip("tmux not installed")
    tmpdir = guarded_tmux_tmpdir()
    # A server of its own per test: kill-server returns before the server has
    # exited, and the next test's tmux could reach the one shutting down.
    name = f"agent-session-test-{uuid.uuid4().hex[:8]}"
    flag = request.param
    socket = os.path.join(tmpdir, name) if flag == "-S" else name
    # The space's stored socket decides, whatever the hook's environment says.
    monkeypatch.setenv("PAPPARDELLE_TMUX_SOCKET", "elsewhere")

    yield flag, socket
    subprocess.run(["tmux", flag, socket, "kill-server"], capture_output=True)


def test_the_space_comes_from_the_stored_space_holding_the_cwd(
    tmp_path: Path, tmux_server: tuple[str, str], state_db: Path
):
    flag, socket = tmux_server
    worktree = tmp_path / "STA-1"
    (worktree / "sub").mkdir(parents=True)
    subprocess.run(
        ["tmux", flag, socket, "new-session", "-d", "-s", "hand-named-agent", "-c", str(tmp_path)],
        check=True,
        capture_output=True,
    )
    record_space(state_db, "repo", "STA-1", str(worktree), "hand-named-agent", socket)
    pane = agent_session.tmux_agent_pane(str(worktree / "sub"))
    assert pane is not None
    assert pane.space == Space("repo", "STA-1")
    shell = subprocess.run(["ps", "-o", "args=", "-p", str(pane.pid)], capture_output=True, text=True).stdout
    assert shell.strip()
    assert agent_session.tmux_agent_pane(str(tmp_path)) is None


def agy_payload(conversation_id: str):
    return {"conversationId": conversation_id, "workspacePaths": ["/w"], "lastUserInput": "hi"}


def test_agy_records_its_conversation():
    launch(agent_profile="argon")
    assert record(agy_payload("first"), False, env_for(), lambda: TOP_LEVEL_AGY)
    assert entries()["argon"]["session_id"] == "first"
    assert entries()["argon"]["pid"] == 99


def test_agy_updates_conversation_after_clear_for_same_live_pid():
    launch(agent_profile="argon")
    assert record(agy_payload("first"), False, env_for(), lambda: TOP_LEVEL_AGY)
    assert record(agy_payload("second"), False, env_for(), lambda: TOP_LEVEL_AGY)
    assert recorded() == {"argon": "second"}
    assert not record(agy_payload("second"), False, env_for(), no_process_walk)


def test_another_live_agy_cannot_overwrite_the_conversation():
    launch(agent_profile="argon")
    assert record(agy_payload("first"), False, env_for(), lambda: TOP_LEVEL_AGY)
    assert not record(
        agy_payload("second"),
        False,
        env_for(),
        lambda: RELAUNCHED_AGY,
        started=lambda _pid: STARTED,
    )
    assert entries()["argon"] == {"session_id": "first", "pid": 99, "started": STARTED}


def test_agy_outside_pappardelle_skips_the_process_walk():
    # agy's hooks are global, so they also fire for agy run outside a space.
    assert not record(agy_payload("first"), False, {}, no_process_walk)


def test_a_relaunched_agy_records_again():
    launch(agent_profile="argon")
    record(agy_payload("first"), False, env_for(), lambda: TOP_LEVEL_AGY)
    assert record(
        agy_payload("second"),
        False,
        env_for(),
        lambda: RELAUNCHED_AGY,
        started=lambda pid: STARTED if pid == 89 else None,
    )
    assert entries()["argon"] == {"session_id": "second", "pid": 89, "started": STARTED}


def test_an_agy_run_by_another_agent_is_not_recorded():
    launch(agent_profile="argon")
    assert not record(agy_payload("nested"), False, env_for(), lambda: AGY_INSIDE_CODEX)
    assert entries() == {}


def test_an_agy_payload_without_a_conversation_id_is_ignored():
    launch(agent_profile="argon")
    assert not record(agy_payload(""), False, env_for(), no_process_walk)


@pytest.mark.parametrize("key", ["STA-1", "main"])
def test_the_session_row_is_named_by_the_spaces_repo_and_key(key: str):
    launch(key)
    assert record(payload(), False, env_for(key), lambda: TOP_LEVEL_CODEX)
    assert session_rows() == [("repo", key, "codex", "01a117bd-5978", 98, STARTED)]


def test_recording_one_agent_profile_leaves_the_other_rows_in_place(state_db: Path):
    launch()
    connection = sqlite3.connect(state_db)
    connection.execute("INSERT INTO agent_sessions VALUES ('repo', 'STA-1', 'opus', 'claude-id', 7, NULL)")
    connection.execute("INSERT INTO agent_sessions VALUES ('repo', 'STA-2', 'codex', 'other-space', 1, NULL)")
    connection.commit()
    connection.close()

    assert record(payload("codex-id"), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert session_rows() == [
        ("repo", "STA-1", "opus", "claude-id", 7, None),
        ("repo", "STA-2", "codex", "other-space", 1, None),
        ("repo", "STA-1", "codex", "codex-id", 98, STARTED),
    ]


def test_a_session_the_hook_does_not_record_changes_no_rows_and_rings_no_bell(state_db: Path):
    launch(agent_profile="claude", is_claude=True)
    record(payload("pane"), True, env_for(), lambda: TOP_LEVEL_CLAUDE)
    bell = Path(f"{state_db}.bell")
    bell.unlink()
    # A nested claude is not the pane's agent, which is alive and owns the id.
    assert not record(payload("nested"), True, env_for(), lambda: CLAUDE_IN_CLAUDE_MCP)
    assert session_rows() == [("repo", "STA-1", "claude", "pane", 98, STARTED)]
    assert not bell.exists()


def test_a_locked_database_records_nothing_and_logs_it(state_db: Path):
    launch()
    holder = sqlite3.connect(state_db, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    try:
        assert not record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    finally:
        holder.execute("ROLLBACK")
        holder.close()

    assert session_rows() == []
    log = (Path.home() / ".pappardelle" / "logs" / "hook-events.log").read_text()
    assert "State database write failed for the agent session of STA-1" in log


def test_without_a_database_nothing_is_recorded_or_created_and_the_failure_is_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    missing = tmp_path / "missing" / "state.db"
    monkeypatch.setenv("PAPPARDELLE_STATE_DB", str(missing))
    assert not record(payload(), False, env_for(), lambda: TOP_LEVEL_CODEX)
    assert not missing.parent.exists()
    log = (Path.home() / ".pappardelle" / "logs" / "hook-events.log").read_text()
    assert "State database read failed" in log
