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

    def test_returns_unknown_when_getcwd_raises_oserror(self):
        """Should return 'unknown' when os.getcwd() raises (deleted worktree)."""
        with patch("os.getcwd", side_effect=FileNotFoundError):
            assert get_workspace_name() == "unknown"

    def test_uses_explicit_cwd_parameter(self):
        """Should use provided cwd without calling os.getcwd()."""
        with patch("os.getcwd") as mock_getcwd:
            result = get_workspace_name(cwd="/Users/x/.worktrees/repo/STA-456")
            assert result == "STA-456"
            mock_getcwd.assert_not_called()

    def test_explicit_cwd_none_falls_back_to_getcwd(self):
        """When cwd is None, should fall back to os.getcwd()."""
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/STA-789"):
            assert get_workspace_name(cwd=None) == "STA-789"

    def test_returns_unknown_for_non_worktree_path_without_git(self):
        """Should return 'unknown' when not in a worktree path and git fails."""
        with (
            patch("os.getcwd", return_value="/Users/charlie/projects/some-repo"),
            patch(
                "subprocess.run",
                return_value=type("Result", (), {"returncode": 1, "stdout": ""})(),
            ),
        ):
            assert get_workspace_name() == "unknown"

    def test_returns_unknown_for_lowercase_prefix_without_git(self):
        """Should not match lowercase prefixes like sta-123 and git fails."""
        with (
            patch("os.getcwd", return_value="/Users/charlie/.worktrees/stardust-labs/sta-123"),
            patch(
                "subprocess.run",
                return_value=type("Result", (), {"returncode": 1, "stdout": ""})(),
            ),
        ):
            assert get_workspace_name() == "unknown"

    def test_detects_main_worktree_via_git_branch(self):
        """When in main worktree (no issue key in path), should use repo-qualified name."""

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "master\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/charlie/cs/stardust-labs\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/charlie/cs/stardust-labs"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "stardust-labs-master"

    def test_detects_main_branch_named_main(self):
        """Should include repo name for 'main' branches too."""

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "main\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/charlie/cs/some-repo\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/charlie/cs/some-repo"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "some-repo-main"

    def test_detects_arbitrary_branch_name(self):
        """Should include repo name for any branch."""

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "foo\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/charlie/cs/some-repo\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/charlie/cs/some-repo"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "some-repo-foo"

    def test_returns_unknown_when_git_fails(self):
        """If git command fails, should still return 'unknown'."""
        with (
            patch("os.getcwd", return_value="/Users/charlie/cs/stardust-labs"),
            patch(
                "subprocess.run",
                return_value=type("Result", (), {"returncode": 1, "stdout": ""})(),
            ),
        ):
            assert get_workspace_name() == "unknown"

    def test_falls_back_to_branch_only_when_toplevel_fails(self):
        """If git show-toplevel fails but branch succeeds, fall back to branch only."""

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "main\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 1, "stdout": ""})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/charlie/cs/some-repo"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "main"

    def test_main_worktree_status_writes_to_repo_qualified_file(self, tmp_path):
        """When in main worktree, status file should use repo-qualified name (e.g., stardust-labs-master.json)."""
        from io import StringIO

        import update_status as us

        input_data = {
            "hook_event_name": "Stop",
            "session_id": "test-session",
            "cwd": "/Users/charlie/cs/stardust-labs",
        }
        stdin_mock = StringIO(json.dumps(input_data))

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "master\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/charlie/cs/stardust-labs\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch.object(sys, "stdin", stdin_mock),
            patch.object(us, "get_status_dir", return_value=tmp_path),
            patch("os.getcwd", return_value="/Users/charlie/cs/stardust-labs"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            original_argv = sys.argv
            sys.argv = ["update-status.py"]
            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        # Should write to stardust-labs-master.json (repo-qualified), NOT master.json
        status_file = tmp_path / "stardust-labs-master.json"
        assert status_file.exists(), "Status should be written to stardust-labs-master.json for main worktree"
        result = json.loads(status_file.read_text())
        assert result["workspaceName"] == "stardust-labs-master"
        assert result["status"] == "waiting_for_input"

        # Should NOT write to bare branch name
        bare_file = tmp_path / "master.json"
        assert not bare_file.exists(), "Should NOT write to bare master.json (would collide across repos)"

        unknown_file = tmp_path / "unknown.json"
        assert not unknown_file.exists(), "Should NOT write to unknown.json when branch is detected"


class TestStatusDetermination:
    """Tests for determining status from hook events.

    Follows Claude Island's event-forward model where every event updates state
    uniformly without tool-specific special-casing.
    """

    def _create_hook_input(
        self,
        hook_event: str,
        tool_name: Optional[str] = None,
        notification_type: Optional[str] = None,
        session_id: str = "test-session",
        cwd: str = "/Users/charlie/.worktrees/stardust-labs/STA-999",
    ) -> dict[str, Any]:
        """Helper to create hook input dict."""
        data: dict[str, Any] = {
            "hook_event_name": hook_event,
            "session_id": session_id,
            "cwd": cwd,
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
    # Processing / Tool Use Tests
    # =========================================================================

    def test_user_prompt_submit_sets_processing(self, tmp_path):
        """UserPromptSubmit should set status to 'processing'."""
        input_data = self._create_hook_input(hook_event="UserPromptSubmit")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "processing"

    def test_pre_tool_use_sets_running_tool(self, tmp_path):
        """PreToolUse should set status to 'running_tool'."""
        input_data = self._create_hook_input(
            hook_event="PreToolUse",
            tool_name="Bash",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "running_tool"

    def test_post_tool_use_sets_processing(self, tmp_path):
        """PostToolUse should set 'processing' for all tools uniformly."""
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="Read",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "processing"

    def test_post_tool_use_ask_user_question_sets_processing(self, tmp_path):
        """PostToolUse for AskUserQuestion sets 'processing' — no special-casing."""
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "processing", "No tool-specific special-casing (Claude Island model)"

    # =========================================================================
    # Permission Request Tests
    # =========================================================================

    def test_permission_request_sets_waiting_for_approval(self, tmp_path):
        """PermissionRequest should set 'waiting_for_approval' uniformly."""
        input_data = self._create_hook_input(
            hook_event="PermissionRequest",
            tool_name="Bash",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval"

    def test_permission_request_ask_user_question_sets_waiting_for_approval(self, tmp_path):
        """PermissionRequest for AskUserQuestion also sets 'waiting_for_approval' — no special-casing.

        The UI layer differentiates by checking currentTool == 'AskUserQuestion'.
        """
        input_data = self._create_hook_input(
            hook_event="PermissionRequest",
            tool_name="AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval", "No tool-specific special-casing (Claude Island model)"
        assert result.get("currentTool") == "AskUserQuestion", "Tool name must be preserved for UI differentiation"

    # =========================================================================
    # Stop / Session Lifecycle Tests
    # =========================================================================

    def test_stop_sets_waiting_for_input(self, tmp_path):
        """Stop should set 'waiting_for_input' (Claude finished turn, session still active)."""
        input_data = self._create_hook_input(hook_event="Stop")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_session_start_sets_waiting_for_input(self, tmp_path):
        """SessionStart should set 'waiting_for_input'."""
        input_data = self._create_hook_input(hook_event="SessionStart")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_session_end_sets_ended(self, tmp_path):
        """SessionEnd should set 'ended' (distinct from waiting_for_input)."""
        input_data = self._create_hook_input(hook_event="SessionEnd")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "ended"

    def test_subagent_stop_sets_waiting_for_input(self, tmp_path):
        """SubagentStop should set 'waiting_for_input' (parent back to waiting)."""
        input_data = self._create_hook_input(hook_event="SubagentStop")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    # =========================================================================
    # Compaction Tests
    # =========================================================================

    def test_pre_compact_sets_compacting(self, tmp_path):
        """PreCompact should set 'compacting' (distinct status)."""
        input_data = self._create_hook_input(hook_event="PreCompact")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "compacting"

    # =========================================================================
    # Notification Tests
    # =========================================================================

    def test_notification_idle_prompt_sets_waiting_for_input(self, tmp_path):
        """idle_prompt notification should set 'waiting_for_input'."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="idle_prompt",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_notification_permission_prompt_does_not_update(self, tmp_path):
        """permission_prompt notification should not update status (PermissionRequest handles it)."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None, "permission_prompt notifications should be ignored (PermissionRequest handles this)"

    def test_notification_other_type_does_not_update(self, tmp_path):
        """Notification with unrecognized type should not update status."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="some_other_type",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None

    # =========================================================================
    # Rich Data Tests
    # =========================================================================

    def test_status_file_includes_event(self, tmp_path):
        """Status file should include the raw hook event name."""
        input_data = self._create_hook_input(hook_event="PreToolUse", tool_name="Bash")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result.get("event") == "PreToolUse"

    def test_status_file_includes_cwd(self, tmp_path):
        """Status file should include the working directory."""
        input_data = self._create_hook_input(
            hook_event="UserPromptSubmit",
            cwd="/Users/charlie/.worktrees/stardust-labs/STA-999",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result.get("cwd") == "/Users/charlie/.worktrees/stardust-labs/STA-999"

    # =========================================================================
    # Edge Cases
    # =========================================================================

    def test_unknown_event_does_not_update(self, tmp_path):
        """Unknown hook events should not update status."""
        input_data = self._create_hook_input(hook_event="SomeUnknownEvent")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None


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
            sys.argv = ["update-status.py", "waiting_for_input"]

            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        status_file = tmp_path / "STA-999.json"
        result = json.loads(status_file.read_text())
        assert result["status"] == "waiting_for_input"

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
            sys.argv = ["update-status.py", "running_tool", "--tool", "Bash"]

            try:
                us.main()
            except SystemExit:
                pass
            finally:
                sys.argv = original_argv

        status_file = tmp_path / "STA-999.json"
        result = json.loads(status_file.read_text())
        assert result["status"] == "running_tool"
        assert result.get("currentTool") == "Bash"


class TestAtomicWrite:
    """Regression coverage for the file-race that produced
    ``Unexpected end of JSON input`` warnings in pappardelle's TUI.

    The hook used to ``open(status_file, "w")`` — which truncates in place and
    leaves a zero-byte window for any concurrent reader. The fix writes to a
    sibling ``*.tmp.<pid>`` file and ``os.replace``s it onto the target, so the
    target's directory entry always points at a complete file.
    """

    def test_rewrite_swaps_inode_via_atomic_rename(self, tmp_path):
        """Two sequential writes must land on distinct inodes.

        An in-place ``writeFileSync``/``open(..., "w")`` keeps the same inode
        (truncate + rewrite). ``os.replace`` swaps in a new inode. The inode
        check is a deterministic structural signal that the writer is atomic.
        """
        with patch.object(update_status_module, "get_status_dir", return_value=tmp_path):
            update_status("processing", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9101")
            status_file = tmp_path / "STA-9101.json"
            assert status_file.exists()
            inode_before = status_file.stat().st_ino

            update_status("running_tool", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9101")
            inode_after = status_file.stat().st_ino

        assert inode_before != inode_after, "rewrite must replace the inode (atomic rename), not truncate in place"

    def test_no_tmp_files_remain_after_successful_write(self, tmp_path):
        """After a happy-path write the temp sibling must be consumed by the rename."""
        with patch.object(update_status_module, "get_status_dir", return_value=tmp_path):
            update_status("processing", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9102")
            update_status("running_tool", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9102")

        stragglers = [p.name for p in tmp_path.iterdir() if ".tmp." in p.name]
        assert stragglers == [], f"tmp file(s) leaked: {stragglers}"

    def test_tmp_file_is_cleaned_up_when_rename_fails(self, tmp_path):
        """If ``os.replace`` raises, the sibling tmp file must be unlinked
        before the exception propagates — otherwise a crashy writer would
        leave orphan ``*.tmp.<pid>`` files in the status dir forever.
        """
        cwd = "/Users/charlie/.worktrees/stardust-labs/STA-9104"

        with (
            patch.object(update_status_module, "get_status_dir", return_value=tmp_path),
            patch.object(update_status_module.os, "replace", side_effect=OSError("simulated replace failure")),
        ):
            with pytest.raises(OSError, match="simulated replace failure"):
                update_status("processing", cwd=cwd)

        stragglers = [p.name for p in tmp_path.iterdir() if ".tmp." in p.name]
        assert stragglers == [], f"failed write must not leave .tmp.<pid> orphans behind: {stragglers}"

    def test_target_path_is_never_opened_in_write_mode(self, tmp_path):
        """Atomic write contract: ``open`` must never be called with the
        target path in write mode. Writes go to a sibling tmp path that is
        then renamed into place.
        """
        opens: list[tuple[str, str]] = []
        real_open = open

        def recording_open(file, mode="r", *args, **kwargs):
            opens.append((str(file), mode))
            return real_open(file, mode, *args, **kwargs)

        target = tmp_path / "STA-9103.json"
        with (
            patch.object(update_status_module, "get_status_dir", return_value=tmp_path),
            patch("builtins.open", side_effect=recording_open),
        ):
            update_status("processing", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9103")

        write_opens_on_target = [(p, m) for (p, m) in opens if p == str(target) and "w" in m]
        assert write_opens_on_target == [], (
            "target path must not be opened in write mode — writes go via a "
            f"sibling tmp file. Saw: {write_opens_on_target}"
        )

        # And confirm the final file ended up readable + correct.
        assert target.exists()
        payload = json.loads(target.read_text())
        assert payload["status"] == "processing"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
