#!/usr/bin/env python3
"""
Tests for zap-notification.py hook script.

Run with: uv run pytest _dev/scripts/pappardelle/hooks/test_zap_notification.py -v
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_module_path = Path(__file__).parent / "zap-notification.py"
_spec = importlib.util.spec_from_file_location("zap_notification", _module_path)
assert _spec is not None
assert _spec.loader is not None
zap_mod = importlib.util.module_from_spec(_spec)
sys.modules["zap_notification"] = zap_mod
_spec.loader.exec_module(zap_mod)

is_tailscale_ssh_active = zap_mod.is_tailscale_ssh_active
send_zap = zap_mod.send_zap


W_OUTPUT_WITH_TAILSCALE = """\
 4:24  up 16 days, 16:05, 16 users, load averages: 12.55 13.88 10.70
USER       TTY      FROM            LOGIN@  IDLE WHAT
charlie    console  -              14Feb26 17days -
charlie    s000     100.104.115.1  Sun15       1 pappardelle
charlie    s001     100.104.115.1  16Feb26     - tmux
"""

W_OUTPUT_WITHOUT_TAILSCALE = """\
 4:24  up 16 days, 16:05, 2 users, load averages: 12.55 13.88 10.70
USER       TTY      FROM            LOGIN@  IDLE WHAT
charlie    console  -              14Feb26 17days -
charlie    s130     -              Thu12       - -zsh
"""

W_OUTPUT_TAILSCALE_ALL_IDLE_DAYS = """\
 4:24  up 16 days, 16:05, 2 users, load averages: 12.55 13.88 10.70
