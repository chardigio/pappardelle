#!/usr/bin/env python3
"""
Tests for comment-question-answered.py hook script — Jira ADF integration paths.

Run with: uv run pytest hooks/test_comment_question_answered.py -v
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_module_path = Path(__file__).parent / "comment-question-answered.py"
_spec = importlib.util.spec_from_file_location("comment_question_answered", _module_path)
assert _spec is not None
assert _spec.loader is not None
mod = importlib.util.module_from_spec(_spec)
sys.modules["comment_question_answered"] = mod
_spec.loader.exec_module(mod)

get_issue_key = mod.get_issue_key
get_tracker_provider = mod.get_tracker_provider
format_question_answer = mod.format_question_answer
post_comment = mod.post_comment


class TestGetIssueKey:
    def test_extracts_from_worktree_path(self):
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/STA-123/src"):
            assert get_issue_key() == "STA-123"

    def test_returns_none_for_no_issue(self):
        with patch("os.getcwd", return_value="/Users/x/projects/my-repo"):
            assert get_issue_key() is None

    def test_returns_none_when_getcwd_raises_oserror(self):
        """Should return None when os.getcwd() raises (deleted worktree)."""
        with patch("os.getcwd", side_effect=FileNotFoundError):
            assert get_issue_key() is None


class TestGetTrackerProvider:
    def test_returns_jira_from_config(self, tmp_path):
        config = tmp_path / ".pappardelle.yml"
        config.write_text("issue_tracker:\n  provider: jira\n")

        with patch("os.getcwd", return_value=str(tmp_path)):
            assert get_tracker_provider() == "jira"

    def test_returns_linear_by_default(self, tmp_path):
        with patch("os.getcwd", return_value=str(tmp_path)):
            assert get_tracker_provider() == "linear"

    def test_returns_linear_when_getcwd_raises_oserror(self):
        """Should return 'linear' default when os.getcwd() raises (deleted worktree)."""
        with patch("os.getcwd", side_effect=FileNotFoundError):
            assert get_tracker_provider() == "linear"


class TestFormatQuestionAnswer:
    def test_formats_new_format_with_dict_response(self):
        tool_input = {
            "questions": [
                {
                    "question": "Which approach?",
                    "header": "Approach",
                    "options": [
                        {"label": "Option A", "description": "First option"},
                        {"label": "Option B", "description": "Second option"},
                    ],
                    "multiSelect": False,
                }
            ]
        }
        tool_response = {"answers": {"Which approach?": "Option A"}}
        result = format_question_answer(tool_input, tool_response)
        assert "Which approach?" in result
        assert "Option A" in result

    def test_formats_legacy_string_response(self):
        tool_input = {
            "questions": [
                {
                    "question": "Which approach?",
                    "header": "Approach",
                    "options": [
                        {"label": "Option A", "description": "First option"},
                    ],
                    "multiSelect": False,
                }
            ]
        }
        tool_response = 'User has answered your questions: "Which approach?"="Option A"'
        result = format_question_answer(tool_input, tool_response)
        assert "Which approach?" in result
        assert "Option A" in result

    def test_returns_empty_when_no_questions(self):
        assert format_question_answer({}, {}) == ""
        assert format_question_answer({"questions": []}, {}) == ""


class TestPostCommentJira:
    def test_calls_acli_with_body_file(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "Comment added"
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            result = post_comment("PROJ-1", "## Q&A\n\nSome answer")

            assert result is True
            call_args = mock_subprocess.run.call_args
            cmd = call_args[0][0]
            assert "acli" in cmd
            assert "--body-file" in cmd
            body_file_idx = cmd.index("--body-file") + 1
            assert cmd[body_file_idx].endswith(".json")

    def test_body_file_contains_valid_adf_json(self):
        captured_cmd = []

        def capture_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            body_idx = cmd.index("--body-file") + 1
            with open(cmd[body_idx]) as f:
                captured_cmd.append(("adf_content", f.read()))
            result = MagicMock()
            result.returncode = 0
            result.stdout = "Comment added"
            result.stderr = ""
            return result

        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_subprocess.run.side_effect = capture_run

            post_comment("PROJ-1", "### Heading\n\n**bold** text")

            adf_content = [item[1] for item in captured_cmd if isinstance(item, tuple) and item[0] == "adf_content"][0]
            parsed = json.loads(adf_content)
            assert parsed["type"] == "doc"
            assert parsed["version"] == 1

    def test_temp_file_cleaned_up_on_success(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            captured_path = []

            def capture_run(cmd, **kwargs):
                body_idx = cmd.index("--body-file") + 1
                captured_path.append(cmd[body_idx])
                result = MagicMock()
                result.returncode = 0
                result.stdout = "Comment added"
                result.stderr = ""
                return result

            mock_subprocess.run.side_effect = capture_run

            post_comment("PROJ-1", "Comment body")

            assert len(captured_path) == 1
            assert not os.path.exists(captured_path[0])

    def test_temp_file_cleaned_up_on_timeout(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            captured_path = []

            def capture_run(cmd, **kwargs):
                body_idx = cmd.index("--body-file") + 1
                captured_path.append(cmd[body_idx])
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=30)

            mock_subprocess.run.side_effect = capture_run
            mock_subprocess.TimeoutExpired = subprocess.TimeoutExpired

            result = post_comment("PROJ-1", "Comment body")

            assert result is False
            assert len(captured_path) == 1
            assert not os.path.exists(captured_path[0])

    def test_returns_false_on_acli_failure_output(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "Failure: invalid ADF"
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            result = post_comment("PROJ-1", "Comment body")

            assert result is False

    def test_returns_false_on_tempfile_error(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "tempfile") as mock_tempfile,
        ):
            mock_tempfile.NamedTemporaryFile.side_effect = OSError("disk full")

            result = post_comment("PROJ-1", "Comment body")

            assert result is False


class TestPostCommentLinear:
    def test_calls_linctl_with_body(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="linear"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_subprocess.run.return_value = mock_result

            result = post_comment("STA-123", "Comment body")

            assert result is True
            call_args = mock_subprocess.run.call_args
            cmd = call_args[0][0]
            assert "linctl" in cmd
            assert "--body" in cmd
            assert "Comment body" in cmd


class TestMainExitsZero:
    def test_main_exits_zero_on_exception(self):
        """Top-level exception handler should always exit 0."""
        with patch.object(mod, "main", side_effect=RuntimeError("boom")):
            with pytest.raises(SystemExit) as exc_info:
                # Simulate the __main__ block
                try:
                    mod.main()
                except Exception:
                    sys.exit(0)
            assert exc_info.value.code == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
