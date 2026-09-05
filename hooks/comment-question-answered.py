#!/usr/bin/env python3
"""
Claude Code hook to comment on issues when AskUserQuestion is answered.

This script is called by Claude Code PostToolUse hook after AskUserQuestion completes.
It creates a comment on the issue (Linear or Jira) with the question and answer for
documentation.

Supports:
- Linear (linctl): default provider
- Jira (acli): when .pappardelle.yml has issue_tracker.provider: jira
- Beads (bd): when .pappardelle.yml has issue_tracker.provider: beads

Usage:
    Called automatically by Claude Code hooks when AskUserQuestion tool completes.
    Reads JSON from stdin containing tool_input (questions) and tool_response (answers).
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

# Import shared helpers from sibling modules (same directory)
_hooks_dir = Path(__file__).parent

_adf_module_path = _hooks_dir / "markdown_to_adf.py"
_adf_spec = importlib.util.spec_from_file_location("markdown_to_adf", _adf_module_path)
if _adf_spec and _adf_spec.loader:
    _adf_mod = importlib.util.module_from_spec(_adf_spec)
    _adf_spec.loader.exec_module(_adf_mod)
    markdown_to_adf_json = _adf_mod.markdown_to_adf_json
else:
    raise ImportError(f"Could not load markdown_to_adf from {_adf_module_path}")

_acli_module_path = _hooks_dir / "acli_helpers.py"
_acli_spec = importlib.util.spec_from_file_location("acli_helpers", _acli_module_path)
if _acli_spec and _acli_spec.loader:
    _acli_mod = importlib.util.module_from_spec(_acli_spec)
    _acli_spec.loader.exec_module(_acli_mod)
    acli_succeeded = _acli_mod.acli_succeeded
else:
    raise ImportError(f"Could not load acli_helpers from {_acli_module_path}")

_tracker_module_path = _hooks_dir / "tracker_config.py"
_tracker_spec = importlib.util.spec_from_file_location("tracker_config", _tracker_module_path)
if _tracker_spec and _tracker_spec.loader:
    _tracker_mod = importlib.util.module_from_spec(_tracker_spec)
    _tracker_spec.loader.exec_module(_tracker_mod)
    find_issue_key = _tracker_mod.find_issue_key
    get_main_repo_root = _tracker_mod.get_main_repo_root
    get_tracker_provider = _tracker_mod.get_tracker_provider
else:
    raise ImportError(f"Could not load tracker_config from {_tracker_module_path}")


def get_issue_key() -> Optional[str]:
    """Get the issue key from cwd (assumes worktree naming convention).

    Expected path: ~/.worktrees/stardust-labs/STA-123/...
    """
    return find_issue_key()


def format_question_answer(tool_input: dict, tool_response: dict | str) -> str:
    """Format the question and answer as a markdown comment.

    Args:
        tool_input: The AskUserQuestion tool input containing questions and options
        tool_response: Either a dict with 'questions' and 'answers' keys (new format),
                      or a formatted string (legacy format)

    Returns:
        Formatted markdown string for the Linear comment
    """
    questions = tool_input.get("questions", [])
    if not questions:
        return ""

    lines = ["### 💬 Clarifying Question Answered", ""]

    # Extract answers from the response
    answers_map = {}

    # New format: tool_response is a dict with 'answers' key containing {question: answer} mapping
    if isinstance(tool_response, dict) and "answers" in tool_response:
        answers_map = tool_response.get("answers", {})
    # Legacy format: tool_response is a formatted string
    elif isinstance(tool_response, str) and "User has answered your questions:" in tool_response:
        # Extract the answers portion
        answers_text = tool_response.split("User has answered your questions:")[1].strip()
        # Parse key="value" pairs
        import re

        # Match patterns like "Question"="Answer"
        pattern = r'"([^"]+)"="([^"]+)"'
        matches = re.findall(pattern, answers_text)
        for question_text, answer_text in matches:
            answers_map[question_text] = answer_text

    for q in questions:
        question_text = q.get("question", "Unknown question")
        header = q.get("header", "")
        options = q.get("options", [])
        multi_select = q.get("multiSelect", False)

        # Add question with header
        if header:
            lines.append(f"❓ **{header}**: {question_text}")
        else:
            lines.append(f"❓ {question_text}")
        lines.append("")

        # Add options with indicators for selected answers
        answer = answers_map.get(question_text, "")

        if options:
            for opt in options:
                label = opt.get("label", "")
                description = opt.get("description", "")

                # Check if this option was selected
                is_selected = label == answer or (multi_select and label in answer)
                marker = "✅ " if is_selected else ""

                if description:
                    lines.append(f"- {marker}{label}: {description}")
                else:
                    lines.append(f"- {marker}{label}")
            lines.append("")

        # If the answer doesn't match any option, it's a custom "Other" response
        if answer and not any(opt.get("label") == answer for opt in options):
            lines.append(f"💡 **Answer**: {answer}")
        elif answer:
            lines.append(f"💡 **Answer**: {answer}")

    return "\n".join(lines)


def post_comment(issue_key: str, body: str) -> bool:
    """Post a comment to the configured issue tracker.

    Dispatches to linctl (Linear), acli (Jira), or bd (Beads) based on
    .pappardelle.yml config. Uses ADF formatting for Jira comments via
    --body-file with ADF JSON.

    Args:
        issue_key: The issue key (e.g., STA-123, PROJ-456, or bd-a1b2)
        body: The comment body in markdown

    Returns:
        True if successful, False otherwise
    """
    provider = get_tracker_provider()

    if provider == "beads":
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".md", prefix="pappardelle-comment-", delete=False
            ) as f:
                tmp_path = f.name
                f.write(body)
            cmd = ["bd"]
            repo_root = get_main_repo_root()
            if repo_root:
                cmd += ["-C", repo_root]
            cmd += ["comments", "add", issue_key, "-f", tmp_path]
        except OSError as e:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            print(f"Error creating temp file for beads comment: {e}", file=sys.stderr)
            return False
        not_found_msg = "bd not found - install beads (https://github.com/gastownhall/beads)"
    elif provider == "jira":
        # Convert markdown to ADF and write to temp file for --body-file
        adf_json = markdown_to_adf_json(body)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", prefix="pappardelle-comment-", delete=False
            ) as f:
                tmp_path = f.name
                f.write(adf_json)
            cmd = ["acli", "jira", "workitem", "comment", "create", "--key", issue_key, "--body-file", tmp_path]
        except OSError as e:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            print(f"Error creating temp file for ADF: {e}", file=sys.stderr)
            return False
        not_found_msg = "acli not found - install the Atlassian CLI"
    else:
        tmp_path = None
        cmd = ["linctl", "comment", "create", issue_key, "--body", body]
        not_found_msg = "linctl not found - install with: brew tap raegislabs/linctl && brew install linctl"

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if provider == "jira":
            return acli_succeeded(result)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print(f"Timeout posting comment via {provider}", file=sys.stderr)
        return False
    except FileNotFoundError:
        print(not_found_msg, file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error posting comment: {e}", file=sys.stderr)
        return False
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def main() -> None:
    # Read hook input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # Silent exit on invalid input

    # Only process PostToolUse events for AskUserQuestion
    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name", "")

    if hook_event != "PostToolUse" or tool_name != "AskUserQuestion":
        sys.exit(0)

    # Get the issue key from the workspace path
    issue_key = get_issue_key()
    if not issue_key:
        # Not in a Linear issue workspace, skip silently
        sys.exit(0)

    # Get the question/answer data
    tool_input = input_data.get("tool_input", {})
    tool_response = input_data.get("tool_response", "")

    # Format the comment - pass tool_response directly (may be dict or string)
    comment_body = format_question_answer(tool_input, tool_response)
    if not comment_body:
        sys.exit(0)

    # Post to Linear
    success = post_comment(issue_key, comment_body)
    if not success:
        # Non-blocking error - just log and continue
        print(f"Failed to post question/answer comment to {issue_key}", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never let hook failures propagate to Claude Code
        sys.exit(0)
