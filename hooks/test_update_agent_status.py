"""Tests for the harness-agnostic status normalizer.

The event→state table here is the Python mirror of source/agents/registry.ts.
Both are exhaustively pinned so the two can't drift: registry.test.ts asserts
the TypeScript side against the same expectations.
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOKS_DIR = Path(__file__).parent
SCRIPT = HOOKS_DIR / "update-agent-status.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("update_agent_status", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module()

AGENTS = ["claude", "codex"]

# (event, expected state) — identical for every harness.
SHARED_TABLE = [
    ("UserPromptSubmit", "working"),
    ("PreToolUse", "working"),
    ("PostToolUse", "working"),
    ("PreCompact", "working"),
    ("PostCompact", "working"),
    ("SubagentStart", "working"),
    ("PermissionRequest", "needs-approval"),
    ("Stop", "done"),
    ("SubagentStop", "done"),
    ("SessionStart", "idle"),
    ("SessionEnd", "idle"),
]


# ---------------------------------------------------------------------------
# Event → state mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("agent", AGENTS)
@pytest.mark.parametrize("event,expected", SHARED_TABLE)
def test_shared_event_table(agent, event, expected):
    assert mod.map_event_to_state(agent, event) == expected


@pytest.mark.parametrize("agent", AGENTS)
def test_question_tool_on_pretooluse_is_needs_answer(agent):
    tool = mod.AGENTS[agent]["question_tool"]
    assert mod.map_event_to_state(agent, "PreToolUse", tool) == "needs-answer"


@pytest.mark.parametrize("agent", AGENTS)
def test_other_tools_on_pretooluse_stay_working(agent):
    assert mod.map_event_to_state(agent, "PreToolUse", "Bash") == "working"


@pytest.mark.parametrize("agent", AGENTS)
def test_permission_request_for_the_question_tool_reads_as_a_question(agent):
    tool = mod.AGENTS[agent]["question_tool"]
    assert mod.map_event_to_state(agent, "PermissionRequest", tool) == "needs-answer"


@pytest.mark.parametrize("agent", AGENTS)
def test_the_other_agents_question_tool_is_not_special_cased(agent):
    other = "codex" if agent == "claude" else "claude"
    foreign = mod.AGENTS[other]["question_tool"]
    assert mod.map_event_to_state(agent, "PreToolUse", foreign) == "working"


@pytest.mark.parametrize("agent", AGENTS)
def test_unknown_events_write_nothing(agent):
    assert mod.map_event_to_state(agent, "TotallyMadeUp") is None
    assert mod.map_event_to_state(agent, "") is None


def test_claude_idle_prompt_notification_is_done():
    assert mod.map_event_to_state("claude", "Notification", None, "idle_prompt") == "done"


def test_claude_permission_prompt_notification_writes_nothing():
    # PermissionRequest already reported this moment, with a tool name attached.
    assert mod.map_event_to_state("claude", "Notification", None, "permission_prompt") is None


def test_claude_undiscriminated_notification_writes_nothing():
    assert mod.map_event_to_state("claude", "Notification") is None


def test_codex_has_no_notification_event():
    assert mod.map_event_to_state("codex", "Notification", None, "idle_prompt") is None


# ---------------------------------------------------------------------------
# Status key derivation
# ---------------------------------------------------------------------------


def test_status_key_uses_the_issue_key_from_a_worktree_path():
    assert mod.get_status_key("/Users/me/.worktrees/stardust-labs/STA-123") == "STA-123"
    assert mod.get_status_key("/Users/me/.worktrees/stardust-labs/STA-123/services/bee") == "STA-123"


def test_status_key_ignores_non_issue_hyphenated_components():
    # "stardust-labs" is hyphenated but isn't an issue key.
    key = mod.get_status_key("/Users/me/.worktrees/stardust-labs/ABC-45")
    assert key == "ABC-45"


# ---------------------------------------------------------------------------
# End-to-end: run the hook as the agent would
# ---------------------------------------------------------------------------


def run_hook(tmp_path, payload, agent="claude", extra_args=()):
    env = {**os.environ, "PAPPARDELLE_STATUS_DIR": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--agent", agent, *extra_args],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return result


def read_status(tmp_path, key):
    path = tmp_path / f"{key}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


@pytest.mark.parametrize("agent", AGENTS)
def test_hook_writes_a_normalized_file(tmp_path, agent):
    cwd = "/Users/me/.worktrees/repo/STA-500"
    result = run_hook(
        tmp_path,
        {
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "session_id": "sess-9",
            "model": "some-model",
            "cwd": cwd,
        },
        agent=agent,
    )
    assert result.returncode == 0

    status = read_status(tmp_path, "STA-500")
    assert status["schema"] == 1
    assert status["agent"] == agent
    assert status["state"] == "needs-approval"
    assert status["statusKey"] == "STA-500"
    assert status["cwd"] == cwd
    assert status["sessionId"] == "sess-9"
    assert status["decoration"]["tool"] == "Bash"
    assert status["decoration"]["model"] == "some-model"
    assert status["decoration"]["event"] == "PermissionRequest"
    assert isinstance(status["lastUpdate"], int)


@pytest.mark.parametrize("agent", AGENTS)
def test_hook_writes_needs_answer_for_the_question_tool(tmp_path, agent):
    tool = mod.AGENTS[agent]["question_tool"]
    run_hook(
        tmp_path,
        {
            "hook_event_name": "PreToolUse",
            "tool_name": tool,
            "cwd": "/Users/me/.worktrees/repo/STA-501",
        },
        agent=agent,
    )
    assert read_status(tmp_path, "STA-501")["state"] == "needs-answer"


def test_hook_does_not_write_for_an_unknown_event(tmp_path):
    run_hook(
        tmp_path,
        {"hook_event_name": "Nonsense", "cwd": "/Users/me/.worktrees/repo/STA-502"},
    )
    assert read_status(tmp_path, "STA-502") is None


def test_hook_does_not_clobber_an_existing_status_on_an_unknown_event(tmp_path):
    cwd = "/Users/me/.worktrees/repo/STA-503"
    run_hook(tmp_path, {"hook_event_name": "PermissionRequest", "cwd": cwd})
    assert read_status(tmp_path, "STA-503")["state"] == "needs-approval"

    run_hook(tmp_path, {"hook_event_name": "Nonsense", "cwd": cwd})
    assert read_status(tmp_path, "STA-503")["state"] == "needs-approval"


def test_hook_exits_zero_on_garbage_stdin(tmp_path):
    env = {**os.environ, "PAPPARDELLE_STATUS_DIR": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--agent", "claude"],
        input="not json at all",
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert result.returncode == 0


def test_hook_exits_zero_on_empty_stdin(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--agent", "claude"],
        input="",
        capture_output=True,
        text=True,
        env={**os.environ, "PAPPARDELLE_STATUS_DIR": str(tmp_path)},
        timeout=30,
    )
    assert result.returncode == 0


def test_hook_rejects_an_unknown_agent_without_hanging(tmp_path):
    # argparse exits 2 on a bad choice. The hook must not write anything.
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--agent", "cursor"],
        input="{}",
        capture_output=True,
        text=True,
        env={**os.environ, "PAPPARDELLE_STATUS_DIR": str(tmp_path)},
        timeout=30,
    )
    assert result.returncode != 0
    assert list(tmp_path.iterdir()) == []


def test_hook_leaves_no_tmp_orphans(tmp_path):
    cwd = "/Users/me/.worktrees/repo/STA-504"
    run_hook(tmp_path, {"hook_event_name": "UserPromptSubmit", "cwd": cwd})
    run_hook(tmp_path, {"hook_event_name": "Stop", "cwd": cwd})
    assert [p.name for p in tmp_path.iterdir() if ".tmp." in p.name] == []


def test_empty_decoration_fields_are_omitted(tmp_path):
    run_hook(
        tmp_path,
        {"hook_event_name": "Stop", "cwd": "/Users/me/.worktrees/repo/STA-505"},
    )
    status = read_status(tmp_path, "STA-505")
    # No tool, no model on a Stop event — only the event itself is decoration.
    assert status["decoration"] == {"event": "Stop"}


# ---------------------------------------------------------------------------
# Back-compat shim
# ---------------------------------------------------------------------------


def test_legacy_hook_name_still_writes_a_claude_status(tmp_path):
    """A settings.json that hasn't been re-installed must keep working."""
    shim = HOOKS_DIR / "update-status.py"
    result = subprocess.run(
        [sys.executable, str(shim)],
        input=json.dumps(
            {
                "hook_event_name": "Stop",
                "cwd": "/Users/me/.worktrees/repo/STA-600",
            }
        ),
        capture_output=True,
        text=True,
        env={**os.environ, "PAPPARDELLE_STATUS_DIR": str(tmp_path)},
        timeout=30,
    )
    assert result.returncode == 0

    status = read_status(tmp_path, "STA-600")
    assert status["agent"] == "claude"
    assert status["state"] == "done"
