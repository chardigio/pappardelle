#!/usr/bin/env python3
"""
Tests for post-plan-to-tracker.py hook script.

Run with: uv run pytest hooks/test_post_plan_to_tracker.py -v
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

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
update_description = mod.update_description
post_comment = mod.post_comment


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

    def test_returns_none_when_getcwd_raises_oserror(self):
        """Should return None when os.getcwd() raises (deleted worktree)."""
        with patch("os.getcwd", side_effect=FileNotFoundError):
            assert get_issue_key() is None


class TestGetTrackerProviderOSError:
    def test_returns_linear_when_getcwd_raises_oserror(self):
        """Should return 'linear' default when os.getcwd() raises (deleted worktree)."""
        with patch("os.getcwd", side_effect=FileNotFoundError):
            assert get_tracker_provider() == "linear"


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


class TestUpdateDescriptionJira:
    def test_calls_acli_with_description_file(self, tmp_path):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = "Updated PROJ-1"
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            result = update_description("PROJ-1", "## Plan\n\nStep 1")

            assert result is True
            call_args = mock_subprocess.run.call_args
            cmd = call_args[0][0]
            assert "acli" in cmd
            assert "--description-file" in cmd
            # The temp file path should be in the command
            desc_file_idx = cmd.index("--description-file") + 1
            tmp_file = cmd[desc_file_idx]
            assert tmp_file.endswith(".json")

    def test_description_file_contains_valid_adf_json(self, tmp_path):
        captured_cmd = []

        def capture_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            # Read the temp file before it gets cleaned up
            desc_idx = cmd.index("--description-file") + 1
            with open(cmd[desc_idx]) as f:
                captured_cmd.append(("adf_content", f.read()))
            result = MagicMock()
            result.returncode = 0
            result.stdout = "Updated"
            result.stderr = ""
            return result

        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_subprocess.run.side_effect = capture_run

            update_description("PROJ-1", "## Plan\n\nStep 1")

            # Find the captured ADF content
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
                desc_idx = cmd.index("--description-file") + 1
                captured_path.append(cmd[desc_idx])
                result = MagicMock()
                result.returncode = 0
                result.stdout = "Updated"
                result.stderr = ""
                return result

            mock_subprocess.run.side_effect = capture_run

            update_description("PROJ-1", "Plan content")

            # Temp file should have been cleaned up
            assert len(captured_path) == 1
            assert not os.path.exists(captured_path[0])

    def test_temp_file_cleaned_up_on_failure(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            captured_path = []

            def capture_run(cmd, **kwargs):
                desc_idx = cmd.index("--description-file") + 1
                captured_path.append(cmd[desc_idx])
                result = MagicMock()
                result.returncode = 1
                result.stdout = ""
                result.stderr = "Error: failed"
                return result

            mock_subprocess.run.side_effect = capture_run

            result = update_description("PROJ-1", "Plan content")

            assert result is False
            assert len(captured_path) == 1
            assert not os.path.exists(captured_path[0])

    def test_returns_false_on_acli_failure_output(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "subprocess") as mock_subprocess,
        ):
            mock_result = MagicMock()
            mock_result.returncode = 0  # acli returns 0 even on failure
            mock_result.stdout = "Failure: invalid ADF"
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            result = update_description("PROJ-1", "Plan content")

            assert result is False


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

            result = post_comment("PROJ-1", "## Comment\n\nSome details")

            assert result is True
            call_args = mock_subprocess.run.call_args
            cmd = call_args[0][0]
            assert "acli" in cmd
            assert "--body-file" in cmd
            body_file_idx = cmd.index("--body-file") + 1
            assert cmd[body_file_idx].endswith(".json")

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

    def test_temp_file_cleaned_up_on_failure(self):
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

    def test_returns_false_on_tempfile_error(self):
        with (
            patch.object(mod, "get_tracker_provider", return_value="jira"),
            patch.object(mod, "tempfile") as mock_tempfile,
        ):
            mock_tempfile.NamedTemporaryFile.side_effect = OSError("disk full")

            result = post_comment("PROJ-1", "Comment body")

            assert result is False
