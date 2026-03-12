#!/usr/bin/env python3
"""
Claude Code hook to send ntfy push notifications when user input is needed,
but only when connected via a Tailscale SSH session.

Triggered by:
  - PermissionRequest (Claude needs tool approval)
  - PreToolUse:AskUserQuestion (Claude is asking a question)

This lets Charlie get notified on his phone/iPad to go answer the prompt
in Termius when working remotely via Tailscale SSH.
"""

import json
import os
import subprocess
import sys

PAPPARDELLE_NTFY_TOPIC = os.environ.get("PAPPARDELLE_NTFY_TOPIC")
TERMIUS_DEEPLINK = "termius://terminal"


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


def main() -> None:
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    if not PAPPARDELLE_NTFY_TOPIC or not is_tailscale_ssh_active():
        sys.exit(0)

    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name", "")

    if hook_event == "PermissionRequest":
        # AskUserQuestion is handled by PreToolUse hook, not a real permission
        if tool_name == "AskUserQuestion":
            sys.exit(0)
        msg = "Claude needs permission"
        if tool_name:
            msg += f" for {tool_name}"
        send_zap(msg)
    elif hook_event == "PreToolUse" and tool_name == "AskUserQuestion":
        send_zap("Claude is asking a question")

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never let hook failures propagate to Claude Code
        sys.exit(0)
