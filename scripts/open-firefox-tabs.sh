#!/bin/bash

# open-firefox-tabs.sh - Open Firefox with Linear and GitHub PR tabs
#
# Usage: open-firefox-tabs.sh --issue-key <STA-XXX> [--pr-url <url>]
#
# Opens a new Firefox window with:
#   - Linear issue page
#   - GitHub PR page (if provided)
#   - GitHub PR files page (if PR URL provided)
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
ISSUE_KEY=""
ISSUE_URL=""
PR_URL=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --issue-url)
            ISSUE_URL="$2"
            shift 2
            ;;
        --pr-url)
            PR_URL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: open-firefox-tabs.sh --issue-key <STA-XXX> [--issue-url <url>] [--pr-url <url>]"
            echo ""
            echo "Opens Firefox with issue tracker and PR/MR tabs."
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: --issue-key is required" >&2
    exit 1
fi

log() {
    echo "[open-firefox-tabs] $*" >&2
}

# Build issue URL (use provided URL or fall back to Linear)
if [[ -n "$ISSUE_URL" ]]; then
    LINEAR_URL="$ISSUE_URL"
else
    LINEAR_URL="https://linear.app/stardust-labs/issue/$ISSUE_KEY"
fi

# Check if Firefox already has a window for this ticket
firefox_has_ticket() {
    local result
    result=$(aerospace list-windows --all --json 2>/dev/null | jq -e ".[] | select(.[\"app-name\"] == \"Firefox\" and (.[\"window-title\"] | contains(\"$ISSUE_KEY\")))" 2>&1)
    return $?
}

if firefox_has_ticket; then
    log "Firefox already has window for $ISSUE_KEY - skipping"
    exit 0
fi

log "Opening new Firefox window with Linear: $LINEAR_URL"

# Open Linear in a new window first
open -na "Firefox.app" --args --new-window "$LINEAR_URL"

# Wait for window to be created and focused before adding tabs
sleep 1

# Add PR tabs if URL provided
if [[ -n "$PR_URL" ]]; then
    log "Adding PR tab: $PR_URL"
    open -na "Firefox.app" --args --new-tab "$PR_URL"
    sleep 0.3

    log "Adding PR files tab: $PR_URL/files"
    open -na "Firefox.app" --args --new-tab "$PR_URL/files"
fi

# Position window immediately (position 3 = top right)
"$SCRIPT_DIR/position-window.sh" \
    --app "Firefox" \
    --title "$ISSUE_KEY" \
    --workspace "$ISSUE_KEY" \
    --position 3 &

log "Firefox tabs opened for $ISSUE_KEY"
