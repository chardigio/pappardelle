#!/usr/bin/env python3
"""Tests for agent_session.py: recording a space's agent session id."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "agent_session", Path(__file__).parent / "agent_session.py"
)
assert _spec is not None and _spec.loader is not None
agent_session = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_session)

record_agent_session = agent_session.record_agent_session
ancestors = agent_session.ancestors
sole_agent_run = agent_session.sole_agent_run
in_split_pane = agent_session.in_split_pane

HOOK_PID = 100

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


@pytest.fixture
def sessions_file(tmp_path: Path) -> Path:
    return tmp_path / "space-state" / "STA-1.agent-sessions.json"


def env_for(sessions_file: Path, agent_profile: str = "codex", is_claude: bool = False) -> dict[str, str]:
    return {
        "PAPPARDELLE_AGENT_PROFILE": agent_profile,
        "PAPPARDELLE_AGENT_IS_CLAUDE": "true" if is_claude else "false",
        "PAPPARDELLE_AGENT_SESSIONS": str(sessions_file),
    }


def claude_env(sessions_file: Path, agent_profile: str = "claude") -> dict[str, str]:
    return env_for(sessions_file, agent_profile, is_claude=True)


def payload(session_id: str = "01a117bd-5978", event: str = "SessionStart", cwd: str = ""):
    return {"session_id": session_id, "hook_event_name": event, "cwd": cwd}


def recorded(sessions_file: Path):
    return json.loads(sessions_file.read_text()) if sessions_file.exists() else {}


def no_session(_cwd: str):
    raise AssertionError("looked up a session by cwd for a hook under tmux")


def no_process_walk():
    raise AssertionError("read the process table")


def test_records_the_session(sessions_file: Path):
    assert record_agent_session(payload(), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert recorded(sessions_file) == {"codex": "01a117bd-5978"}


def test_a_new_conversation_replaces_the_recorded_one(sessions_file: Path):
    record_agent_session(payload("first"), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    record_agent_session(
        payload("second", "UserPromptSubmit"), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX
    )
    assert recorded(sessions_file) == {"codex": "second"}


def test_a_nested_agent_does_not_overwrite_the_id(sessions_file: Path):
    record_agent_session(payload("claude-id"), True, claude_env(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CLAUDE)
    assert not record_agent_session(
        payload("codex-id"), False, claude_env(sessions_file), HOOK_PID, lambda: CODEX_INSIDE_CLAUDE
    )
    assert recorded(sessions_file) == {"claude": "claude-id"}


def test_each_agent_profile_keeps_its_own_id(sessions_file: Path):
    record_agent_session(payload("codex-id"), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    record_agent_session(
        payload("claude-id"), True, claude_env(sessions_file, "opus-high"), HOOK_PID, lambda: TOP_LEVEL_CLAUDE
    )
    assert recorded(sessions_file) == {"codex": "codex-id", "opus-high": "claude-id"}


def test_an_agent_in_a_pane_split_off_the_agents_is_not_recorded(sessions_file: Path):
    assert not record_agent_session(
        payload("teammate-id"),
        True,
        claude_env(sessions_file),
        HOOK_PID,
        lambda: TOP_LEVEL_CLAUDE,
        split_pane=lambda _env: True,
    )
    assert not sessions_file.exists()


@pytest.mark.skipif(not shutil.which("tmux"), reason="tmux not installed")
def test_only_the_sessions_first_pane_counts_as_the_agents():
    # tmux sockets must fit a short path, which pytest's tmp_path doesn't.
    socket_dir = tempfile.mkdtemp(dir="/tmp")
    socket = os.path.join(socket_dir, "s")

    def tmux(*args: str) -> str:
        return subprocess.run(
            ["tmux", "-S", socket, *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    try:
        first = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "sleep 30")
        split = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", first, "sleep 30")
        env = {"TMUX": f"{socket},1,0"}
        assert not in_split_pane({**env, "TMUX_PANE": first})
        assert in_split_pane({**env, "TMUX_PANE": split})
        assert not in_split_pane({"TMUX_PANE": split})
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True)
        shutil.rmtree(socket_dir, ignore_errors=True)


def test_a_nested_agent_without_a_shell_between_is_not_recorded(sessions_file: Path):
    assert not record_agent_session(
        payload("codex-id"), False, claude_env(sessions_file), HOOK_PID, lambda: CODEX_IN_CLAUDE_MCP
    )
    assert not sessions_file.exists()


# The agent profile's command isn't the agent's process: claude-local runs
# claude, and `env FOO=1 codex` execs codex.
@pytest.mark.parametrize(
    ("is_claude", "table"),
    [(True, CLAUDE_WRAPPER), (False, TOP_LEVEL_CODEX)],
)
def test_an_agent_launched_through_a_wrapper_records_its_session(sessions_file: Path, is_claude, table):
    env = env_for(sessions_file, "wrapped", is_claude)
    assert record_agent_session(payload(), is_claude, env, HOOK_PID, lambda: table, no_session)
    assert recorded(sessions_file) == {"wrapped": "01a117bd-5978"}


def test_an_unchanged_id_skips_the_process_walk(sessions_file: Path):
    record_agent_session(payload(), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert not record_agent_session(
        payload(event="UserPromptSubmit"), False, env_for(sessions_file), HOOK_PID, no_process_walk
    )


def test_a_claude_outside_pappardelle_skips_the_process_walk():
    assert not record_agent_session(payload(cwd="/tmp"), True, {}, HOOK_PID, no_process_walk, no_session)


@pytest.mark.parametrize(
    "env_overrides",
    [{"PAPPARDELLE_AGENT_PROFILE": ""}, {"PAPPARDELLE_AGENT_SESSIONS": ""}],
)
def test_outside_an_agent_session_nothing_is_written(sessions_file: Path, env_overrides):
    env = {**env_for(sessions_file), **env_overrides}
    assert not record_agent_session(payload(), False, env, HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert not sessions_file.exists()


@pytest.mark.parametrize("event", ["PreToolUse", "Stop", "SessionEnd"])
def test_other_events_are_ignored(sessions_file: Path, event: str):
    assert not record_agent_session(
        payload(event=event), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX
    )


def test_a_python_agent_records_its_session(sessions_file: Path):
    env = env_for(sessions_file, "aider")
    assert record_agent_session(payload(), False, env, HOOK_PID, lambda: TOP_LEVEL_PYTHON_AGENT, no_session)
    assert recorded(sessions_file) == {"aider": "01a117bd-5978"}


def test_an_agent_of_the_other_kind_run_by_hand_in_the_pane_is_not_recorded(sessions_file: Path):
    record_agent_session(payload("codex-id"), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert not record_agent_session(
        payload("claude-id"), True, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CLAUDE, no_session
    )
    assert recorded(sessions_file) == {"codex": "codex-id"}


@pytest.mark.parametrize("content", ["", '{"codex": "co', "[]"])
def test_an_unreadable_sessions_file_is_left_alone(sessions_file: Path, content: str):
    sessions_file.parent.mkdir()
    sessions_file.write_text(content)
    assert not record_agent_session(
        payload(), False, env_for(sessions_file), HOOK_PID, lambda: TOP_LEVEL_CODEX, no_session
    )
    assert sessions_file.read_text() == content


def test_the_codex_daemon_records_into_the_space_holding_its_cwd(tmp_path: Path):
    # The daemon was started from STA-1's pane, so it carries STA-1's env.
    started_from = tmp_path / "STA-1.agent-sessions.json"
    space = tmp_path / "STA-2.agent-sessions.json"
    lookups: list[str] = []

    def session_for(cwd: str):
        lookups.append(cwd)
        return env_for(space)

    assert record_agent_session(
        payload(cwd="/Users/me/.worktrees/repo/STA-2"),
        False,
        env_for(started_from),
        HOOK_PID,
        lambda: CODEX_DAEMON,
        session_for,
    )
    assert lookups == ["/Users/me/.worktrees/repo/STA-2"]
    assert recorded(space) == {"codex": "01a117bd-5978"}
    assert not started_from.exists()


def test_the_codex_daemon_does_not_record_into_a_claude_space(sessions_file: Path):
    assert not record_agent_session(
        payload(cwd="/Users/me/.worktrees/repo/STA-1"),
        False,
        {},
        HOOK_PID,
        lambda: CODEX_DAEMON,
        lambda _cwd: claude_env(sessions_file),
    )
    assert not sessions_file.exists()


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
    sessions_file: Path, is_claude_hook, table
):
    for env in (env_for(sessions_file), claude_env(sessions_file)):
        assert not record_agent_session(
            payload(cwd="/Users/me/.worktrees/repo/STA-1"),
            is_claude_hook,
            env,
            HOOK_PID,
            lambda: table,
            no_session,
        )
    assert not sessions_file.exists()


def test_a_hook_outside_tmux_and_any_space_is_not_recorded(sessions_file: Path):
    assert not record_agent_session(
        payload(cwd="/tmp/elsewhere"), False, env_for(sessions_file), HOOK_PID, lambda: CODEX_DAEMON, lambda _cwd: None
    )
    assert not sessions_file.exists()


@pytest.fixture
def tmux_server(monkeypatch: pytest.MonkeyPatch):
    if not shutil.which("tmux"):
        pytest.skip("tmux not installed")
    # A short private directory: tmux socket paths are capped near 104 bytes.
    tmpdir = tempfile.mkdtemp(prefix="pt-tmux-", dir="/tmp")
    monkeypatch.setenv("TMUX_TMPDIR", tmpdir)
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setenv("PAPPARDELLE_TMUX_SOCKET", "agent-session-test")

    def tmux(*args: str) -> None:
        subprocess.run(["tmux", "-L", "agent-session-test", *args], check=True, capture_output=True)

    yield tmux
    subprocess.run(["tmux", "-L", "agent-session-test", "kill-server"], capture_output=True)
    shutil.rmtree(tmpdir, ignore_errors=True)


def test_the_session_env_comes_from_the_agent_session_holding_the_cwd(tmp_path: Path, tmux_server):
    for key in ("STA-1", "STA-12"):
        worktree = tmp_path / key
        (worktree / "sub").mkdir(parents=True)
        for kind in ("agent", "companion"):
            tmux_server(
                "new-session", "-d", "-s", f"{kind}-repo-{key}", "-c", str(worktree),
                "-e", f"PAPPARDELLE_AGENT_SESSIONS={kind}-{key}.json",
                "-e", "PAPPARDELLE_AGENT_PROFILE=codex",
                "-e", "PAPPARDELLE_AGENT_IS_CLAUDE=false",
            )

    assert agent_session.tmux_agent_session_env(str(tmp_path / "STA-1" / "sub")) == {
        "PAPPARDELLE_AGENT_SESSIONS": "agent-STA-1.json",
        "PAPPARDELLE_AGENT_PROFILE": "codex",
        "PAPPARDELLE_AGENT_IS_CLAUDE": "false",
    }
    assert agent_session.tmux_agent_session_env(str(tmp_path)) is None
