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
from conftest import StatusSocket, record_space

_module_path = Path(__file__).parent / "update-status.py"
_spec = importlib.util.spec_from_file_location("update_status", _module_path)
assert _spec is not None, "Failed to load update-status.py spec"
assert _spec.loader is not None, "Failed to get loader for update-status.py"
update_status_module = importlib.util.module_from_spec(_spec)
sys.modules["update_status"] = update_status_module
_spec.loader.exec_module(update_status_module)

get_workspace_name = update_status_module.get_workspace_name
update_status = update_status_module.update_status

SPACE_999 = "/Users/charlie/.worktrees/stardust-labs/STA-999"
STATUS_999 = "stardust-labs-STA-999"


@pytest.fixture(autouse=True)
def _no_space_env(monkeypatch):
    """The developer's own shell may run inside a pappardelle pane."""
    monkeypatch.delenv("PAPPARDELLE_SPACE", raising=False)
    monkeypatch.delenv("PAPPARDELLE_REPO", raising=False)


@pytest.fixture
def space_999(state_db: Path) -> None:
    """STA-999 as idow records it."""
    record_space(state_db, "stardust-labs", "STA-999", SPACE_999)


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

    def _run_hook_with_input(self, input_data: dict) -> Optional[dict]:
        """Run the hook logic and return the status it reported."""
        from io import StringIO

        import update_status as us

        # Patch stdin to provide the hook input
        stdin_mock = StringIO(json.dumps(input_data))

        with (
            patch.object(sys, "stdin", stdin_mock),
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

        return self.read_status(STATUS_999)

    # =========================================================================
    # Processing / Tool Use Tests
    # =========================================================================

    def test_user_prompt_submit_sets_processing(self):
        """UserPromptSubmit should set status to 'processing'."""
        input_data = self._create_hook_input(hook_event="UserPromptSubmit")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "processing"

    def test_pre_tool_use_sets_running_tool(self):
        """PreToolUse should set status to 'running_tool'."""
        input_data = self._create_hook_input(
            hook_event="PreToolUse",
            tool_name="Bash",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "running_tool"

    def test_post_tool_use_sets_processing(self):
        """PostToolUse should set 'processing' for all tools uniformly."""
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="Read",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "processing"

    def test_post_tool_use_ask_user_question_sets_processing(self):
        """PostToolUse for AskUserQuestion sets 'processing' — no special-casing."""
        input_data = self._create_hook_input(
            hook_event="PostToolUse",
            tool_name="AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "processing", "No tool-specific special-casing (Claude Island model)"

    # =========================================================================
    # Permission Request Tests
    # =========================================================================

    def test_permission_prompt_notification_sets_waiting_for_approval(self):
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

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result.get("currentTool") == "Bash"

    def test_permission_prompt_notification_keeps_ask_user_question_tool(self):
        """The UI tells a question from a permission by currentTool == 'AskUserQuestion'."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message="Claude needs your permission to use AskUserQuestion",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result.get("currentTool") == "AskUserQuestion"

    def test_permission_prompt_notification_without_tool_in_message(self):
        """A message with no tool name still sets 'waiting_for_approval', with no currentTool."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="permission_prompt",
            message="Claude needs your permission",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert "currentTool" not in result

    def test_permission_request_event_is_not_handled(self):
        """The plugin registers no PermissionRequest hook, so the script ignores that event."""
        input_data = self._create_hook_input(hook_event="PermissionRequest", tool_name="Bash")

        result = self._run_hook_with_input(input_data)

        assert result is None

    # =========================================================================
    # Stop / Session Lifecycle Tests
    # =========================================================================

    def test_stop_sets_waiting_for_input(self):
        """Stop should set 'waiting_for_input' (Claude finished turn, session still active)."""
        input_data = self._create_hook_input(hook_event="Stop")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_session_start_sets_waiting_for_input(self):
        """SessionStart should set 'waiting_for_input'."""
        input_data = self._create_hook_input(hook_event="SessionStart")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_session_end_sets_ended(self):
        """SessionEnd should set 'ended' (distinct from waiting_for_input)."""
        input_data = self._create_hook_input(hook_event="SessionEnd")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "ended"

    def test_subagent_stop_sets_waiting_for_input(self):
        """SubagentStop should set 'waiting_for_input' (parent back to waiting)."""
        input_data = self._create_hook_input(hook_event="SubagentStop")
        input_data["agent_type"] = "general-purpose"

        result = self._run_hook_with_input(input_data)

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

    def test_helper_subagent_stop_keeps_the_permission_record(self):
        """Claude's own helper agents stop with no agent_type while a prompt is up."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/x/a.ts", "Write"))
        self._run_hook_with_input(self._permission_prompt("Write"))
        helper = self._create_hook_input(hook_event="SubagentStop")
        helper["agent_type"] = ""

        result = self._run_hook_with_input(helper)

        assert result is not None
        assert result["status"] == "waiting_for_approval"
        assert result["pendingFiles"] == ["/x/a.ts"]

    # =========================================================================
    # Compaction Tests
    # =========================================================================

    def test_pre_compact_sets_compacting(self):
        """PreCompact should set 'compacting' (distinct status)."""
        input_data = self._create_hook_input(hook_event="PreCompact")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "compacting"

    # =========================================================================
    # Notification Tests
    # =========================================================================

    def test_notification_idle_prompt_sets_waiting_for_input(self):
        """idle_prompt notification should set 'waiting_for_input'."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="idle_prompt",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result["status"] == "waiting_for_input"

    def test_notification_other_type_does_not_update(self):
        """Notification with unrecognized type should not update status."""
        input_data = self._create_hook_input(
            hook_event="Notification",
            notification_type="some_other_type",
        )

        result = self._run_hook_with_input(input_data)

        assert result is None

    # =========================================================================
    # Rich Data Tests
    # =========================================================================

    def test_status_includes_event(self):
        """The status should include the raw hook event name."""
        input_data = self._create_hook_input(hook_event="PreToolUse", tool_name="Bash")

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result.get("event") == "PreToolUse"

    def test_status_includes_cwd(self):
        """The status should include the working directory."""
        input_data = self._create_hook_input(
            hook_event="UserPromptSubmit",
            cwd="/Users/charlie/.worktrees/stardust-labs/STA-999",
        )

        result = self._run_hook_with_input(input_data)

        assert result is not None
        assert result.get("cwd") == "/Users/charlie/.worktrees/stardust-labs/STA-999"

    def test_permission_prompt_reports_the_files_of_unfinished_file_calls(self):
        """The prompt doesn't name its file, so the supervisor gets every pending one, resolved against cwd."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "a.ts"))
        self._run_hook_with_input(self._file_call("PreToolUse", "t2", "/tmp/b.ts", "Read"))

        result = self._run_hook_with_input(self._permission_prompt())

        assert result is not None
        assert result["pendingFiles"] == ["/Users/charlie/.worktrees/stardust-labs/STA-999/a.ts", "/tmp/b.ts"]

    def test_a_finished_file_call_is_no_longer_pending(self):
        """A file from a call that already ran never stands in for the prompt's."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"))
        self._run_hook_with_input(self._file_call("PostToolUse", "t1", "/tmp/a.ts"))

        result = self._run_hook_with_input(self._permission_prompt())

        assert result is not None
        assert "pendingFiles" not in result

    def test_a_failed_file_call_is_no_longer_pending(self):
        """A call that errored never reaches PostToolUse, only PostToolUseFailure."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"))
        self._run_hook_with_input(self._file_call("PostToolUseFailure", "t1", "/tmp/a.ts"))

        result = self._run_hook_with_input(self._permission_prompt())

        assert result is not None
        assert "pendingFiles" not in result

    def test_the_main_agent_stopping_keeps_a_background_subagent_s_file(self):
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"))
        self._run_hook_with_input(self._create_hook_input(hook_event="Stop"))

        result = self._run_hook_with_input(self._permission_prompt())

        assert result is not None
        assert result["pendingFiles"] == ["/tmp/a.ts"]

    def test_a_new_prompt_from_the_user_clears_pending_files(self):
        """A call declined at its prompt never finishes, so its file goes with the next prompt."""
        self._run_hook_with_input(self._file_call("PreToolUse", "t1", "/tmp/a.ts"))
        self._run_hook_with_input(self._create_hook_input(hook_event="UserPromptSubmit"))

        result = self._run_hook_with_input(self._permission_prompt())

        assert result is not None
        assert "pendingFiles" not in result

    # =========================================================================
    # Edge Cases
    # =========================================================================

    def test_unknown_event_does_not_update(self):
        """Unknown hook events should not update status."""
        input_data = self._create_hook_input(hook_event="SomeUnknownEvent")

        result = self._run_hook_with_input(input_data)

        assert result is None


@pytest.mark.usefixtures("space_999")
class TestCommandLineArgs:
    """Tests for command line argument handling."""

    def test_explicit_status_arg_overrides_hook_event(self, read_status):
        """Command line status arg should be used directly."""
        from io import StringIO

        import update_status as us

        stdin_mock = StringIO("{}")

        with (
            patch.object(sys, "stdin", stdin_mock),
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

        result = read_status(STATUS_999)
        assert result["status"] == "waiting_for_input"

    def test_tool_arg_is_stored(self, read_status):
        """--tool argument should be stored in the status."""
        from io import StringIO

        import update_status as us

        stdin_mock = StringIO("{}")

        with (
            patch.object(sys, "stdin", stdin_mock),
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

        result = read_status(STATUS_999)
        assert result["status"] == "running_tool"
        assert result.get("currentTool") == "Bash"


class TestSpaceEnvironment:
    @pytest.fixture
    def worktree(self, tmp_path: Path, state_db: Path) -> Path:
        worktree = tmp_path / "STA-999"
        worktree.mkdir()
        record_space(state_db, "repo", "STA-999", str(worktree))
        return worktree

    def test_space_env_wins_over_the_stored_space_holding_the_cwd(self, worktree: Path, monkeypatch):
        """A Claude resumed from another space's directory inside a space's pane."""
        monkeypatch.setenv("PAPPARDELLE_SPACE", "STA-42")
        assert get_workspace_name(str(worktree)) == "STA-42"

    def test_empty_space_env_falls_back_to_the_stored_space(self, worktree: Path, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "  ")
        assert get_workspace_name(str(worktree)) == "repo-STA-999"

    def test_without_a_cwd_the_process_directory_is_looked_up(self, worktree: Path):
        with patch("os.getcwd", return_value=str(worktree)):
            assert get_workspace_name() == "repo-STA-999"


class TestRepoEnvironment:
    """Two repos can have spaces with the same key, so the session's repo
    qualifies the status key."""

    def test_repo_qualifies_the_space(self, monkeypatch):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "QA-2")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")
        assert get_workspace_name() == "repo-a-QA-2"
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-b")
        assert get_workspace_name() == "repo-b-QA-2"

    def test_two_repos_with_the_same_space_key_report_separately(self, monkeypatch, read_status):
        monkeypatch.setenv("PAPPARDELLE_SPACE", "QA-2")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-a")
        update_status_module.update_status("processing")
        monkeypatch.setenv("PAPPARDELLE_REPO", "repo-b")
        update_status_module.update_status("waiting_for_approval")
        assert read_status("repo-a-QA-2")["status"] == "processing"
        assert read_status("repo-b-QA-2")["status"] == "waiting_for_approval"


# ============================================================================
# The space is the stored one holding the cwd
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
        self, worktree: Path, tmp_path: Path, status_socket: StatusSocket
    ) -> None:
        update_status("processing", cwd=str(tmp_path))
        assert status_socket.messages() == []

    def test_without_a_database_nothing_is_reported_or_created_and_the_failure_is_logged(
        self, tmp_path: Path, status_socket: StatusSocket
    ) -> None:
        worktree = tmp_path / "STA-5"
        worktree.mkdir()
        update_status("processing", cwd=str(worktree))
        assert status_socket.messages() == []
        assert not (Path.home() / ".pappardelle" / "state.db").exists()
        log = (Path.home() / ".pappardelle" / "logs" / "hook-events.log").read_text()
        assert "State database read failed" in log


# ============================================================================
# Status goes to the status daemon
# ============================================================================


class TestStatusDaemon:
    CWD = "/Users/charlie/.worktrees/stardust-labs/STA-9200"

    @pytest.fixture
    def space(self, state_db: Path) -> None:
        record_space(state_db, "stardust-labs", "STA-9200", self.CWD)

    def test_a_status_is_sent_as_one_line(self, space: None, status_socket: StatusSocket) -> None:
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

    def test_a_later_event_leaves_out_what_it_does_not_report(
        self, space: None, status_socket: StatusSocket, monkeypatch: pytest.MonkeyPatch
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

    def test_with_nothing_listening_the_event_is_dropped_quietly(
        self, space: None, status_socket: StatusSocket, short_tmp_path: Path, state_db: Path
    ) -> None:
        status_socket.close()
        home = Path.home()

        # The hook as Claude runs it, with nothing of the session these tests
        # run in: its variables name the developer's own state.
        result = subprocess.run(
            [sys.executable, str(_module_path)],
            input=json.dumps({"hook_event_name": "Stop", "session_id": "sess-1", "cwd": self.CWD}),
            env={
                "PATH": os.environ["PATH"],
                "HOME": str(home),
                "PAPPARDELLE_STATE_DB": str(state_db),
                "PAPPARDELLE_STATUS_SOCKET": str(status_socket.path),
            },
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0
        assert result.stderr == ""
        # Not logged either: no daemon runs whenever Pappardelle is closed.
        assert list(home.iterdir()) == []
        assert list(short_tmp_path.iterdir()) == []

    def test_the_socket_is_beside_a_database_that_was_moved(
        self, short_tmp_path: Path, migrated_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        beside_the_database = StatusSocket(short_tmp_path / "status-1.sock")
        moved = short_tmp_path / "state.db"
        shutil.copy(migrated_db, moved)
        record_space(moved, "stardust-labs", "STA-9200", self.CWD)
        monkeypatch.setenv("PAPPARDELLE_STATE_DB", str(moved))
        try:
            update_status("processing", cwd=self.CWD)

            assert [message["state"]["workspaceName"] for message in beside_the_database.messages()] == [
                "stardust-labs-STA-9200"
            ]
        finally:
            beside_the_database.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
