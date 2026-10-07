#!/usr/bin/env python3
"""Tests for agent_session.py: recording a space's agent session id."""

import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "agent_session", Path(__file__).parent / "agent_session.py"
)
assert _spec is not None and _spec.loader is not None
agent_session = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_session)

record_agent_session = agent_session.record_agent_session
is_top_level_agent = agent_session.is_top_level_agent

HOOK_PID = 100

# pid: (ppid, comm), from the hook process up to tmux.
TOP_LEVEL_CLAUDE = {
    100: (99, "python3"),
    99: (98, "/bin/sh"),
    98: (97, "claude"),
    97: (96, "-zsh"),
    96: (95, "/bin/sh"),
    95: (1, "tmux"),
}

# codex installed through npm: a node wrapper around the native binary.
TOP_LEVEL_CODEX = {
    100: (99, "Python"),
    99: (98, "sh"),
    98: (97, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex"),
    97: (96, "node"),
    96: (95, "zsh"),
    95: (94, "sh"),
    94: (1, "/usr/local/bin/tmux"),
}

# Claude running codex for a review: codex's hook sees Claude's env.
CODEX_INSIDE_CLAUDE = {
    100: (99, "python3"),
    99: (98, "sh"),
    98: (97, "codex"),
    97: (96, "node"),
    96: (95, "node"),
    95: (94, "zsh"),
    94: (93, "claude"),
    93: (92, "zsh"),
    92: (91, "sh"),
    91: (1, "tmux"),
}

NOT_IN_TMUX = {
    100: (99, "python3"),
    99: (98, "sh"),
    98: (97, "claude"),
    97: (1, "zsh"),
}


@pytest.mark.parametrize(
    ("table", "expected"),
    [
        (TOP_LEVEL_CLAUDE, True),
        (TOP_LEVEL_CODEX, True),
        (CODEX_INSIDE_CLAUDE, False),
        (NOT_IN_TMUX, False),
    ],
)
def test_is_top_level_agent(table, expected):
    assert is_top_level_agent(HOOK_PID, table) is expected


@pytest.fixture
def state_file(tmp_path: Path) -> Path:
    path = tmp_path / "space-state" / "STA-1.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"profile": "codex", "prNumber": 7}))
    return path


def env_for(state_file: Path, agent_profile: str = "codex") -> dict[str, str]:
    return {"PAPPARDELLE_AGENT_PROFILE": agent_profile, "PAPPARDELLE_SPACE_STATE": str(state_file)}


def payload(session_id: str = "01a117bd-5978", event: str = "SessionStart"):
    return {"session_id": session_id, "hook_event_name": event}


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
    [{"PAPPARDELLE_AGENT_PROFILE": ""}, {"PAPPARDELLE_SPACE_STATE": ""}],
)
def test_outside_an_agent_session_nothing_is_written(state_file: Path, env_overrides):
    env = {**env_for(state_file), **env_overrides}
    assert not record_agent_session(payload(), env, HOOK_PID, lambda: TOP_LEVEL_CODEX)
    assert "agentSession" not in json.loads(state_file.read_text())


@pytest.mark.parametrize("event", ["PreToolUse", "Stop", "SessionEnd"])
def test_other_events_are_ignored(state_file: Path, event: str):
    assert not record_agent_session(payload(event=event), env_for(state_file), HOOK_PID, lambda: TOP_LEVEL_CODEX)
