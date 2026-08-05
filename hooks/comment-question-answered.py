#!/usr/bin/env python3
"""
Comment on the issue when the agent's question tool is answered.

Called from a PostToolUse hook. It creates a comment on the issue (Linear or
Jira) recording the question and the answer, so the decision is documented
where the work is tracked rather than only in a scrollback buffer.

Supports:
- Linear (linctl): default provider
- Jira (acli): when .pappardelle.yml has issue_tracker.provider: jira

Per-agent behavior lives in QUESTION_TOOLS + the FORMATTERS shim below. Claude's
AskUserQuestion payload is fully understood and renders the multiple-choice
options with the chosen one checked. Codex's request_user_input payload shape
isn't pinned down yet, so its formatter is deliberately best-effort: when it
can't recognize the shape it returns nothing and the hook no-ops, which is the
correct degradation — a Codex space simply doesn't get the comment rather than
the hook erroring or posting garbage into the issue.

Usage (from a hook config):
    comment-question-answered.py --agent claude
    comment-question-answered.py --agent codex
"""

import argparse
import importlib.util
import json
import os
import re as _re_module
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

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


def get_issue_key() -> Optional[str]:
    """Get Linear issue key from cwd (assumes worktree naming convention).

    Expected path: ~/.worktrees/stardust-labs/STA-123/...
    """
    try:
        cwd = os.getcwd()
    except OSError:
        return None
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


# Which tool means "the agent is asking the human a question", per harness.
# Mirrors `questionTool` in source/agents/registry.ts.
QUESTION_TOOLS = {
    "claude": "AskUserQuestion",
    "codex": "request_user_input",
}


# Annotated Any rather than dict/str: this is hook payload off a wire we do not
# control, so the runtime isinstance guards below are the real contract. Typing
# it tighter would make mypy prune those guards as unreachable.
def format_codex_question_answer(tool_input: Any, tool_response: Any) -> str:
    """Best-effort rendering of Codex's request_user_input payload.

    Codex's exact payload shape isn't documented, so this recognizes the two
    plausible spellings and otherwise returns "" so the caller no-ops. It must
    never raise or guess: a wrong comment on the issue is worse than no comment.
    """
    if not isinstance(tool_input, dict):
        return ""

    # Shape A: the same {"questions": [...]} envelope Claude uses.
    if isinstance(tool_input.get("questions"), list):
        return format_question_answer(tool_input, tool_response)

    # Shape B: a single free-text prompt.
    prompt = tool_input.get("prompt") or tool_input.get("question")
    if not isinstance(prompt, str) or not prompt.strip():
        return ""

    # Typed as object, not str: the annotation says dict | str but this is hook
    # input off a wire we don't control, and a dict .get() can hand back
    # anything. Narrowing with isinstance is the check that makes it a str.
    raw_answer: object
    if isinstance(tool_response, dict):
        raw_answer = tool_response.get("answer") or tool_response.get("response")
    else:
        raw_answer = tool_response
    if not isinstance(raw_answer, str) or not raw_answer.strip():
        return ""
    answer = raw_answer

    return "\n".join(
        [
            "### 💬 Clarifying Question Answered",
            "",
            f"❓ {prompt.strip()}",
            "",
            f"💡 **Answer**: {answer.strip()}",
        ]
    )


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


def get_tracker_provider() -> str:
    """Get the issue tracker provider from .pappardelle.yml.

    Uses regex-based parsing to avoid requiring PyYAML dependency.
    Walks up from cwd to find the config file, then extracts the provider.

    Returns:
        "linear" (default) or "jira"
    """
    # Walk up directories to find .pappardelle.yml
    try:
        current = os.getcwd()
    except OSError:
        return "linear"
    config_path = None
    for _ in range(20):  # max depth to prevent infinite loop
        candidate = os.path.join(current, ".pappardelle.yml")
        if os.path.isfile(candidate):
            config_path = candidate
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    if not config_path:
        return "linear"

    try:
        with open(config_path) as f:
            content = f.read()
        # Look for issue_tracker.provider value using regex
        # Matches patterns like:
        #   issue_tracker:
        #     provider: jira
        match = _re_module.search(r"issue_tracker:\s*\n\s+provider:\s*(\w+)", content)
        if match:
            return match.group(1).strip()
    except OSError:
        pass

    return "linear"


def post_comment(issue_key: str, body: str) -> bool:
    """Post a comment to the configured issue tracker.

    Dispatches to linctl (Linear) or acli (Jira) based on .pappardelle.yml config.
    Uses ADF formatting for Jira comments via --body-file with ADF JSON.

    Args:
        issue_key: The issue key (e.g., STA-123 or PROJ-456)
        body: The comment body in markdown

    Returns:
        True if successful, False otherwise
    """
    provider = get_tracker_provider()

    if provider == "jira":
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
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--agent", default="claude", choices=sorted(QUESTION_TOOLS))
    args, _unknown = parser.parse_known_args()

    # Read hook input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # Silent exit on invalid input

    # Only process PostToolUse events for this agent's question tool
    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name", "")

    if hook_event != "PostToolUse" or tool_name != QUESTION_TOOLS[args.agent]:
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
    formatter = FORMATTERS[args.agent]
    comment_body = formatter(tool_input, tool_response)
    if not comment_body:
        # Unrecognized payload shape (expected for Codex today) — degrade to a
        # no-op rather than posting something half-parsed.
        sys.exit(0)

    # Post to Linear
    success = post_comment(issue_key, comment_body)
    if not success:
        # Non-blocking error - just log and continue
        print(f"Failed to post question/answer comment to {issue_key}", file=sys.stderr)

    sys.exit(0)


# Per-agent payload formatters. Declared after both functions exist.
FORMATTERS = {
    "claude": format_question_answer,
    "codex": format_codex_question_answer,
}


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Never let hook failures propagate to the agent.
        sys.exit(0)
