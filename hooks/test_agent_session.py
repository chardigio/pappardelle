#!/usr/bin/env python3
"""Tests for agent_session.py: recording a space's agent session id."""

import importlib.util
import json
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


@pytest.fixture
def state_file(tmp_path: Path) -> Path:
    path = tmp_path / "space-state" / "STA-1.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"profile": "codex", "prNumber": 7}))
    return path


def env_for(state_file: Path, agent_profile: str = "codex", command: str = "") -> dict[str, str]:
    return {
        "PAPPARDELLE_AGENT_PROFILE": agent_profile,
        "PAPPARDELLE_AGENT_COMMAND": command or agent_profile,
        "PAPPARDELLE_SPACE_STATE": str(state_file),
    }


def payload(session_id: str = "01a117bd-5978", event: str = "SessionStart", cwd: str = ""):
    return {"session_id": session_id, "hook_event_name": event, "cwd": cwd}


def no_session(_cwd: str):
    raise AssertionError("looked up a session by cwd for a hook under tmux")


def test_records_the_session_and_keeps_other_fields(state_file: Path):
    assert record_agent_session(
        payload(), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX
    )
    state = json.loads(state_file.read_text())
    assert state["agentSession"] == {"agentProfile": "codex", "id": "01a117bd-5978"}
    assert state["profile"] == "codex"
    assert state["prNumber"] == 7


def test_creates_the_state_file_when_missing(tmp_path: Path):
    path = tmp_path / "space-state" / "STA-2.json"
    assert record_agent_session(
        payload(), env_for(path, "claude"), HOOK_PID, lambda: TOP_LEVEL_CLAUDE
    )
    assert json.loads(path.read_text())["agentSession"]["agentProfile"] == "claude"


def test_a_new_conversation_replaces_the_recorded_one(state_file: Path):
    record_agent_session(payload("first"), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    record_agent_session(
        payload("second", "UserPromptSubmit"), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX
    )
    assert json.loads(state_file.read_text())["agentSession"]["id"] == "second"


def test_a_nested_agent_does_not_overwrite_the_id(state_file: Path):
    record_agent_session(payload("claude-id"), env_for(state_file, "claude"), HOOK_PID, lambda: TOP_LEVEL_CLAUDE)
    assert not record_agent_session(
        payload("codex-id"), env_for(state_file, "claude"), HOOK_PID, lambda: CODEX_INSIDE_CLAUDE
    )
    assert json.loads(state_file.read_text())["agentSession"]["id"] == "claude-id"


def test_an_unchanged_id_skips_the_process_walk(state_file: Path):
    record_agent_session(payload(), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)

    def fail():
        raise AssertionError("process table read for an unchanged id")

    assert not record_agent_session(payload(event="UserPromptSubmit"), env_for(state_file), HOOK_PID, fail)


@pytest.mark.parametrize(
    "env_overrides",
    [
        {"PAPPARDELLE_AGENT_PROFILE": ""},
        {"PAPPARDELLE_AGENT_COMMAND": ""},
        {"PAPPARDELLE_SPACE_STATE": ""},
    ],
)
def test_outside_an_agent_session_nothing_is_written(state_file: Path, env_overrides):
    env = {**env_for(state_file), **env_overrides}
    assert not record_agent_session(payload(), env, HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert "agentSession" not in json.loads(state_file.read_text())


@pytest.mark.parametrize("event", ["PreToolUse", "Stop", "SessionEnd"])
def test_other_events_are_ignored(state_file: Path, event: str):
    assert not record_agent_session(payload(event=event), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)


def test_a_python_agent_records_its_session(state_file: Path):
    env = env_for(state_file, "aider", "/usr/local/bin/aider")
    assert record_agent_session(payload(), env, HOOK_PID, lambda: TOP_LEVEL_PYTHON_AGENT, no_session)
    assert json.loads(state_file.read_text())["agentSession"]["agentProfile"] == "aider"


def test_a_different_agent_run_by_hand_in_the_pane_is_not_recorded(state_file: Path):
    record_agent_session(payload("codex-id"), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert not record_agent_session(
        payload("claude-id"), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CLAUDE, no_session
    )
    assert json.loads(state_file.read_text())["agentSession"]["id"] == "codex-id"


@pytest.mark.parametrize("content", ["", '{"profile": "co', "[]"])
def test_an_unreadable_state_file_is_left_alone(state_file: Path, content: str):
    state_file.write_text(content)
    assert not record_agent_session(payload(), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX, no_session)
    assert state_file.read_text() == content


def test_the_codex_daemon_records_into_the_space_holding_its_cwd(tmp_path: Path):
    # The daemon was started from STA-1's pane, so it carries STA-1's env.
    started_from = tmp_path / "STA-1.json"
    started_from.write_text("{}")
    space = tmp_path / "STA-2.json"
    space.write_text(json.dumps({"profile": "codex"}))
    lookups: list[str] = []

    def session_for(cwd: str):
        lookups.append(cwd)
        return env_for(space, "codex", "/Users/me/.local/bin/codex")

    assert record_agent_session(
        payload(cwd="/Users/me/.worktrees/repo/STA-2"),
        env_for(started_from),
        HOOK_PID,
        lambda: CODEX_DAEMON,
        session_for,
    )
    assert lookups == ["/Users/me/.worktrees/repo/STA-2"]
    assert json.loads(space.read_text())["agentSession"] == {"agentProfile": "codex", "id": "01a117bd-5978"}
    assert json.loads(started_from.read_text()) == {}


def test_the_codex_daemon_does_not_record_into_a_claude_space(state_file: Path):
    assert not record_agent_session(
        payload(cwd="/Users/me/.worktrees/repo/STA-1"),
        {},
        HOOK_PID,
        lambda: CODEX_DAEMON,
        lambda _cwd: env_for(state_file, "claude"),
    )
    assert "agentSession" not in json.loads(state_file.read_text())


def test_a_hook_outside_tmux_and_any_space_is_not_recorded(state_file: Path):
    assert not record_agent_session(
        payload(cwd="/tmp/elsewhere"), env_for(state_file), HOOK_PID, lambda: CODEX_DAEMON, lambda _cwd: None
    )
    assert "agentSession" not in json.loads(state_file.read_text())


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
                "-e", f"PAPPARDELLE_SPACE_STATE={kind}-{key}.json",
                "-e", "PAPPARDELLE_AGENT_PROFILE=codex",
                "-e", "PAPPARDELLE_AGENT_COMMAND=codex",
            )

    assert agent_session.tmux_agent_session_env(str(tmp_path / "STA-1" / "sub")) == {
        "PAPPARDELLE_SPACE_STATE": "agent-STA-1.json",
        "PAPPARDELLE_AGENT_PROFILE": "codex",
        "PAPPARDELLE_AGENT_COMMAND": "codex",
    }
    assert agent_session.tmux_agent_session_env(str(tmp_path)) is None
