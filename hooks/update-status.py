#!/usr/bin/env python3
"""
Claude Code hook to update Pappardelle status.
This script is called by Claude Code hooks to report status changes.

Usage:
    update-status.py <status> [--tool <tool_name>]

Status values:
    - thinking: Claude is processing
    - tool_use: Claude is using a tool
    - waiting_input: Claude is waiting for user input
    - waiting_permission: Claude needs permission approval
    - done: Claude finished the task
    - idle: Session is idle
    - error: An error occurred
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# Debug mode - logs all hook events to a file
# Set PAPPARDELLE_DEBUG=1 environment variable to enable logging
DEBUG = os.environ.get("PAPPARDELLE_DEBUG", "0") == "1"


def log_debug(message: str, data: Any = None) -> None:
    """Log debug information to a file."""
    if not DEBUG:
        return
    log_dir = Path.home() / ".pappardelle" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "hook-events.log"

    timestamp = datetime.now().isoformat()
    with open(log_file, "a") as f:
        f.write(f"[{timestamp}] {message}\n")
        if data:
            f.write(f"  Data: {json.dumps(data, indent=2)}\n")


# Get workspace name from cwd (assumes worktree naming convention)
def get_workspace_name() -> str:
    cwd = os.getcwd()
    parts = cwd.split("/")

    # Look for Linear issue pattern (e.g., STA-123) in path components
    # Expected path: ~/.worktrees/stardust-labs/STA-123/...
    for part in parts:
        if part and "-" in part:
            prefix = part.split("-")[0]
            suffix = part.split("-", 1)[1] if "-" in part else ""
            # Check if it looks like a Linear issue (e.g., STA-123, ABC-45)
            if prefix.isupper() and prefix.isalpha() and suffix.isdigit():
                return part

    return "unknown"


def get_status_dir() -> Path:
    """Get the status directory path.

    Uses PAPPARDELLE_STATUS_DIR env var if set, otherwise defaults to ~/.pappardelle/claude-status/.
    """
    env_dir = os.environ.get("PAPPARDELLE_STATUS_DIR")
    if env_dir:
        return Path(env_dir)
    return Path.home() / ".pappardelle" / "claude-status"


def update_status(
    status: str,
    tool_name: Optional[str] = None,
    session_id: Optional[str] = None,
) -> None:
    workspace = get_workspace_name()
    status_dir = get_status_dir()
    status_dir.mkdir(parents=True, exist_ok=True)

    status_file = status_dir / f"{workspace}.json"

    state: dict[str, Any] = {
        "sessionId": session_id or os.environ.get("CLAUDE_SESSION_ID", "unknown"),
        "workspaceName": workspace,
        "status": status,
        "lastUpdate": int(datetime.now().timestamp() * 1000),
    }

    if tool_name:
        state["currentTool"] = tool_name

    with open(status_file, "w") as f:
        json.dump(state, f, indent=2)


def main() -> None:
    # Read hook input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    log_debug(f"Hook invoked with argv={sys.argv}", input_data)

    # Determine status from command line args or hook event
    if len(sys.argv) > 1:
        status = sys.argv[1]
        tool_name: Optional[str] = None
        if "--tool" in sys.argv:
            tool_idx = sys.argv.index("--tool")
            if tool_idx + 1 < len(sys.argv):
                tool_name = sys.argv[tool_idx + 1]
    else:
        # Determine from hook event
        hook_event = input_data.get("hook_event_name", "")
        tool_name = input_data.get("tool_name")
        notification_type = input_data.get("notification_type", "")

        if hook_event == "PreToolUse":
            status = "tool_use"
        elif hook_event == "PostToolUse":
            # After AskUserQuestion, Claude is waiting for user input
            if tool_name == "AskUserQuestion":
                status = "waiting_input"
            else:
                status = "thinking"
        elif hook_event == "UserPromptSubmit":
            status = "thinking"
        elif hook_event == "Stop":
            status = "done"
        elif hook_event == "SessionStart":
            status = "idle"
        elif hook_event == "SessionEnd":
            status = "idle"
        elif hook_event == "Notification":
            # Check exact notification types (not substring matches)
            # NOTE: We ignore "permission_prompt" notifications because:
            # 1. PermissionRequest event already handles permission prompts with tool context
            # 2. AskUserQuestion also triggers "permission_prompt" notification but we want
            #    to show '?' not '!' for questions, which PermissionRequest handles correctly
            if notification_type == "idle_prompt":
                status = "waiting_input"
            else:
                # Other notifications (including permission_prompt) don't change status
                sys.exit(0)
        elif hook_event == "PermissionRequest":
            # AskUserQuestion triggers PermissionRequest but it's actually waiting for user input
            # not a permission approval, so show '?' instead of '!'
            if tool_name == "AskUserQuestion":
                status = "waiting_input"
            else:
                status = "waiting_permission"
        elif hook_event == "PreCompact":
            # During compaction, Claude is processing
            status = "thinking"
        elif hook_event == "SubagentStop":
            # Subagent stopping doesn't change parent session status
            sys.exit(0)
        else:
            # Unknown event, don't update status
            sys.exit(0)

    session_id = input_data.get("session_id", os.environ.get("CLAUDE_SESSION_ID"))
    log_debug(f"Setting status to: {status} (tool={tool_name})")
    update_status(status, tool_name, session_id)

    # Exit successfully
    sys.exit(0)


if __name__ == "__main__":
    main()
