#!/bin/bash
# A plugin can't ship permission rules, but a PreToolUse hook can answer for
# Claude Code. An agent changes its companion constantly to show its work, and
# watching other spaces means calling the supervision tools in a loop, so a
# prompt each time would stop it doing either. hooks.json lists which tools.
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Pappardelle companion and supervision tools are auto-approved"}}'
