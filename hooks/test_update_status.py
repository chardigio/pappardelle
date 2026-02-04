#!/usr/bin/env python3
"""
Tests for update-status.py hook script.

Uses pytest to verify the status determination logic for various Claude hook events.
Run with: uv run pytest _dev/scripts/pappardelle/hooks/test_update_status.py -v
"""

# Import the module under test (has hyphen in filename, so use importlib)
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Optional
from unittest.mock import patch

import pytest

_module_path = Path(__file__).parent / "update-status.py"
_spec = importlib.util.spec_from_file_location("update_status", _module_path)
assert _spec is not None, "Failed to load update-status.py spec"
assert _spec.loader is not None, "Failed to get loader for update-status.py"
update_status_module = importlib.util.module_from_spec(_spec)
sys.modules["update_status"] = update_status_module
_spec.loader.exec_module(update_status_module)

get_workspace_name = update_status_module.get_workspace_name
update_status = update_status_module.update_status
get_status_dir = update_status_module.get_status_dir


class TestGetWorkspaceName:
    """Tests for workspace name extraction from cwd."""

    def test_extracts_linear_issue_from_worktree_path(self):
        """Should extract STA-123 from ~/.worktrees/stardust-labs/STA-123/..."""
        with patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/STA-123/hooks"):
            assert get_workspace_name() == "STA-123"

    def test_extracts_linear_issue_with_different_prefix(self):
        """Should extract ABC-45 from path with different prefix."""
        with patch("os.getcwd", return_value="/home/user/.worktrees/repo/ABC-45"):
            assert get_workspace_name() == "ABC-45"

    def test_returns_unknown_for_non_worktree_path(self):
        """Should return 'unknown' when not in a worktree path."""
        with patch("os.getcwd", return_value="/Users/charlie/projects/some-repo"):
            assert get_workspace_name() == "unknown"

    def test_returns_unknown_for_lowercase_prefix(self):
        """Should not match lowercase prefixes like sta-123."""
        with patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/sta-123"):
            assert get_workspace_name() == "unknown"


