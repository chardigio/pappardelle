#!/usr/bin/env python3
"""
Tests for update-status.py hook script.

Uses pytest to verify the status determination logic for various Claude hook events.
Run with: uv run pytest plugins/pappardelle/hooks/test_update_status.py -v
"""

# Import the module under test (has hyphen in filename, so use importlib)
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any, NoReturn, Optional
from unittest.mock import patch

import pytest
from conftest import SQLITE_RUN, StatusSocket, record_space

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

SPACE_999 = "/Users/charlie/.worktrees/stardust-labs/STA-999"
# With the flag on a status is named by the stored space, always repo-qualified.
STATUS_999 = "stardust-labs-STA-999" if SQLITE_RUN else "STA-999"


def _status_file(status_dir: Path, status_key: str) -> Optional[dict[str, Any]]:
    file = status_dir / f"{status_key}.json"
    return json.loads(file.read_text()) if file.exists() else None


@pytest.fixture
def flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """The space comes from the cwd's path, as it does without the database."""
    monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")


@pytest.fixture
def space_999(request: pytest.FixtureRequest) -> None:
    """STA-999 as idow records it, where the run keeps state in the database."""
    if SQLITE_RUN:
        record_space(request.getfixturevalue("state_db"), "stardust-labs", "STA-999", SPACE_999)


@pytest.mark.usefixtures("flag_off")
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
        """When in main worktree, status should use the repo-qualified name (e.g., stardust-labs-master)."""
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

        # Should report under stardust-labs-master (repo-qualified), NOT master
        result = _status_file(tmp_path, "stardust-labs-master")
        assert result is not None, "Status should be reported under stardust-labs-master for main worktree"
        assert result["workspaceName"] == "stardust-labs-master"
        assert result["status"] == "waiting_for_input"

        # Should NOT report under the bare branch name
        assert _status_file(tmp_path, "master") is None, "Should NOT report under master (would collide across repos)"

        assert _status_file(tmp_path, "unknown") is None, "Should NOT report under unknown when branch is detected"

    def test_recovers_beads_key_from_a_worktree_with_no_config_of_its_own(self, tmp_path):
        """A beads worktree resolves its key through the main checkout's config.

        .pappardelle.yml and .beads/ are commonly excluded rather than committed,
        so a linked worktree has neither and used to fall through to the branch
        fallback — writing 'pappardelle-pap-a1b2.json' for issue 'pap-a1b2',
        which the sidebar never reads.
        """
        import update_status as us

        checkout = tmp_path / "checkout"
        checkout.mkdir()
        (checkout / ".pappardelle.yml").write_text("version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n")
        linked = tmp_path / "worktrees" / "pap-a1b2"
        linked.mkdir(parents=True)

        with patch.object(us._tracker_mod, "get_main_repo_root", return_value=str(checkout)):
            assert get_workspace_name(str(linked)) == "pap-a1b2"

    def test_branch_fallback_asks_git_about_the_given_cwd(self):
        """The fallback describes the workspace the hook was told about.

        Without an explicit cwd, git answered for whatever directory the hook
        process happened to inherit, which is not the workspace being reported.
        """
        seen = []

        def mock_run(cmd, **kwargs):
            seen.append(kwargs.get("cwd"))
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "feature-x\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/charlie/cs/myproj\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/somewhere/else"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name("/Users/charlie/cs/myproj") == "myproj-feature-x"

        assert seen == ["/Users/charlie/cs/myproj", "/Users/charlie/cs/myproj"]


