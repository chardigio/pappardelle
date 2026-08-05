#!/usr/bin/env python3
"""
Send an ntfy push notification when an agent is blocked on the human, but only
when connected via a Tailscale SSH session.

Driven off the *normalized* state rather than any harness's event names, so a
Codex space zaps exactly like a Claude one: the hook maps its native event
through the shared table and fires on the two blocked states —
``needs-approval`` and ``needs-answer``. Anything else is silent.

This lets Charlie get notified on his phone/iPad to go answer the prompt in
Termius when working remotely via Tailscale SSH.

Usage (from a hook config):
    zap-notification.py --agent claude
    zap-notification.py --agent codex
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

PAPPARDELLE_NTFY_TOPIC = os.environ.get("PAPPARDELLE_NTFY_TOPIC")
TERMIUS_DEEPLINK = "termius://terminal"

# Reuse the normalizer's event table so the two hooks can never disagree about
# what counts as "blocked on the human".
_normalizer_path = Path(__file__).parent / "update-agent-status.py"
_spec = importlib.util.spec_from_file_location("update_agent_status", _normalizer_path)
if _spec and _spec.loader:
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    map_event_to_state = _mod.map_event_to_state
    AGENTS = _mod.AGENTS
else:
    raise ImportError(f"Could not load update-agent-status from {_normalizer_path}")

DISPLAY_NAMES = {"claude": "Claude", "codex": "Codex"}


def is_tailscale_ssh_active() -> bool:
    """Check if there's an active Tailscale SSH session.

    Looks for sessions from Tailscale's CGNAT range (100.x.x.x)
    with less than 1 day idle time. Parses `w` output in Python
    for reliable cross-platform behavior.
    """
    try:
        result = subprocess.run(["w"], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return False
        for line in result.stdout.splitlines():
            # Skip header lines
            if not line.strip() or line.startswith("USER") or "load average" in line:
                continue
            # Check for Tailscale CGNAT range in the FROM column
            if "100." not in line:
                continue
            # Filter out sessions idle for days
            if "days" in line:
                continue
            # Session from Tailscale IP with < 1 day idle — active enough
            return True
        return False
    except Exception:
        return False


def send_zap(message: str) -> None:
    """Send a push notification via ntfy.sh with Termius deeplink."""
    try:
        subprocess.run(
            [
                "curl",
                "-s",
                "-d",
                message,
                "-H",
                f"Click: {TERMIUS_DEEPLINK}",
                f"ntfy.sh/{PAPPARDELLE_NTFY_TOPIC}",
            ],
            capture_output=True,
            timeout=10,
        )
    except Exception:
        pass


def build_message(agent: str, state: str, tool_name: Optional[str]) -> Optional[str]:
    """Notification copy for a blocked state, or None when nothing should fire.

    The agent is named so a phone buzzing at 11pm says which harness wants
    something — with two of them running, "Claude needs permission" and "Codex
    needs permission" send Charlie to different panes.
    """
    name = DISPLAY_NAMES.get(agent, agent)
    if state == "needs-approval":
        if tool_name:
            return f"{name} needs permission for {tool_name}"
        return f"{name} needs permission"
    if state == "needs-answer":
        return f"{name} is asking a question"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--agent", default="claude", choices=sorted(AGENTS))
    args, _unknown = parser.parse_known_args()

    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        input_data = {}
    if not isinstance(input_data, dict):
        input_data = {}

    if not PAPPARDELLE_NTFY_TOPIC or not is_tailscale_ssh_active():
        sys.exit(0)

    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name")

    # De-dupe the question. Claude raises PermissionRequest *and* PreToolUse for
    # AskUserQuestion, and both events are wired to this hook — mapping both to
    # needs-answer would buzz the phone twice for one question. PreToolUse is
    # the one that always fires, so it owns the zap.
    if hook_event == "PermissionRequest" and tool_name == AGENTS[args.agent]["question_tool"]:
        sys.exit(0)

    state = map_event_to_state(
        args.agent,
        hook_event,
        tool_name,
        input_data.get("notification_type"),
    )

    message = build_message(args.agent, state or "", tool_name)
    if message:
        send_zap(message)

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Never let hook failures propagate to the agent.
        sys.exit(0)