class TestStatusDetermination:
    """Tests for determining status from hook events."""

    def _create_hook_input(
        self,
        hook_event: str,
        tool_name: Optional[str] = None,
        notification_type: Optional[str] = None,
        session_id: str = "test-session",
    ) -> dict[str, Any]:
        """Helper to create hook input dict."""
        data: dict[str, Any] = {
            "hook_event_name": hook_event,
            "session_id": session_id,
        }
        if tool_name:
            data["tool_name"] = tool_name
        if notification_type:
            data["notification_type"] = notification_type
        return data

    def _run_hook_with_input(self, input_data: dict, temp_dir: Path) -> Optional[dict]:
        """Run the hook logic and return the written status file contents."""
        from io import StringIO

        import update_status as us

        # Patch stdin to provide the hook input
        stdin_mock = StringIO(json.dumps(input_data))

        # Patch status dir to use temp directory
        with (
            patch.object(sys, "stdin", stdin_mock),
            patch.object(us, "get_status_dir", return_value=temp_dir),
            patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/STA-999"),
        ):

            # Reset argv to simulate no command line args
            original_argv = sys.argv
            sys.argv = ["update-status.py"]

            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        # Read the status file
        status_file = temp_dir / "STA-999.json"
        if status_file.exists():
            return json.loads(status_file.read_text())
        return None

    # =========================================================================
    # AskUserQuestion Tests - THE MAIN BUG
    # =========================================================================

    def test_ask_user_question_sets_waiting_input(self, tmp_path):
        """BUG FIX: AskUserQuestion should set status to 'waiting_input', not 'waiting_permission'.

        This is the main bug - when Claude asks a question via AskUserQuestion,
        pappardelle should show '?' (blue, waiting_input) not '!' (red, waiting_permission).
        """
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None, "Status file should be written"
        assert (
            result["status"] == "waiting_input"
        ), "AskUserQuestion should set status to 'waiting_input' (shows '?'), not 'waiting_permission' (shows '!')"

    # =========================================================================
    # Permission Request Tests
    # =========================================================================

    def test_permission_request_event_sets_waiting_permission(self, tmp_path):
        """PermissionRequest hook event should set status to 'waiting_permission'."""
        input_data = self._create_hook_input(
            hook_event="PermissionRequest",
            tool_name="Bash",  # Regular tool, not AskUserQuestion
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_permission", "PermissionRequest for regular tools should show '!' indicator"

    def test_permission_request_for_ask_user_question_sets_waiting_input(self, tmp_path):
        """BUG FIX: PermissionRequest for AskUserQuestion should set 'waiting_input', not 'waiting_permission'.

        AskUserQuestion triggers a PermissionRequest event, but semantically it's asking for
        user input (a question), not asking for permission to run a tool. So it should show
        '?' (blue) not '!' (red).
        """
        input_data = self._create_hook_input(
            hook_event="PermissionRequest",
            tool_name="AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_input", "PermissionRequest for AskUserQuestion should show '?' not '!'"

    def test_notification_permission_prompt_does_not_update(self, tmp_path):
        """BUG FIX: Notification with permission_prompt type should NOT update status.

        We now rely on PermissionRequest events (which include tool context) instead of
        Notification events. This allows us to correctly distinguish between:
        - AskUserQuestion (should show '?')
        - Actual permission requests (should show '!')
        """
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        # Should not write a status file - we ignore permission_prompt notifications
        assert result is None, "permission_prompt notifications should be ignored (PermissionRequest handles this)"

    # =========================================================================
    # Stop Event Tests
    # =========================================================================

    def test_stop_event_sets_done(self, tmp_path):
        """Stop hook event should set status to 'done'."""
        input_data = self._create_hook_input(hook_event="Stop")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "done", "Stop event should show '✓' (done) indicator"

    # =========================================================================
    # Thinking/Tool Use Tests
    # =========================================================================

    def test_pre_tool_use_sets_tool_use(self, tmp_path):
        """PreToolUse should set status to 'tool_use'."""
        input_data = self._create_hook_input(
            hook_event="PreToolUse",
            tool_name="Bash",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "tool_use"

    def test_post_tool_use_non_ask_sets_thinking(self, tmp_path):
        """PostToolUse for non-AskUserQuestion tools should set 'thinking'."""
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="Read",  # Not AskUserQuestion
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "thinking", "PostToolUse for regular tools should set 'thinking'"

    def test_user_prompt_submit_sets_thinking(self, tmp_path):
        """UserPromptSubmit should set status to 'thinking'."""
        input_data = self._create_hook_input(hook_event="UserPromptSubmit")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "thinking"

    # =========================================================================
    # Session Lifecycle Tests
    # =========================================================================

    def test_session_start_sets_idle(self, tmp_path):
        """SessionStart should set status to 'idle'."""
        input_data = self._create_hook_input(hook_event="SessionStart")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "idle"

    def test_session_end_sets_idle(self, tmp_path):
        """SessionEnd should set status to 'idle'."""
        input_data = self._create_hook_input(hook_event="SessionEnd")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "idle"

    # =========================================================================
    # Notification Tests
    # =========================================================================

    def test_notification_idle_prompt_sets_waiting_input(self, tmp_path):
        """Notification with idle_prompt type should set waiting_input."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="idle_prompt",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_input"

    def test_notification_other_type_does_not_update(self, tmp_path):
        """Notification with unrecognized type should not update status."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="some_other_type",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        # Should not write a status file for unrecognized notification types
        assert result is None

    # =========================================================================
    # Edge Cases
    # =========================================================================

    def test_unknown_event_does_not_update(self, tmp_path):
        """Unknown hook events should not update status."""
        input_data = self._create_hook_input(hook_event="SomeUnknownEvent")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None

    def test_subagent_stop_does_not_update(self, tmp_path):
        """SubagentStop should not update parent session status."""
        input_data = self._create_hook_input(hook_event="SubagentStop")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None

    def test_pre_compact_sets_thinking(self, tmp_path):
        """PreCompact should set status to 'thinking'."""
        input_data = self._create_hook_input(hook_event="PreCompact")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "thinking"


class TestCommandLineArgs:
    """Tests for command line argument handling."""

    def test_explicit_status_arg_overrides_hook_event(self, tmp_path):
        """Command line status arg should be used directly."""
        from io import StringIO

        import update_status as us

        stdin_mock = StringIO("{}")

        with (
            patch.object(sys, "stdin", stdin_mock),
            patch.object(us, "get_status_dir", return_value=tmp_path),
            patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/STA-999"),
        ):

            original_argv = sys.argv
            sys.argv = ["update-status.py", "done"]

            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        status_file = tmp_path / "STA-999.json"
        result = json.loads(status_file.read_text())
        assert result["status"] == "done"

    def test_tool_arg_is_stored(self, tmp_path):
        """--tool argument should be stored in status file."""
        from io import StringIO

        import update_status as us

        stdin_mock = StringIO("{}")

        with (
            patch.object(sys, "stdin", stdin_mock),
            patch.object(us, "get_status_dir", return_value=tmp_path),
            patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/STA-999"),
        ):

            original_argv = sys.argv
            sys.argv = ["update-status.py", "tool_use", "--tool", "Bash"]

            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        status_file = tmp_path / "STA-999.json"
        result = json.loads(status_file.read_text())
        assert result["status"] == "tool_use"
        assert result.get("currentTool") == "Bash"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