USER       TTY      FROM            LOGIN@  IDLE WHAT
charlie    console  -              14Feb26 17days -
charlie    s011     100.104.115.1  22Feb26 5days -
"""


class TestIsTailscaleSshActive:
    def test_detects_tailscale_session(self):
        mock_result = MagicMock(returncode=0, stdout=W_OUTPUT_WITH_TAILSCALE)
        with patch("subprocess.run", return_value=mock_result):
            assert is_tailscale_ssh_active() is True

    def test_no_tailscale_session(self):
        mock_result = MagicMock(returncode=0, stdout=W_OUTPUT_WITHOUT_TAILSCALE)
        with patch("subprocess.run", return_value=mock_result):
            assert is_tailscale_ssh_active() is False

    def test_tailscale_all_idle_days(self):
        mock_result = MagicMock(returncode=0, stdout=W_OUTPUT_TAILSCALE_ALL_IDLE_DAYS)
        with patch("subprocess.run", return_value=mock_result):
            assert is_tailscale_ssh_active() is False

    def test_w_command_fails(self):
        mock_result = MagicMock(returncode=1, stdout="")
        with patch("subprocess.run", return_value=mock_result):
            assert is_tailscale_ssh_active() is False

    def test_subprocess_exception(self):
        with patch("subprocess.run", side_effect=OSError("command not found")):
            assert is_tailscale_ssh_active() is False


class TestSendZap:
    def test_calls_curl_with_correct_args(self):
        with patch.object(zap_mod, "PAPPARDELLE_NTFY_TOPIC", "test-topic"), patch("subprocess.run") as mock_run:
            send_zap("test message")
            mock_run.assert_called_once()
            args = mock_run.call_args[0][0]
            assert "curl" in args
            assert "test message" in args
            assert "ntfy.sh/test-topic" in args
            assert "Click: termius://terminal" in args

    def test_swallows_exceptions(self):
        with patch("subprocess.run", side_effect=OSError("fail")):
            # Should not raise
            send_zap("test")


class TestMainLogic:
    """Test the main() dispatch logic by simulating stdin and env."""

    def _run_main(
        self,
        input_data: dict,
        agent: str = "claude",
        ntfy_topic: str | None = "test-topic",
        tailscale_active: bool = True,
    ) -> MagicMock:
        """Helper to run main() with mocked stdin, env, and tailscale detection."""
        import io
        import json

        stdin_mock = io.StringIO(json.dumps(input_data))
        with (
            patch.object(zap_mod, "PAPPARDELLE_NTFY_TOPIC", ntfy_topic),
            patch.object(zap_mod, "is_tailscale_ssh_active", return_value=tailscale_active),
            patch.object(zap_mod, "send_zap") as mock_zap,
            patch("sys.stdin", stdin_mock),
            patch("sys.argv", ["zap-notification.py", "--agent", agent]),
        ):
            try:
                zap_mod.main()
            except SystemExit:
                pass
            return mock_zap

    # -- needs-approval ----------------------------------------------------

    @pytest.mark.parametrize("agent,name", [("claude", "Claude"), ("codex", "Codex")])
    def test_permission_request_sends_zap(self, agent, name):
        mock_zap = self._run_main({"hook_event_name": "PermissionRequest", "tool_name": "Bash"}, agent=agent)
        mock_zap.assert_called_once_with(f"{name} needs permission for Bash")

    @pytest.mark.parametrize("agent,name", [("claude", "Claude"), ("codex", "Codex")])
    def test_permission_request_without_tool_name(self, agent, name):
        mock_zap = self._run_main({"hook_event_name": "PermissionRequest"}, agent=agent)
        mock_zap.assert_called_once_with(f"{name} needs permission")

    # -- needs-answer ------------------------------------------------------

    @pytest.mark.parametrize("agent,name", [("claude", "Claude"), ("codex", "Codex")])
    def test_pre_tool_use_question_tool_sends_zap(self, agent, name):
        tool = zap_mod.AGENTS[agent]["question_tool"]
        mock_zap = self._run_main({"hook_event_name": "PreToolUse", "tool_name": tool}, agent=agent)
        mock_zap.assert_called_once_with(f"{name} is asking a question")

    @pytest.mark.parametrize("agent", ["claude", "codex"])
    def test_permission_request_for_question_tool_is_deduped(self, agent):
        """PreToolUse owns the question zap; PermissionRequest must stay silent
        so one question doesn't buzz the phone twice."""
        tool = zap_mod.AGENTS[agent]["question_tool"]
        mock_zap = self._run_main({"hook_event_name": "PermissionRequest", "tool_name": tool}, agent=agent)
        mock_zap.assert_not_called()

    @pytest.mark.parametrize("agent", ["claude", "codex"])
    def test_the_other_agents_question_tool_does_not_trigger(self, agent):
        other = "codex" if agent == "claude" else "claude"
        foreign = zap_mod.AGENTS[other]["question_tool"]
        mock_zap = self._run_main({"hook_event_name": "PreToolUse", "tool_name": foreign}, agent=agent)
        mock_zap.assert_not_called()

    # -- silence -----------------------------------------------------------

    @pytest.mark.parametrize("agent", ["claude", "codex"])
    @pytest.mark.parametrize(
        "event",
        [
            "UserPromptSubmit",
            "PostToolUse",
            "PreCompact",
            "PostCompact",
            "Stop",
            "SubagentStop",
            "SessionStart",
            "SessionEnd",
            "Nonsense",
        ],
    )
    def test_non_blocked_states_are_silent(self, agent, event):
        mock_zap = self._run_main({"hook_event_name": event}, agent=agent)
        mock_zap.assert_not_called()

    def test_pre_tool_use_other_tool_no_zap(self):
        mock_zap = self._run_main({"hook_event_name": "PreToolUse", "tool_name": "Bash"})
        mock_zap.assert_not_called()

    def test_no_zap_when_no_ntfy_topic(self):
        mock_zap = self._run_main(
            {"hook_event_name": "PermissionRequest", "tool_name": "Bash"},
            ntfy_topic=None,
        )
        mock_zap.assert_not_called()

    def test_no_zap_when_no_tailscale(self):
        mock_zap = self._run_main(
            {"hook_event_name": "PermissionRequest", "tool_name": "Bash"},
            tailscale_active=False,
        )
        mock_zap.assert_not_called()
