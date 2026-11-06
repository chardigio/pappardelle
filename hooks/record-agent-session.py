#!/usr/bin/env python3
"""
Agent hook that records the agent's session id for its space (see
agent_session.py). For agents with Claude Code-style hooks other than Claude,
which records through update-status.py: register it for SessionStart and
UserPromptSubmit, with session_id in the payload. agy registers it for
SessionStart and PreInvocation and sends conversationId instead.
"""

import importlib.util
import json
import sys
from pathlib import Path

_agent_session_module_path = Path(__file__).parent / "agent_session.py"

if __name__ == "__main__":
    try:
        spec = importlib.util.spec_from_file_location("agent_session", _agent_session_module_path)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            payload = json.load(sys.stdin)
            if isinstance(payload, dict) and "conversationId" in payload:
                # agy reads a hook's stdout as its JSON result.
                print("{}")
            module.record_agent_session(payload, is_claude_hook=False)
    except Exception:
        # Never let hook failures reach the agent.
        pass
    sys.exit(0)
