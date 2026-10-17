#!/bin/bash
# Merge Pappardelle's session hook into ~/.gemini/config/hooks.json, agy's
# global hooks file, so a relaunch resumes the space's own conversation. agy
# names each hook, so only the pappardelle-session entry is written; the file
# usually carries other tools' hooks.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGY_CONFIG="$HOME/.gemini/config"
AGY_HOOKS="$AGY_CONFIG/hooks.json"

if [[ ! -d "$AGY_CONFIG" ]]; then
    echo "→ agy not set up (no ~/.gemini/config); run install again after first using agy to add its session hook"
    exit 0
fi

if ! command -v jq &> /dev/null; then
    echo "! jq not found; merge $SCRIPT_DIR/agy-hooks.json.example into $AGY_HOOKS by hand"
    exit 0
fi

current=$( [[ -f "$AGY_HOOKS" ]] && cat "$AGY_HOOKS" || echo '{}' )
merged=$(jq -s '(.[1] // {}) + .[0]' "$SCRIPT_DIR/agy-hooks.json.example" <(printf '%s' "$current")) || {
    echo "! Could not update $AGY_HOOKS; merge $SCRIPT_DIR/agy-hooks.json.example by hand"
    exit 0
}

if [[ -f "$AGY_HOOKS" ]] && [[ "$(jq -S . <<< "$merged")" == "$(jq -S . <<< "$current" 2>/dev/null)" ]]; then
    echo "✓ agy session hook already in $AGY_HOOKS"
    exit 0
fi

# Written in place rather than moved over, so a symlinked hooks.json (a
# dotfiles checkout) keeps its link and the file keeps its mode.
printf '%s\n' "$merged" > "$AGY_HOOKS"
echo "✓ Added the agy session hook to $AGY_HOOKS"
