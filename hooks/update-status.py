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


# Get workspace name from cwd (assumes worktree naming convention)
def get_workspace_name() -> str:
    cwd = os.getcwd()
    # Try to extract workspace name from path like /Users/charlie/cs/dow-worktrees/STA-316
    parts = cwd.split("/")
    for i, part in enumerate(parts):
        if part == "dow-worktrees" and i + 1 < len(parts):
            return parts[i + 1]
    # Fallback: use the last directory component if it looks like a Linear issue
    last_part = parts[-1] if parts else ""
    if last_part and "-" in last_part and last_part.split("-")[0].isupper():
        return last_part
    return "unknown"


def update_status(
    status: str,
    tool_name: Optional[str] = None,
    session_id: Optional[str] = None,
) -> None:
    workspace = get_workspace_name()
    status_dir = Path.home() / ".pappardelle" / "claude-status"
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
        tool_name = input_data.get("tool_name", "")

        if hook_event == "PreToolUse":
            status = "tool_use"
        elif hook_event == "PostToolUse":
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
            # Check if it's a permission request
            notification_type = input_data.get("notification_type", "")
            if "permission" in notification_type.lower():
                status = "waiting_permission"
            else:
                status = "waiting_input"
        else:
            status = "unknown"

    session_id = input_data.get("session_id", os.environ.get("CLAUDE_SESSION_ID"))
    update_status(status, tool_name, session_id)

    # Exit successfully
    sys.exit(0)


if __name__ == "__main__":
    main()
