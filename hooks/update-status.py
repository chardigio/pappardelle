#!/usr/bin/env python3
"""
Claude Code hook to update Pappardelle status.
This script is called by Claude Code hooks to report status changes.

Follows Claude Island's event-forward model where every hook event updates state.

Usage:
    update-status.py <status> [--tool <tool_name>]

Status values:
    - processing: Claude is actively working
    - running_tool: Claude is using a tool
    - waiting_for_input: Claude finished turn / waiting for user
    - waiting_for_approval: Claude needs permission approval
    - compacting: Context window is being compacted
    - ended: Session terminated
    - error: An error occurred
"""

import json
import os
import subprocess
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

    # No issue key found — likely the main worktree. Detect branch name via git
    # and qualify with repo name to avoid collisions across repos
    # (e.g. "stardust-labs-master" instead of just "master").
    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if branch_result.returncode == 0:
            branch = branch_result.stdout.strip()
            if branch:
                # Try to get repo name from git toplevel
                try:
                    toplevel_result = subprocess.run(
                        ["git", "rev-parse", "--show-toplevel"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    if toplevel_result.returncode == 0:
                        repo_name = os.path.basename(toplevel_result.stdout.strip())
                        if repo_name:
                            return f"{repo_name}-{branch}"
                except Exception:
                    pass
                # Fall back to branch only if we can't determine repo name
                return branch
    except Exception:
        pass

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
    event: Optional[str] = None,
    cwd: Optional[str] = None,
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
    if event:
        state["event"] = event
    if cwd:
        state["cwd"] = cwd

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
        # Determine from hook event — follows Claude Island's event-forward model
        # where every event updates state uniformly without tool-specific special-casing
        hook_event = input_data.get("hook_event_name", "")
        tool_name = input_data.get("tool_name")

        if hook_event == "UserPromptSubmit":
            status = "processing"
        elif hook_event == "PreToolUse":
            status = "running_tool"
        elif hook_event == "PostToolUse":
            status = "processing"
        elif hook_event == "PermissionRequest":
            status = "waiting_for_approval"
        elif hook_event == "Stop":
            status = "waiting_for_input"
        elif hook_event == "SubagentStop":
            status = "waiting_for_input"
        elif hook_event == "SessionStart":
            status = "waiting_for_input"
        elif hook_event == "SessionEnd":
            status = "ended"
        elif hook_event == "PreCompact":
            status = "compacting"
        elif hook_event == "Notification":
            notification_type = input_data.get("notification_type")
            # Skip permission_prompt — PermissionRequest hook handles this
            if notification_type == "permission_prompt":
                sys.exit(0)
            elif notification_type == "idle_prompt":
                status = "waiting_for_input"
            else:
                sys.exit(0)
        else:
            # Unknown event, don't update status
            sys.exit(0)

    session_id = input_data.get("session_id", os.environ.get("CLAUDE_SESSION_ID"))
    event_name = input_data.get("hook_event_name")
    cwd = input_data.get("cwd")
    log_debug(f"Setting status to: {status} (tool={tool_name})")
    update_status(status, tool_name, session_id, event_name, cwd)

    # Exit successfully
    sys.exit(0)


if __name__ == "__main__":
    main()
