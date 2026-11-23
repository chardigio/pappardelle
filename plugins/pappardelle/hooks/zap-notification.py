#!/usr/bin/env python3
"""
Claude Code hook to send ntfy push notifications when user input is needed.

Triggered by:
  - Notification with notification_type "permission_prompt" (Claude needs tool approval)
  - PreToolUse:AskUserQuestion (Claude is asking a question)

This lets Charlie get notified on his phone/iPad to go answer the prompt,
whether he is at the desk or remote in Termius over Tailscale SSH.

The hook used to fire only when it saw an active Tailscale SSH session in `w`
output. That probe missed real remote sessions, and a buzz is welcome at the
desk too, so STA-2041 removed it. `PAPPARDELLE_NTFY_TOPIC` is now the only
switch: leave it unset and the hook stays silent.
"""

import json
import os
import re
import subprocess
import sys

PAPPARDELLE_NTFY_TOPIC = os.environ.get("PAPPARDELLE_NTFY_TOPIC")
TERMIUS_DEEPLINK = "termius://terminal"


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


PERMISSION_PROMPT_TOOL = re.compile(r"permission to use (\S+)")


def permission_prompt_tool(message: str | None) -> str | None:
    """Read the tool name out of a permission_prompt message.

    The Notification event has no tool_name field. Its message reads
    "Claude needs your permission to use <Tool>".
    """
    match = PERMISSION_PROMPT_TOOL.search(message or "")
    return match.group(1).rstrip(".") if match else None


def main() -> None:
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    if not PAPPARDELLE_NTFY_TOPIC:
        sys.exit(0)

    hook_event = input_data.get("hook_event_name", "")
    tool_name = input_data.get("tool_name", "")

    if hook_event == "Notification" and input_data.get("notification_type") == "permission_prompt":
        # Not a PermissionRequest hook (STA-3151): Claude Code ignores
        # CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS while one exists.
        tool_name = permission_prompt_tool(input_data.get("message"))
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
