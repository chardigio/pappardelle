#!/usr/bin/env python3
"""
Claude Code hook to post accepted plans to issue trackers.

Triggers on PostToolUse for ExitPlanMode. When a plan is accepted:
- New issues (created by pappardelle/idow): sets plan as issue description
- Existing issues (resumed): adds plan as comment

Supports:
- Linear (linctl): default provider
- Jira (acli): when .pappardelle.yml has issue_tracker.provider: jira

Usage:
    Called automatically by Claude Code hooks when ExitPlanMode tool completes
    (i.e., user accepts the plan). Reads JSON from stdin containing hook event data.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional


def get_issue_key() -> Optional[str]:
    """Get issue key from cwd (assumes worktree naming convention).

    Expected path: ~/.worktrees/<repo>/<ISSUE-123>/...
    """
    cwd = os.getcwd()
    parts = cwd.split("/")

    for part in reversed(parts):
        if part and "-" in part:
            prefix = part.split("-")[0]
            suffix = part.split("-", 1)[1]
            if len(prefix) >= 2 and prefix.isupper() and prefix.isalpha() and suffix.isdigit():
                return part

    return None


def get_issue_meta_dir() -> Path:
    """Get the issue metadata directory."""
    return Path.home() / ".pappardelle" / "issue-meta"


def is_new_issue(issue_key: str) -> bool:
    """Check if this issue was created by pappardelle (new) vs already existed.

    Reads the metadata file written by idow at workspace creation time.
    If no metadata exists, assume the issue already existed (safe default).
    """
    meta_file = get_issue_meta_dir() / f"{issue_key}.json"
    if not meta_file.exists():
        return False
    try:
        with open(meta_file) as f:
            meta = json.load(f)
        return meta.get("created_by_pappardelle", False)
    except (json.JSONDecodeError, OSError):
        return False


def mark_plan_posted(issue_key: str) -> None:
    """Mark that a plan has been posted for this issue."""
    meta_dir = get_issue_meta_dir()
    meta_file = meta_dir / f"{issue_key}.json"
    meta = {}
    if meta_file.exists():
        try:
            with open(meta_file) as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    meta["plan_posted"] = True
    meta_dir.mkdir(parents=True, exist_ok=True)
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)


def extract_plan_from_transcript(transcript_path: str) -> Optional[str]:
    """Extract the plan content from the conversation transcript.

    Reads the JSONL transcript and looks for the plan content using two strategies:
    1. Find the last Write tool call (which wrote the plan file)
    2. Fall back to the last substantial assistant text message

    Returns the plan content string, or None if not found.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return None

    messages = []
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        messages.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except OSError:
        return None

    if not messages:
        return None

    # Strategy 1: Find the last Write tool call's content (the plan file)
    # Walk backward through messages to find the most recent Write
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content_blocks = msg.get("content", [])
        if not isinstance(content_blocks, list):
            continue

        for block in reversed(content_blocks):
            if block.get("type") == "tool_use" and block.get("name") == "Write":
                content = block.get("input", {}).get("content", "")
                if content and len(content) > 50:
                    return content

    # Strategy 2: Find the last substantial assistant text message
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content_blocks = msg.get("content", [])

        if isinstance(content_blocks, str) and len(content_blocks) > 100:
            return content_blocks

        if isinstance(content_blocks, list):
            text_parts = []
            for block in content_blocks:
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
            full_text = "\n".join(text_parts)
            if len(full_text) > 100:
                return full_text

    return None


def get_tracker_provider() -> str:
    """Get the issue tracker provider from .pappardelle.yml.

    Uses regex-based parsing to avoid requiring PyYAML dependency.
    Walks up from cwd to find the config file, then extracts the provider.

    Returns:
        "linear" (default) or "jira"
    """
    current = os.getcwd()
    for _ in range(20):
        candidate = os.path.join(current, ".pappardelle.yml")
        if os.path.isfile(candidate):
            try:
                with open(candidate) as f:
                    content = f.read()
                match = re.search(r"issue_tracker:\s*\n\s+provider:\s*(\w+)", content)
                if match:
                    return match.group(1).strip()
            except OSError:
                pass
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    return "linear"


def update_description(issue_key: str, plan_content: str) -> bool:
    """Update the issue description with the plan content.

    For new issues created by pappardelle, replaces the placeholder description
    with the actual implementation plan.
    """
    provider = get_tracker_provider()
    description = f"## Implementation Plan\n\n{plan_content}"

    if provider == "jira":
        cmd = [
            "acli",
            "jira",
            "workitem",
            "update",
            "--key",
            issue_key,
            "--description",
            description,
        ]
        not_found_msg = "acli not found - install the Atlassian CLI"
    else:
        cmd = [
            "linctl",
            "issue",
            "update",
            issue_key,
            "--description",
            description,
        ]
        not_found_msg = "linctl not found - install with: " "brew tap raegislabs/linctl && brew install linctl"

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print(f"Timeout updating description via {provider}", file=sys.stderr)
        return False
    except FileNotFoundError:
        print(not_found_msg, file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error updating description: {e}", file=sys.stderr)
        return False


def post_comment(issue_key: str, body: str) -> bool:
    """Post a comment to the configured issue tracker."""
    provider = get_tracker_provider()

    if provider == "jira":
        cmd = [
            "acli",
            "jira",
            "workitem",
            "comment",
            "--key",
            issue_key,
            "--body",
            body,
        ]
        not_found_msg = "acli not found - install the Atlassian CLI"
    else:
        cmd = ["linctl", "comment", "create", issue_key, "--body", body]
        not_found_msg = "linctl not found - install with: " "brew tap raegislabs/linctl && brew install linctl"

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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


def main() -> None:
    # Read hook input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    # Only process PostToolUse events for ExitPlanMode
    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name", "")

    if hook_event != "PostToolUse" or tool_name != "ExitPlanMode":
        sys.exit(0)

    # Get the issue key from the workspace path
    issue_key = get_issue_key()
    if not issue_key:
        # Not in an issue workspace, skip silently
        sys.exit(0)

    # Extract plan content from the conversation transcript
    transcript_path = input_data.get("transcript_path", "")
    plan_content = extract_plan_from_transcript(transcript_path)
    if not plan_content:
        print(
            "Could not extract plan content from transcript",
            file=sys.stderr,
        )
        sys.exit(0)

    # Determine whether to set description or add comment
    new_issue = is_new_issue(issue_key)

    if new_issue:
        # New issue created by pappardelle: replace placeholder description
        success = update_description(issue_key, plan_content)
        action = "description"
    else:
        # Existing issue being resumed: add plan as comment
        comment_body = f"### 📋 Implementation Plan Accepted\n\n{plan_content}"
        success = post_comment(issue_key, comment_body)
        action = "comment"

    if success:
        mark_plan_posted(issue_key)
    else:
        print(
            f"Failed to post plan as {action} to {issue_key}",
            file=sys.stderr,
        )

    sys.exit(0)


if __name__ == "__main__":
    main()
