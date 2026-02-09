#!/bin/bash

# organize-aerospace.sh - Organize windows in AeroSpace workspace
#
# Usage: organize-aerospace.sh --issue-key <STA-XXX>
#
# Moves all windows with the issue key in their title to the STA-XXX workspace
# (using AeroSpace for space management), then arranges them using yabai
# in a 2x3 grid layout:
#   - Col 1 (both rows): Cursor
#   - Col 2 (both rows): Xcode
#   - Col 3, Row 1: Firefox
#   - Col 3, Row 2: iTerm
#   - Simulator: Centered on screen
#
# Exit code: 0 on success, 1 on failure

set -e

# Parse arguments
ISSUE_KEY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: organize-aerospace.sh --issue-key <STA-XXX>"
            echo ""
            echo "Organizes windows using AeroSpace (spaces) + yabai (window positioning)."
            echo "Layout: 2x3 grid with Cursor, Xcode, Firefox, iTerm, Simulator centered."
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
    echo "[organize-aerospace] $*" >&2
}

WORKSPACE="$ISSUE_KEY"
TICKET_NUMBER=$(echo "$ISSUE_KEY" | grep -oE '[0-9]+')

log "Organizing workspace: $WORKSPACE"

# Move windows to the correct workspace
move_window_to_workspace() {
    local window_id="$1"
    local window_title="$2"

    # Get current workspace of this window
    local current_ws=$(aerospace list-windows --all --format '%{window-id}|%{workspace}' 2>/dev/null | grep "^$window_id|" | cut -d'|' -f2)

    # Only move if not already in the correct workspace
    if [[ "$current_ws" != "$WORKSPACE" ]]; then
        log "Moving window $window_id to $WORKSPACE (was: $current_ws)"
        aerospace move-node-to-workspace "$WORKSPACE" --window-id "$window_id" 2>/dev/null || true
    fi
}

# Move all windows with the issue key in their title
aerospace list-windows --all --format '%{window-id}|%{window-title}' 2>/dev/null | while IFS='|' read -r window_id window_title; do
    if [[ "$window_title" == *"$ISSUE_KEY"* ]] || [[ "$window_title" == *"QA-$ISSUE_KEY"* ]]; then
        move_window_to_workspace "$window_id" "$window_title"
    fi
done

# Get main screen dimensions from yabai
read SCREEN_X SCREEN_Y SCREEN_W SCREEN_H < <(yabai -m query --displays --display | jq -r '"\(.frame.x | floor) \(.frame.y | floor) \(.frame.w | floor) \(.frame.h | floor)"')

# Fallback if detection fails
SCREEN_X=${SCREEN_X:-0}
SCREEN_Y=${SCREEN_Y:-0}
SCREEN_W=${SCREEN_W:-1920}
SCREEN_H=${SCREEN_H:-1080}

log "Screen: ${SCREEN_W}x${SCREEN_H} at ($SCREEN_X, $SCREEN_Y)"

# Calculate 2x3 grid layout (3 equal columns, 2 equal rows)
COL_W=$((SCREEN_W / 3))
ROW_H=$((SCREEN_H / 2))

# Column X positions
COL1_X=$SCREEN_X
COL2_X=$((SCREEN_X + COL_W))
COL3_X=$((SCREEN_X + COL_W * 2))

# Row Y positions
ROW1_Y=$SCREEN_Y
ROW2_Y=$((SCREEN_Y + ROW_H))

# Simulator position: centered on screen
SIM_W=430
SIM_H=932
SIM_X=$(( SCREEN_X + (SCREEN_W - SIM_W) / 2 ))
SIM_Y=$(( SCREEN_Y + (SCREEN_H - SIM_H) / 2 ))
[ $SIM_Y -lt $SCREEN_Y ] && SIM_Y=$SCREEN_Y

# Get yabai window ID by app name and title pattern
get_yabai_window_id() {
    local app_name="$1"
    local title_pattern="$2"
    yabai -m query --windows 2>/dev/null | \
        jq -r ".[] | select(.app == \"$app_name\" and (.title | test(\"$title_pattern\"))) | .id" | head -1
}

# Position a window using yabai
position_window() {
    local window_id="$1" x="$2" y="$3" w="$4" h="$5"
    [[ -z "$window_id" ]] && return

    # Float the window first to allow manual positioning
    yabai -m window "$window_id" --toggle float 2>/dev/null || true

    # Move and resize
    yabai -m window "$window_id" --move abs:$x:$y 2>/dev/null || true
    yabai -m window "$window_id" --resize abs:$w:$h 2>/dev/null || true

    log "Positioned window $window_id at ($x, $y) size ${w}x${h}"
}

# Position simulator (just move, don't resize)
position_simulator() {
    local window_id="$1" x="$2" y="$3"
    [[ -z "$window_id" ]] && return

    # Float the window first to allow manual positioning
    yabai -m window "$window_id" --toggle float 2>/dev/null || true

    # Move only
    yabai -m window "$window_id" --move abs:$x:$y 2>/dev/null || true

    log "Positioned simulator $window_id at ($x, $y)"
}

# Find yabai window IDs by app and title pattern
cursor_id=$(get_yabai_window_id "Cursor" "$ISSUE_KEY")
xcode_id=$(get_yabai_window_id "Xcode" "$ISSUE_KEY")
simulator_id=$(get_yabai_window_id "Simulator" "QA-$ISSUE_KEY")
firefox_id=$(get_yabai_window_id "Firefox" "$ISSUE_KEY")
iterm_id=$(get_yabai_window_id "iTerm2" "$ISSUE_KEY")

log "Window IDs - Cursor: $cursor_id, Xcode: $xcode_id, Simulator: $simulator_id, Firefox: $firefox_id, iTerm: $iterm_id"

# 2x3 Grid Layout:
#   Col 1 (full height): Cursor
#   Col 2 (full height): Xcode
#   Col 3, Row 1: Firefox
#   Col 3, Row 2: iTerm

position_window "$cursor_id"  $COL1_X $ROW1_Y $COL_W $SCREEN_H
position_window "$xcode_id"   $COL2_X $ROW1_Y $COL_W $SCREEN_H
position_window "$firefox_id" $COL3_X $ROW1_Y $COL_W $ROW_H
position_window "$iterm_id"   $COL3_X $ROW2_Y $COL_W $ROW_H

# Position simulator in center (floating)
position_simulator "$simulator_id" $SIM_X $SIM_Y

# Switch to the workspace
aerospace workspace "$WORKSPACE" 2>/dev/null || true

log "Workspace $WORKSPACE organized"
