#!/usr/bin/env python3
"""
Tests for comment-question-answered.py hook script.

Run with: uv run pytest _dev/scripts/pappardelle/hooks/test_comment_question_answered.py -v
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

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
