#!/bin/bash

# open-cursor.sh - Open Cursor editor for a worktree
#
# Usage: open-cursor.sh --worktree <path>
#
# Opens Cursor at the specified worktree path.
# Cursor window title will be set to the folder name (e.g., "STA-123").
#
# Exit code: 0 on success, 1 on failure

set -e

# Get the directory where this script lives (resolving symlinks)
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_SOURCE" ]]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
    SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
    [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"

# Parse arguments
WORKTREE=""
ISSUE_KEY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree)
            WORKTREE="$2"
            shift 2
            ;;
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: open-cursor.sh --worktree <path> --issue-key <STA-XXX>"
            echo ""
            echo "Opens Cursor editor at the specified worktree path."
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$WORKTREE" ]]; then
    echo "Error: --worktree is required" >&2
    exit 1
fi

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: --issue-key is required" >&2
    exit 1
fi

if [[ ! -d "$WORKTREE" ]]; then
    echo "Error: Worktree directory does not exist: $WORKTREE" >&2
    exit 1
fi

# Open Cursor
# The -n flag opens a new window, -g opens in the background without activating
cursor "$WORKTREE"

# Position window immediately (position 7 = left column, full height)
"$SCRIPT_DIR/position-window.sh" \
    --app "Cursor" \
    --title "$ISSUE_KEY" \
    --workspace "$ISSUE_KEY" \
    --position 7 &

echo "Cursor opened at $WORKTREE"