@pytest.mark.usefixtures("space_999")
class TestStatusDetermination:
    """Tests for determining status from hook events.

    Follows Claude Island's event-forward model where every event updates state
    uniformly without tool-specific special-casing.
    """

    @pytest.fixture(autouse=True)
    def _read_status(self, read_status):
        self.read_status = read_status

    def _create_hook_input(
        self,
        hook_event: str,
        tool_name: Optional[str] = None,
        notification_type: Optional[str] = None,
        message: Optional[str] = None,
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
        if message:
            data["message"] = message
        return data

    def _run_hook_with_input(self, input_data: dict, temp_dir: Path) -> Optional[dict]:
        """Run the hook logic and return the status it reported."""
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

        return self.read_status(temp_dir, STATUS_999)

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

    def test_permission_prompt_notification_sets_waiting_for_approval(self, tmp_path):
        """A permission_prompt Notification sets 'waiting_for_approval' and keeps the tool name.

        STA-3151: the plugin has no PermissionRequest hook, because Claude Code ignores
        CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS while one exists. The
        Notification event carries the tool only inside its message text.
        """
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message="Claude needs your permission to use Bash",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result.get("currentTool") == "Bash"

    def test_permission_prompt_notification_keeps_ask_user_question_tool(self, tmp_path):
        """The UI tells a question from a permission by currentTool == 'AskUserQuestion'."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message="Claude needs your permission to use AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result.get("currentTool") == "AskUserQuestion"

    def test_permission_prompt_notification_without_tool_in_message(self, tmp_path):
        """A message with no tool name still sets 'waiting_for_approval', with no currentTool."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message="Claude needs your permission",
        )

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert "currentTool" not in result

    def test_permission_request_event_is_not_handled(self, tmp_path):
        """The plugin registers no PermissionRequest hook, so the script ignores that event."""
        input_data = self._create_hook_input(hook_event="PermissionRequest", tool_name="Bash")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None

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
        input_data["agent_type"] = "general-purpose"

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def _file_call(self, event: str, call: str, file_path: str, tool_name: str = "Edit") -> dict[str, Any]:
        data = self._create_hook_input(hook_event=event, tool_name=tool_name)
        data["tool_use_id"] = call
        data["tool_input"] = {"file_path": file_path}
        return data

    def _permission_prompt(self, tool: str = "Edit") -> dict[str, Any]:
        return self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message=f"Claude needs your permission to use {tool}",
        )

    def test_helper_subagent_stop_keeps_the_permission_record(self, tmp_path):
        """Claude's own helper agents stop with no agent_type while a prompt is up."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/x/a.ts", "Write"), tmp_path)
        self._run_hook_with_input(self._permission_prompt("Write"), tmp_path)
        helper = self._create_hook_input(hook_event="SubagentStop")
        helper["agent_type"] = ""

        result = self._run_hook_with_input(helper, tmp_path)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result["pendingFiles"] == ["/x/a.ts"]

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

    def test_permission_prompt_reports_the_files_of_unfinished_file_calls(self, tmp_path):
        """The prompt doesn't name its file, so the supervisor gets every pending one, resolved against cwd."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "a.ts"), tmp_path)
        self._run_hook_with_input(self._file_call("PreToolUse", "t2", "/tmp/b.ts", "Read"), tmp_path)

        result = self._run_hook_with_input(self._permission_prompt(), tmp_path)

        assert result is not None
        assert result["pendingFiles"] == ["/Users/charlie/.worktrees/stardust-labs/STA-999/a.ts", "/tmp/b.ts"]

    def test_a_finished_file_call_is_no_longer_pending(self, tmp_path):
        """A file from a call that already ran never stands in for the prompt's."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"), tmp_path)
        self._run_hook_with_input(self._file_call("PostToolUse", "t1", "/tmp/a.ts"), tmp_path)

        result = self._run_hook_with_input(self._permission_prompt(), tmp_path)

        assert result is not None
        assert "pendingFiles" not in result

    def test_a_failed_file_call_is_no_longer_pending(self, tmp_path):
        """A call that errored never reaches PostToolUse, only PostToolUseFailure."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"), tmp_path)
        self._run_hook_with_input(self._file_call("PostToolUseFailure", "t1", "/tmp/a.ts"), tmp_path)

        result = self._run_hook_with_input(self._permission_prompt(), tmp_path)

        assert result is not None
        assert "pendingFiles" not in result

    def test_the_main_agent_stopping_keeps_a_background_subagent_s_file(self, tmp_path):
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"), tmp_path)
        self._run_hook_with_input(self._create_hook_input(hook_event="Stop"), tmp_path)

        result = self._run_hook_with_input(self._permission_prompt(), tmp_path)

        assert result is not None
        assert result["pendingFiles"] == ["/tmp/a.ts"]

    def test_a_new_prompt_from_the_user_clears_pending_files(self, tmp_path):
        """A call declined at its prompt never finishes, so its file goes with the next prompt."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"), tmp_path)
        self._run_hook_with_input(self._create_hook_input(hook_event="UserPromptSubmit"), tmp_path)

        result = self._run_hook_with_input(self._permission_prompt(), tmp_path)

        assert result is not None
        assert "pendingFiles" not in result

    # =========================================================================
    # Edge Cases
    # =========================================================================

    def test_unknown_event_does_not_update(self, tmp_path):
        """Unknown hook events should not update status."""
        input_data = self._create_hook_input(hook_event="SomeUnknownEvent")

        result = self._run_hook_with_input(input_data, tmp_path)

        assert result is None


@pytest.mark.usefixtures("space_999")
class TestCommandLineArgs:
    """Tests for command line argument handling."""

    def test_explicit_status_arg_overrides_hook_event(self, tmp_path, read_status):
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

        result = read_status(tmp_path, STATUS_999)
        assert result["status"] == "waiting_for_input"

    def test_tool_arg_is_stored(self, tmp_path, read_status):
        """--tool argument should be stored in the status."""
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

        result = read_status(tmp_path, STATUS_999)
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

    @pytest.fixture(autouse=True)
    def _status_files(self, monkeypatch):
        # The hook writes a status file only while the flag is off.
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")

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


# ============================================================================
# PAPPARDELLE_SPACE (session environment) and slash branches
# ============================================================================


@pytest.fixture(autouse=True)
def _no_space_env(monkeypatch):
    """The developer's own shell may run inside a pappardelle pane."""
    monkeypatch.delenv("PAPPARDELLE_SPACE", raising=False)
    monkeypatch.delenv("PAPPARDELLE_REPO", raising=False)


