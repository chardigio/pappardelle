#!/usr/bin/env bash
# Tells an agent started in a Pappardelle space that it is in one. Claude Code
# adds SessionStart stdout to the session's context; outside a space this
# prints nothing.
set -euo pipefail

space="${PAPPARDELLE_SPACE:-}"
space="${space//[[:space:]]/}"
[[ -n "$space" ]] || exit 0

repo=""
if common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    repo=$(basename "$(dirname "$common_dir")")
fi

echo "You are in Pappardelle space ${space}${repo:+ (repo ${repo})}. Load the pappardelle-agent skill now, and keep the companion pane showing your work in progress."
