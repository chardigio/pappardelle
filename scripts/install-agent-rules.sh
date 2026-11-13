#!/usr/bin/env bash
# Agy has no flag for adding to its system prompt and doesn't show the model an
# MCP server's instructions, but it reads .agents/rules/ from where it starts.
# A rule in the worktree reaches only this space's agent, where a global rule
# would reach every agy session on the machine. Other agents get the rules at
# launch from agentRulesFlags() in source/companion-rules.ts, or from the server.
#
# Usage: install-agent-rules.sh <agent command> <worktree>

set -euo pipefail

command_word="${1%% *}"
[[ "$(basename "$command_word")" == "agy" ]] || exit 0

worktree="$2"
rules_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rule=".agents/rules/pappardelle.md"

mkdir -p "$worktree/.agents/rules"
{
    # agy silently discards a rule without a trigger.
    printf -- '---\ntrigger: always_on\n---\n\n'
    cat "$rules_dir/companion-rules.txt"
} > "$worktree/$rule"

exclude="$(git -C "$worktree" rev-parse --path-format=absolute --git-path info/exclude)"
if ! grep -qxF "$rule" "$exclude" 2>/dev/null; then
    mkdir -p "$(dirname "$exclude")"
    printf '%s\n' "$rule" >> "$exclude"
fi
