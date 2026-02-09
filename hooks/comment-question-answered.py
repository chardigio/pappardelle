#!/usr/bin/env python3
"""
Claude Code hook to comment on Linear issues when AskUserQuestion is answered.

This script is called by Claude Code PostToolUse hook after AskUserQuestion completes.
It creates a comment on the Linear issue with the question and answer for documentation.

Usage:
    Called automatically by Claude Code hooks when AskUserQuestion tool completes.
    Reads JSON from stdin containing tool_input (questions) and tool_response (answers).
"""

import json
import os
import subprocess
import sys
from typing import Optional


def get_issue_key() -> Optional[str]:
    """Get Linear issue key from cwd (assumes worktree naming convention).

    Expected path: ~/.worktrees/stardust-labs/STA-123/...
    """
    cwd = os.getcwd()
    parts = cwd.split("/")

    # Look for Linear issue pattern (e.g., STA-123) in path components
    for part in parts:
        if part and "-" in part:
            prefix = part.split("-")[0]
            suffix = part.split("-", 1)[1] if "-" in part else ""
            # Check if it looks like a Linear issue (e.g., STA-123, ABC-45)
            if prefix.isupper() and prefix.isalpha() and suffix.isdigit():
                return part

    return None


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
    """Post a comment to Linear using linctl.

    Args:
        issue_key: The Linear issue key (e.g., STA-123)
        body: The comment body in markdown

    Returns:
        True if successful, False otherwise
    """
    try:
        result = subprocess.run(
            ["linctl", "comment", "create", issue_key, "--body", body],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print("Timeout posting comment to Linear", file=sys.stderr)
        return False
    except FileNotFoundError:
        print("linctl not found - install with: brew tap raegislabs/linctl && brew install linctl", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error posting comment: {e}", file=sys.stderr)
        return False


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
    main()
