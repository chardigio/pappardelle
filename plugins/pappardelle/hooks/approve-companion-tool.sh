#!/bin/bash
# A plugin can't ship permission rules, but a PreToolUse hook can answer for
# Claude Code. An agent has to change the companion constantly to keep showing
# its work, and a prompt each time would stop it doing that.
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Pappardelle companion tools are auto-approved"}}'