@pytest.mark.usefixtures("flag_off")
class TestSpaceEnvironment:
    def test_space_env_wins_over_worktree_path(self, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "STA-42")
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/STA-999"):
            assert get_workspace_name() == "STA-42"

    def test_space_env_wins_over_main_checkout_cwd(self, monkeypatch):
        """A Claude resumed from the main checkout inside a space's pane."""
        monkeypatch.setenv("PAPPARDELLE_SPACE", "STA-42")

        def mock_run(cmd, **kwargs):
            raise AssertionError("git must not be consulted when the space is known")

        with (
            patch("os.getcwd", return_value="/Users/x/cs/repo"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name("/Users/x/cs/repo") == "STA-42"

    def test_empty_space_env_falls_back_to_cwd(self, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "  ")
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/STA-7"):
            assert get_workspace_name() == "STA-7"

    def test_slash_in_branch_name_is_flattened(self):
        """repo-alice/STA-1 would be a nested path, the write must stay flat."""

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "alice/STA-1\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/x/cs/myrepo\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/x/cs/myrepo"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "myrepo-alice-STA-1"


class TestRepoEnvironment:
    """Two repos can have spaces with the same key, and all repos write to one
    status directory, so the session's repo qualifies the file name."""

    def test_repo_qualifies_the_space(self, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "QA-2")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")
        assert get_workspace_name() == "repo-a-QA-2"
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-b")
        assert get_workspace_name() == "repo-b-QA-2"

    @pytest.mark.usefixtures("flag_off")
    def test_repo_qualifies_an_issue_key_from_the_worktree_path(self, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo-a/STA-7"):
            assert get_workspace_name() == "repo-a-STA-7"

    @pytest.mark.usefixtures("flag_off")
    def test_repo_qualifies_the_main_branch_over_the_toplevel_name(self, monkeypatch):
        """The TUI names the repo after the main checkout's git dir, which the
        session env carries; the toplevel basename can differ."""
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")

        def mock_run(cmd, **kwargs):
            if "--abbrev-ref" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "main\n"})()
            if "--show-toplevel" in cmd:
                return type("Result", (), {"returncode": 0, "stdout": "/Users/x/cs/checkout\n"})()
            return type("Result", (), {"returncode": 1, "stdout": ""})()

        with (
            patch("os.getcwd", return_value="/Users/x/cs/checkout"),
            patch("subprocess.run", side_effect=mock_run),
        ):
            assert get_workspace_name() == "repo-a-main"

    def test_two_repos_with_the_same_space_key_report_separately(self, monkeypatch, tmp_path, read_status):
        monkeypatch.setenv("PAPPARDELLE_STATUS_DIR", str(tmp_path))
        monkeypatch.setenv("PAPPARDELLE_SPACE", "QA-2")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")
        update_status_module.update_status("processing")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-b")
        update_status_module.update_status("waiting_for_approval")
        assert read_status(tmp_path, "repo-a-QA-2")["status"] == "processing"
        assert read_status(tmp_path, "repo-b-QA-2")["status"] == "waiting_for_approval"


# ============================================================================
# experimental.sqliteState: the space is the stored one holding the cwd
# ============================================================================


class TestStoredSpace:
    @pytest.fixture(autouse=True)
    def _no_process(self) -> Iterator[None]:
        """The store names the space, so no git or bd runs for it."""

        def refuse(*args: Any, **kwargs: Any) -> NoReturn:
            raise AssertionError(f"no process may run: {args}")

        with patch("subprocess.run", side_effect=refuse):
            yield

    @pytest.fixture
    def worktree(self, tmp_path: Path, state_db: Path) -> Path:
        worktree = tmp_path / "checkouts" / "login"
        (worktree / "src").mkdir(parents=True)
        record_space(state_db, "repo", "STA-5", str(worktree))
        return worktree

    def test_a_worktree_subdirectory_reports_under_the_stored_space(
        self, worktree: Path, status_socket: StatusSocket
    ) -> None:
        update_status("processing", cwd=str(worktree / "src"))
        assert [message["state"]["workspaceName"] for message in status_socket.messages()] == ["repo-STA-5"]

    def test_a_symlinked_cwd_reports_under_the_space_it_leads_to(
        self, worktree: Path, tmp_path: Path, status_socket: StatusSocket
    ) -> None:
        link = tmp_path / "link"
        link.symlink_to(worktree / "src")
        update_status("processing", cwd=str(link))
        assert [message["state"]["workspaceName"] for message in status_socket.messages()] == ["repo-STA-5"]

    def test_main_reports_under_its_key_whatever_the_branch(
        self, tmp_path: Path, state_db: Path, status_socket: StatusSocket
    ) -> None:
        main = tmp_path / "main"
        (main / "src").mkdir(parents=True)
        record_space(state_db, "repo", "main", str(main))
        update_status("processing", cwd=str(main / "src"))
        assert [message["state"]["workspaceName"] for message in status_socket.messages()] == ["repo-main"]

    def test_a_checkout_nested_in_main_is_not_main(
        self, tmp_path: Path, state_db: Path, status_socket: StatusSocket
    ) -> None:
        main = tmp_path / "main"
        nested = main / ".claude" / "worktrees" / "agent-x"
        (nested / "src").mkdir(parents=True)
        (nested / ".git").write_text("gitdir: elsewhere\n")
        record_space(state_db, "repo", "main", str(main))
        update_status("processing", cwd=str(nested / "src"))
        assert status_socket.messages() == []

    def test_a_closed_space_holds_no_caller(self, tmp_path: Path, state_db: Path, status_socket: StatusSocket) -> None:
        import sqlite3

        worktree = tmp_path / "closed"
        worktree.mkdir()
        record_space(state_db, "repo", "STA-6", str(worktree))
        connection = sqlite3.connect(state_db)
        connection.execute("DELETE FROM spaces WHERE key = 'STA-6'")
        connection.commit()
        connection.close()
        update_status("processing", cwd=str(worktree))
        assert status_socket.messages() == []

    def test_a_deleted_cwd_reports_nothing(self, worktree: Path, status_socket: StatusSocket) -> None:
        with patch("os.getcwd", side_effect=FileNotFoundError):
            update_status("processing")
        assert status_socket.messages() == []

    def test_a_cwd_in_no_stored_space_reports_nothing(
        self, worktree: Path, tmp_path: Path, status_socket: StatusSocket, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PAPPARDELLE_STATUS_DIR", str(tmp_path / "status"))
        update_status("processing", cwd=str(tmp_path))
        assert status_socket.messages() == []
        assert not (tmp_path / "status").exists()


# ============================================================================
# experimental.sqliteState: status goes to the status daemon, not to a file
# ============================================================================


def _run_hook(event: dict[str, Any], env: dict[str, str]) -> subprocess.CompletedProcess:
    """The hook as Claude runs it, and whether it loaded the modules that only
    the flag-on paths need."""
    return subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy, sys\n"
            "try:\n"
            f"    runpy.run_path({str(_module_path)!r}, run_name='__main__')\n"
            "except SystemExit as stop:\n"
            "    code = stop.code\n"
            "print(code, 'sqlite3' in sys.modules, 'socket' in sys.modules)",
        ],
        input=json.dumps(event),
        # Nothing of the session these tests run in: its variables name
        # the developer's own state files.
        env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], **env},
        capture_output=True,
        text=True,
        check=True,
    )


