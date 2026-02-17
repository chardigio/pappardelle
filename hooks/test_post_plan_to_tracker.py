#!/usr/bin/env python3
"""
Tests for post-plan-to-tracker.py hook script.

Run with: uv run pytest hooks/test_post_plan_to_tracker.py -v
"""

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

_module_path = Path(__file__).parent / "post-plan-to-tracker.py"
_spec = importlib.util.spec_from_file_location("post_plan_to_tracker", _module_path)
assert _spec is not None
assert _spec.loader is not None
mod = importlib.util.module_from_spec(_spec)
sys.modules["post_plan_to_tracker"] = mod
_spec.loader.exec_module(mod)

get_issue_key = mod.get_issue_key
is_new_issue = mod.is_new_issue
mark_plan_posted = mod.mark_plan_posted
extract_plan_from_transcript = mod.extract_plan_from_transcript
get_tracker_provider = mod.get_tracker_provider


class TestGetIssueKey:
    def test_extracts_from_worktree_path(self):
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/STA-123/src"):
            assert get_issue_key() == "STA-123"

    def test_extracts_different_prefix(self):
        with patch("os.getcwd", return_value="/home/u/.worktrees/r/CHEX-45"):
            assert get_issue_key() == "CHEX-45"

    def test_returns_none_for_no_issue(self):
        with patch("os.getcwd", return_value="/Users/x/projects/my-repo"):
            assert get_issue_key() is None

    def test_ignores_lowercase(self):
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/sta-123"):
            assert get_issue_key() is None

    def test_ignores_single_char_prefix(self):
        with patch("os.getcwd", return_value="/Users/x/.worktrees/repo/X-99"):
            assert get_issue_key() is None

    def test_ignores_repo_name_false_positive(self):
        with patch("os.getcwd", return_value="/Users/x/.worktrees/MY-5/STA-123"):
            assert get_issue_key() == "STA-123"


class TestIsNewIssue:
    def test_returns_true_when_created_by_pappardelle(self, tmp_path):
        meta_file = tmp_path / "STA-123.json"
        meta_file.write_text(json.dumps({"created_by_pappardelle": True}))

        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            assert is_new_issue("STA-123") is True

    def test_returns_false_when_not_created_by_pappardelle(self, tmp_path):
        meta_file = tmp_path / "STA-123.json"
        meta_file.write_text(json.dumps({"created_by_pappardelle": False}))

        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            assert is_new_issue("STA-123") is False

    def test_returns_false_when_no_meta_file(self, tmp_path):
        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            assert is_new_issue("STA-999") is False

    def test_returns_false_on_corrupt_json(self, tmp_path):
        meta_file = tmp_path / "STA-123.json"
        meta_file.write_text("not json")

        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            assert is_new_issue("STA-123") is False


class TestMarkPlanPosted:
    def test_creates_meta_file_if_missing(self, tmp_path):
        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            mark_plan_posted("STA-123")

        meta = json.loads((tmp_path / "STA-123.json").read_text())
        assert meta["plan_posted"] is True

    def test_preserves_existing_fields(self, tmp_path):
        meta_file = tmp_path / "STA-123.json"
        meta_file.write_text(
            json.dumps(
                {
                    "created_by_pappardelle": True,
                    "created_at": "2026-01-01T00:00:00Z",
                }
            )
        )

        with patch.object(mod, "get_issue_meta_dir", return_value=tmp_path):
            mark_plan_posted("STA-123")

        meta = json.loads(meta_file.read_text())
        assert meta["plan_posted"] is True
        assert meta["created_by_pappardelle"] is True
        assert meta["created_at"] == "2026-01-01T00:00:00Z"


class TestExtractPlanFromTranscript:
    def _write_transcript(self, tmp_path, messages):
        """Write a JSONL transcript file."""
        transcript = tmp_path / "transcript.jsonl"
        lines = [json.dumps(msg) for msg in messages]
        transcript.write_text("\n".join(lines))
        return str(transcript)

    def test_extracts_from_write_tool_call(self, tmp_path):
        plan_content = "# Plan\n\n## Step 1\nDo the thing\n\n## Step 2\nDo the other thing"
        messages = [
            {"role": "user", "content": "implement the feature"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me write the plan."},
                    {
                        "type": "tool_use",
                        "name": "Write",
                        "input": {
                            "file_path": "/tmp/plan.md",
                            "content": plan_content,
                        },
                    },
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Plan is ready."},
                    {
                        "type": "tool_use",
                        "name": "ExitPlanMode",
                        "input": {},
                    },
                ],
            },
        ]
        path = self._write_transcript(tmp_path, messages)
        assert extract_plan_from_transcript(path) == plan_content

    def test_falls_back_to_assistant_text(self, tmp_path):
        plan_text = "Here is my detailed implementation plan with many steps and considerations that spans more than one hundred characters to be substantial enough."
        messages = [
            {"role": "user", "content": "implement the feature"},
            {"role": "assistant", "content": [{"type": "text", "text": plan_text}]},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ExitPlanMode",
                        "input": {},
                    },
                ],
            },
        ]
        path = self._write_transcript(tmp_path, messages)
        assert extract_plan_from_transcript(path) == plan_text

    def test_returns_none_for_missing_file(self):
        assert extract_plan_from_transcript("/nonexistent/path.jsonl") is None

    def test_returns_none_for_empty_transcript(self, tmp_path):
        path = self._write_transcript(tmp_path, [])
        assert extract_plan_from_transcript(path) is None

    def test_ignores_short_write_content(self, tmp_path):
        """Write calls with tiny content (< 50 chars) should be skipped."""
        long_text = "A" * 150  # substantial assistant text fallback
        messages = [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": long_text}],
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Write",
                        "input": {"file_path": "/tmp/small.txt", "content": "hi"},
                    },
                ],
            },
        ]
        path = self._write_transcript(tmp_path, messages)
        result = extract_plan_from_transcript(path)
        assert result == long_text

    def test_prefers_write_over_text(self, tmp_path):
        """Write tool call content takes priority over assistant text."""
        plan_via_write = "# Plan via Write\n\n" + "x" * 100
        plan_via_text = "# Plan via text\n\n" + "y" * 100
        messages = [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": plan_via_text}],
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Write",
                        "input": {"file_path": "/tmp/plan.md", "content": plan_via_write},
                    },
                ],
            },
        ]
        path = self._write_transcript(tmp_path, messages)
        assert extract_plan_from_transcript(path) == plan_via_write


class TestGetTrackerProvider:
    def test_returns_jira_from_config(self, tmp_path):
        config = tmp_path / ".pappardelle.yml"
        config.write_text("issue_tracker:\n  provider: jira\n")

        with patch("os.getcwd", return_value=str(tmp_path)):
            assert get_tracker_provider() == "jira"

    def test_returns_linear_by_default(self, tmp_path):
        with patch("os.getcwd", return_value=str(tmp_path)):
            assert get_tracker_provider() == "linear"

    def test_returns_linear_from_config(self, tmp_path):
        config = tmp_path / ".pappardelle.yml"
        config.write_text("issue_tracker:\n  provider: linear\n")

        with patch("os.getcwd", return_value=str(tmp_path)):
            assert get_tracker_provider() == "linear"
