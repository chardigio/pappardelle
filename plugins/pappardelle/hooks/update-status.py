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

import importlib.util
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

_agent_session_module_path = Path(__file__).parent / "agent_session.py"
_agent_session_spec = importlib.util.spec_from_file_location("agent_session", _agent_session_module_path)
if _agent_session_spec and _agent_session_spec.loader:
    _agent_session_mod = importlib.util.module_from_spec(_agent_session_spec)
    _agent_session_spec.loader.exec_module(_agent_session_mod)
    record_agent_session = _agent_session_mod.record_agent_session
else:
    raise ImportError("Could not load agent_session")

_state_db_module_path = Path(__file__).parent / "state_db.py"
_state_db_spec = importlib.util.spec_from_file_location("state_db", _state_db_module_path)
if _state_db_spec and _state_db_spec.loader:
    _state_db_mod = importlib.util.module_from_spec(_state_db_spec)
    _state_db_spec.loader.exec_module(_state_db_mod)
    status_socket_path = _state_db_mod.status_socket_path
    state_db_path = _state_db_mod.state_db_path
    space_at_path = _state_db_mod.space_at_path
else:
    raise ImportError("Could not load state_db")


def send_status(path: str, state: dict[str, Any]) -> bool:
    """Send one hook event to the status daemon. True when it was sent."""
    spec = importlib.util.spec_from_file_location("status_socket", Path(__file__).parent / "status_socket.py")
    if not (spec and spec.loader):
        raise ImportError("Could not load status_socket")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.send_status(path, state)


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


def _qualify(repo_name: str, name: str) -> str:
    # As hookStatusKey in source/claude-status.ts.
    return f"{repo_name}-{name}".replace("/", "-")


def get_workspace_name(cwd: Optional[str] = None) -> Optional[str]:
    """The status key: the space's key qualified by repo, since two repos can
    have spaces with the same key. Mirrors hookStatusKey() in
    source/claude-status.ts.

    The space is the stored one whose worktree holds cwd, and main reports
    under its key like any space. None when no stored space holds cwd:
    nothing reads a status from outside one.
    """
    # The session's repo, set by start-agent-session.sh and the TUI. It is the
    # name the TUI reads under.
    repo = os.environ.get("PAPPARDELLE_REPO", "").strip()
    # The space this pane belongs to, set on the tmux session by
    # start-agent-session.sh. It wins over the cwd: a Claude resumed from
    # another directory inside the pane still reports under the space shown.
    space = os.environ.get("PAPPARDELLE_SPACE", "").strip()
    if space:
        return _qualify(repo, space) if repo else space
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            # A deleted worktree, which no stored space holds.
            return None
    row = space_at_path(state_db_path(), cwd)
    return _qualify(row.repo, row.key) if row else None


def hook_scratch_dir() -> Path:
    """Where the hook keeps what it needs between events of one agent."""
    return _state_db_mod.state_dir() / "hook-scratch"


def update_status(
    status: str,
    tool_name: Optional[str] = None,
    session_id: Optional[str] = None,
    event: Optional[str] = None,
    cwd: Optional[str] = None,
    pending_files: Optional[list[str]] = None,
    workspace: Optional[str] = None,
) -> None:
    workspace = workspace or get_workspace_name(cwd)
    if workspace is None:
        return

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
    if pending_files:
        state["pendingFiles"] = pending_files

    send_status(status_socket_path(), state)


FILE_TOOLS = {"Edit", "MultiEdit", "Write", "Read", "NotebookEdit"}


def pending_dir(workspace: str) -> Path:
    return hook_scratch_dir() / "pending-files" / workspace


def track_pending_file(input_data: dict[str, Any], workspace: str) -> Optional[list[str]]:
    """Keep the files of the file-tool calls that haven't finished yet.

    A permission prompt's Notification doesn't say which file it is for, so
    the supervisor that answers it matches the file name on screen against
    these. One entry per call, so parallel calls never write the same file.
    """
    event = input_data.get("hook_event_name")
    directory = pending_dir(workspace)
    call = str(input_data.get("tool_use_id") or "")
    if event == "PreToolUse" and input_data.get("tool_name") in FILE_TOOLS and call:
        tool_input = input_data.get("tool_input")
        target = None
        if isinstance(tool_input, dict):
            target = tool_input.get("file_path") or tool_input.get("notebook_path")
        if isinstance(target, str) and target:
            directory.mkdir(parents=True, exist_ok=True)
            (directory / call).write_text(os.path.normpath(os.path.join(input_data.get("cwd") or "/", target)))
    elif event in ("PostToolUse", "PostToolUseFailure") and call:
        (directory / call).unlink(missing_ok=True)
    # Not on Stop: background subagents keep calling tools after the main turn ends.
    elif event in ("UserPromptSubmit", "SessionStart", "SessionEnd") and directory.exists():
        for entry in directory.iterdir():
            entry.unlink(missing_ok=True)
    elif event == "Notification" and input_data.get("notification_type") == "permission_prompt" and directory.exists():
        return sorted({entry.read_text() for entry in directory.iterdir()})
    return None


PERMISSION_PROMPT_TOOL = re.compile(r"permission to use (\S+)")


def permission_prompt_tool(message: Optional[str]) -> Optional[str]:
    """Read the tool name out of a permission_prompt message.

    The Notification event has no tool_name field. Its message reads
    "Claude needs your permission to use <Tool>", and the UI needs the tool to
    tell an AskUserQuestion dialog from a real permission prompt.
    """
    match = PERMISSION_PROMPT_TOOL.search(message or "")
    return match.group(1).rstrip(".") if match else None


def main() -> None:
    # Read hook input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    log_debug(f"Hook invoked with argv={sys.argv}", input_data)

    # Claude already runs this hook on every event, so it records Claude's
    # session id here rather than through a second hook entry.
    try:
        record_agent_session(input_data, is_claude_hook=True)
    except Exception as e:
        log_debug(f"Recording the agent session failed: {e}")

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
        elif hook_event in ("PostToolUse", "PostToolUseFailure"):
            status = "processing"
        elif hook_event == "Stop":
            status = "waiting_for_input"
        elif hook_event == "SubagentStop":
            # Claude's own helper agents stop with no agent_type, often while
            # a permission prompt is up; reporting that would replace the
            # prompt's record, which the supervisor reads its file from.
            if not input_data.get("agent_type"):
                sys.exit(0)
            status = "waiting_for_input"
        elif hook_event == "SessionStart":
            status = "waiting_for_input"
        elif hook_event == "SessionEnd":
            status = "ended"
        elif hook_event == "PreCompact":
            status = "compacting"
        elif hook_event == "Notification":
            notification_type = input_data.get("notification_type")
            # The plugin has no PermissionRequest hook (STA-3151): Claude Code ignores
            # CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS while one exists. This
            # notification marks the same moment, and names the tool only in its text.
            if notification_type == "permission_prompt":
                status = "waiting_for_approval"
                tool_name = permission_prompt_tool(input_data.get("message"))
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
    pending_files = None
    workspace = get_workspace_name(cwd)
    if workspace is not None:
        try:
            pending_files = track_pending_file(input_data, workspace)
        except OSError as e:
            log_debug(f"Tracking pending files failed: {e}")
    log_debug(f"Setting status to: {status} (tool={tool_name})")
    if workspace is not None:
        update_status(status, tool_name, session_id, event_name, cwd, pending_files, workspace)

    # Exit successfully
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never let hook failures propagate to Claude Code
        sys.exit(0)
