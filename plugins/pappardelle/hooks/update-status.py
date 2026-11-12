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
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

_tracker_module_path = Path(__file__).parent / "tracker_config.py"
_tracker_spec = importlib.util.spec_from_file_location("tracker_config", _tracker_module_path)
if _tracker_spec and _tracker_spec.loader:
    _tracker_mod = importlib.util.module_from_spec(_tracker_spec)
    _tracker_spec.loader.exec_module(_tracker_mod)
    find_issue_key = _tracker_mod.find_issue_key
else:
    raise ImportError(f"Could not load tracker_config from {_tracker_module_path}")

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
else:
    raise ImportError("Could not load state_db")

_status_socket_module_path = Path(__file__).parent / "status_socket.py"
_status_socket_spec = importlib.util.spec_from_file_location("status_socket", _status_socket_module_path)
if _status_socket_spec and _status_socket_spec.loader:
    _status_socket_mod = importlib.util.module_from_spec(_status_socket_spec)
    _status_socket_spec.loader.exec_module(_status_socket_mod)
    send_status = _status_socket_mod.send_status
else:
    raise ImportError("Could not load status_socket")

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
    # branch names may carry a slash (user/TICKET-1); keep the status file flat
    return f"{repo_name}-{name}".replace("/", "-")


def get_workspace_name(cwd: Optional[str] = None) -> str:
    """The status file name: the space key, or the main checkout's branch,
    qualified by repo. Two repos can have spaces with the same key, and all of
    them write to one status directory. Mirrors hookStatusKey() in
    source/claude-status.ts."""
    # The session's repo, set by start-agent-session.sh and the TUI. It is the
    # name the TUI reads under, which the cwd-derived name can differ from.
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
            return "unknown"
    # Expected path: ~/.worktrees/stardust-labs/STA-123/...
    issue_key = find_issue_key(cwd)
    if issue_key:
        return _qualify(repo, issue_key) if repo else issue_key

    # No issue key found — likely the main worktree. Detect branch name via git
    # and qualify with repo name (e.g. "stardust-labs-master").
    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if branch_result.returncode == 0:
            branch = branch_result.stdout.strip()
            if branch:
                if repo:
                    return _qualify(repo, branch)
                try:
                    toplevel_result = subprocess.run(
                        ["git", "rev-parse", "--show-toplevel"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                        cwd=cwd,
                    )
                    if toplevel_result.returncode == 0:
                        repo_name = os.path.basename(toplevel_result.stdout.strip())
                        if repo_name:
                            return _qualify(repo_name, branch)
                except Exception:
                    pass
                # Fall back to branch only if we can't determine repo name
                return branch.replace("/", "-")
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
    workspace = get_workspace_name(cwd)
    status_file = get_status_dir() / f"{workspace}.json"

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

    socket_path = status_socket_path()
    if socket_path is None:
        write_status_file(status_file, state)
    elif send_status(socket_path, state):
        # A file from before the flag was turned on. Left in place, it is
        # what this space would show once the flag is turned off again.
        status_file.unlink(missing_ok=True)


def write_status_file(status_file: Path, state: dict[str, Any]) -> None:
    status_file.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: write to a sibling temp file then rename. POSIX rename is
    # atomic, so a concurrent reader always sees either the previous complete
    # file or the new complete file — never a truncated one. If the write
    # raises (disk full, permission denied) before the rename, clean up the
    # orphan so the status dir doesn't accumulate junk across crashes.
    tmp_file = status_file.parent / f"{status_file.name}.tmp.{os.getpid()}"
    try:
        with open(tmp_file, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_file, status_file)
    except Exception:
        try:
            tmp_file.unlink(missing_ok=True)
        except OSError:
            pass
        raise


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
    try:
        main()
    except Exception:
        # Never let hook failures propagate to Claude Code
        sys.exit(0)
