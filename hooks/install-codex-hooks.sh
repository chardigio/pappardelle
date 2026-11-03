#!/bin/bash
# Merge Pappardelle's session hook into ~/.codex/hooks.json. Codex records its
# session id through its own hooks.json (Claude does it in update-status.py),
# so a relaunch resumes the space's own conversation. Merged rather than
# replaced: the file usually carries other tools' hooks.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOOKS="$HOME/.codex/hooks.json"

if [[ ! -d "$HOME/.codex" ]]; then
    echo "→ Codex not set up (no ~/.codex); run install again after first using codex to add its session hook"
    exit 0
fi

if ! command -v jq &> /dev/null; then
    echo "! jq not found; merge $SCRIPT_DIR/codex-hooks.json.example into $CODEX_HOOKS by hand"
    exit 0
fi

current=$( [[ -f "$CODEX_HOOKS" ]] && cat "$CODEX_HOOKS" || echo '{}' )
# Per event, so a file that registers the hook for only some events (or
# mentions the script elsewhere) still gets the rest.
merged=$(jq -s '.[0] as $mine | (.[1] // {}) as $theirs
        | def registered($entries): any($entries[]?.hooks[]?;
            (.command // "") | contains("record-agent-session.py"));
        $theirs | .hooks = (($theirs.hooks // {}) as $h
            | reduce ($mine.hooks | keys[]) as $event ($h;
                if registered(.[$event]) then .
                else .[$event] = ((.[$event] // []) + $mine.hooks[$event]) end))' \
        "$SCRIPT_DIR/codex-hooks.json.example" <(printf '%s' "$current")) || {
    echo "! Could not update $CODEX_HOOKS; merge $SCRIPT_DIR/codex-hooks.json.example by hand"
    exit 0
}

if [[ -f "$CODEX_HOOKS" ]] && [[ "$(jq -S . <<< "$merged")" == "$(jq -S . <<< "$current" 2>/dev/null)" ]]; then
    echo "✓ Codex session hook already in $CODEX_HOOKS"
    exit 0
fi

# Written in place rather than moved over, so a symlinked hooks.json (a
# dotfiles checkout) keeps its link and the file keeps its mode.
printf '%s\n' "$merged" > "$CODEX_HOOKS"
echo "✓ Added the Codex session hook to $CODEX_HOOKS"
echo "→ Codex asks to trust new hooks on its next launch; trust it so spaces resume their own session"
