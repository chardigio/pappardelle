#!/usr/bin/env python3
"""
The one status normalizer. Both Claude Code and Codex point their lifecycle
hooks at this script; it translates whichever native event fired into
Pappardelle's five-state vocabulary and writes a single normalized JSON file.

Usage (from a hook config):
    update-agent-status.py --agent claude
    update-agent-status.py --agent codex

The two harnesses publish the same event names, so the mapping below is one
table rather than one per agent. The only per-agent inputs are the name of the
tool that means "I'm asking the human a question" and whether the harness emits
Claude's extra ``Notification`` event — both read from AGENTS below.

Mirrors source/agents/registry.ts. The two tables are pinned to each other by
hooks/test_update_agent_status.py and source/agents/registry.test.ts; change one
and you must change the other.
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

SCHEMA_VERSION = 1

# Per-agent descriptors. Adding a harness means adding one entry here and one
# hook config example — nothing else in this file branches on the agent.
AGENTS: dict[str, dict[str, Any]] = {
    "claude": {
        "question_tool": "AskUserQuestion",
        "has_notification_event": True,
    },
    "codex": {
        "question_tool": "request_user_input",
        "has_notification_event": False,
    },
}

DEFAULT_AGENT = "claude"

# Events that mean "the agent has the ball". Thinking and tool execution are
# deliberately consolidated: both render the same spinner, and the distinction
# is the one a new harness is least likely to be able to draw honestly.
WORKING_EVENTS = frozenset(
    {
        "UserPromptSubmit",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "SubagentStart",
    }
)

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


def map_event_to_state(
    agent: str,
    hook_event: str,
    tool_name: Optional[str] = None,
    notification_type: Optional[str] = None,
) -> Optional[str]:
    """Translate a native hook event into the normalized vocabulary.

    Returns None for events that must not write at all: an unrecognized event,
    or Claude's ``permission_prompt`` notification, which duplicates the
    ``PermissionRequest`` event that already wrote a better-decorated status.
    """
    descriptor = AGENTS.get(agent, AGENTS[DEFAULT_AGENT])
    is_question = tool_name is not None and tool_name == descriptor["question_tool"]

    if hook_event in WORKING_EVENTS:
        return "working"
    if hook_event == "PreToolUse":
        return "needs-answer" if is_question else "working"
    if hook_event == "PermissionRequest":
        # A permission prompt raised *for* the question tool is still a question
        # as far as the human is concerned.
        return "needs-answer" if is_question else "needs-approval"
    if hook_event in ("Stop", "SubagentStop"):
        return "done"
    if hook_event in ("SessionStart", "SessionEnd"):
        return "idle"
    if hook_event == "Notification":
        if not descriptor["has_notification_event"]:
            return None
        return "done" if notification_type == "idle_prompt" else None
    return None


def get_status_key(cwd: Optional[str] = None) -> str:
    """Derive the space's status key from the working directory.

    Issue worktrees are named for their issue key (``~/.worktrees/repo/STA-123``).
    Anything else is the main worktree, whose key is repo-qualified so two
    checkouts both sitting on ``main`` don't collide in the status directory.
    """
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            return "unknown"
    parts = cwd.split("/")

    # Look for an issue-key path component (e.g. STA-123, ABC-45)
    for part in parts:
        if part and "-" in part:
            prefix = part.split("-")[0]
            suffix = part.split("-", 1)[1]
            if prefix.isupper() and prefix.isalpha() and suffix.isdigit():
                return part

    # No issue key — likely the main worktree. Qualify the branch with the repo
    # name to avoid collisions across repos ("stardust-labs-master", not "master").
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
                            return f"{repo_name}-{branch}"
                except Exception:
                    pass
                return branch
    except Exception:
        pass

    return "unknown"


def get_status_dir() -> Path:
    """Status directory, overridable via PAPPARDELLE_STATUS_DIR for tests."""
    env_dir = os.environ.get("PAPPARDELLE_STATUS_DIR")
    if env_dir:
        return Path(env_dir)
    return Path.home() / ".pappardelle" / "agent-status"


def write_status(
    agent: str,
    state: str,
    status_key: str,
    session_id: Optional[str] = None,
    cwd: Optional[str] = None,
    decoration: Optional[dict[str, Any]] = None,
) -> None:
    status_dir = get_status_dir()
    status_dir.mkdir(parents=True, exist_ok=True)
    status_file = status_dir / f"{status_key}.json"

    payload: dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "agent": agent,
        "state": state,
        "statusKey": status_key,
        "lastUpdate": int(datetime.now().timestamp() * 1000),
    }
    if session_id:
        payload["sessionId"] = session_id
    if cwd:
        payload["cwd"] = cwd
    trimmed = {k: v for k, v in (decoration or {}).items() if v}
    if trimmed:
        payload["decoration"] = trimmed

    # Atomic write: temp file then rename. POSIX rename is atomic, so a
    # concurrent reader always sees either the previous complete file or the new
    # complete file — never a truncated one. If the write raises before the
    # rename, clean up the orphan so the status dir doesn't accumulate junk.
    tmp_file = status_dir / f"{status_key}.json.tmp.{os.getpid()}"
    try:
        with open(tmp_file, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp_file, status_file)
    except Exception:
        try:
            tmp_file.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--agent", default=DEFAULT_AGENT, choices=sorted(AGENTS))
    # An explicit state, for callers that already know it (tests, manual pokes).
    parser.add_argument("--state", default=None)
    parser.add_argument("--tool", default=None)
    args, _unknown = parser.parse_known_args()

    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        input_data = {}
    if not isinstance(input_data, dict):
        input_data = {}

    log_debug(f"Hook invoked with argv={sys.argv}", input_data)

    hook_event = input_data.get("hook_event_name", "")
    tool_name = args.tool or input_data.get("tool_name")

    if args.state:
        state: Optional[str] = args.state
    else:
        state = map_event_to_state(
            args.agent,
            hook_event,
            tool_name,
            input_data.get("notification_type"),
        )

    # Unrecognized event — leave whatever the last real event wrote alone.
    if state is None:
        sys.exit(0)

    cwd = input_data.get("cwd")
    session_id = input_data.get("session_id") or os.environ.get("CLAUDE_SESSION_ID")

    log_debug(f"Setting {args.agent} state to: {state} (tool={tool_name})")
    write_status(
        args.agent,
        state,
        get_status_key(cwd),
        session_id,
        cwd,
        {
            "tool": tool_name,
            "model": input_data.get("model"),
            "event": hook_event or None,
        },
    )

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Never let hook failures propagate to the agent.
        sys.exit(0)