class TestStatusDaemon:
    CWD = "/Users/charlie/.worktrees/stardust-labs/STA-9200"

    @pytest.fixture
    def status_dir(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        status_dir = tmp_path / "status"
        monkeypatch.setenv("PAPPARDELLE_STATUS_DIR", str(status_dir))
        return status_dir

    @pytest.fixture
    def flag_on(self, state_db: Path) -> None:
        record_space(state_db, "stardust-labs", "STA-9200", self.CWD)

    def test_flag_on_sends_one_line_and_writes_no_file(
        self, flag_on: None, status_socket: StatusSocket, status_dir: Path
    ) -> None:
        update_status("running_tool", "Bash", "sess-1", "PreToolUse", self.CWD)

        (message,) = status_socket.messages()
        last_update = message["state"]["lastUpdate"]
        assert isinstance(last_update, int)
        assert message == {
            "type": "hook",
            "state": {
                "sessionId": "sess-1",
                "workspaceName": "stardust-labs-STA-9200",
                "status": "running_tool",
                "lastUpdate": last_update,
                "currentTool": "Bash",
                "event": "PreToolUse",
                "cwd": self.CWD,
            },
        }
        assert not status_dir.exists()

    def test_flag_on_a_later_event_leaves_out_what_it_does_not_report(
        self, flag_on: None, status_socket: StatusSocket, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo")
        monkeypatch.setenv("PAPPARDELLE_SPACE", "QA-1")
        update_status("running_tool", "Bash", "sess-1", "PreToolUse", self.CWD)
        update_status("waiting_for_input", session_id="sess-1")

        later = status_socket.messages()[1]["state"]
        assert later == {
            "sessionId": "sess-1",
            "workspaceName": "repo-QA-1",
            "status": "waiting_for_input",
            "lastUpdate": later["lastUpdate"],
        }

    def test_flag_on_a_sent_status_removes_the_file_from_before_the_flag(
        self, status_socket: StatusSocket, status_dir: Path, state_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        record_space(state_db, "stardust-labs", "STA-9200", self.CWD)
        monkeypatch.setenv("PAPPARDELLE_REPO", "stardust-labs")
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")
        update_status("processing", cwd=self.CWD)
        update_status("processing", cwd="/Users/charlie/.worktrees/stardust-labs/STA-9201")
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "1")

        update_status("waiting_for_input", cwd=self.CWD)

        assert [message["state"]["status"] for message in status_socket.messages()] == ["waiting_for_input"]
        assert sorted(file.name for file in status_dir.iterdir()) == ["stardust-labs-STA-9201.json"]

    def test_flag_on_with_nothing_listening_the_event_is_dropped_and_the_file_stays(
        self,
        status_socket: StatusSocket,
        status_dir: Path,
        tmp_path: Path,
        state_db: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        record_space(state_db, "stardust-labs", "STA-9200", self.CWD)
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")
        update_status("processing", cwd=self.CWD)
        before = (status_dir / "STA-9200.json").read_text()
        status_socket.close()
        home = tmp_path / "home"
        home.mkdir()

        result = _run_hook(
            {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": self.CWD},
            {
                "HOME": str(home),
                "PAPPARDELLE_STATUS_DIR": str(status_dir),
                "PAPPARDELLE_SQLITE_STATE": "1",
                "PAPPARDELLE_STATE_DB": str(state_db),
                "PAPPARDELLE_STATUS_SOCKET": str(status_socket.path),
            },
        )

        assert result.stdout.split()[0] == "0"
        assert result.stderr == ""
        assert (status_dir / "STA-9200.json").read_text() == before
        assert [file.name for file in status_dir.iterdir()] == ["STA-9200.json"]
        # Not logged either: no daemon runs whenever Pappardelle is closed.
        assert list(home.iterdir()) == []

    def test_flag_on_with_nothing_listening_and_no_file_nothing_is_written(
        self, flag_on: None, status_dir: Path, short_tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PAPPARDELLE_STATUS_SOCKET", str(short_tmp_path / "status-1.sock"))

        update_status("processing", cwd=self.CWD)

        assert not status_dir.exists()
        assert list(short_tmp_path.iterdir()) == []

    def test_the_socket_is_beside_a_database_that_was_moved(
        self, short_tmp_path: Path, status_dir: Path, migrated_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        beside_the_database = StatusSocket(short_tmp_path / "status-1.sock")
        moved = short_tmp_path / "state.db"
        shutil.copy(migrated_db, moved)
        record_space(moved, "stardust-labs", "STA-9200", self.CWD)
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "1")
        monkeypatch.setenv("PAPPARDELLE_STATE_DB", str(moved))
        try:
            update_status("processing", cwd=self.CWD)

            assert [message["state"]["workspaceName"] for message in beside_the_database.messages()] == [
                "stardust-labs-STA-9200"
            ]
        finally:
            beside_the_database.close()

    def test_flag_off_writes_the_file_and_sends_nothing(
        self, status_socket: StatusSocket, status_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")
        update_status("processing", cwd=self.CWD)

        assert json.loads((status_dir / "STA-9200.json").read_text())["status"] == "processing"
        assert status_socket.messages() == []

    def test_flag_off_loads_neither_sqlite_nor_socket(self, status_dir: Path) -> None:
        """The hook runs on every agent event. With the flag off it must cost
        what it did before the database and the daemon existed."""
        result = _run_hook(
            {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": self.CWD},
            {"PAPPARDELLE_STATUS_DIR": str(status_dir), "PAPPARDELLE_SQLITE_STATE": "0"},
        )

        assert json.loads((status_dir / "STA-9200.json").read_text())["status"] == "waiting_for_input"
        assert result.stdout.split() == ["0", "False", "False"]
