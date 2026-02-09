#!/bin/bash

# position-window.sh - Position a window immediately after opening
#
# Usage: position-window.sh --app <app_name> --title <pattern> --workspace <name> --position <1-9|center>
#
# Waits for a window matching the app/title, then:
#   1. Moves it to the AeroSpace workspace
#   2. Positions it using yabai
#
# Positions (2x3 grid):
#   1-3: Top row (left, middle, right)
#   4-6: Bottom row (left, middle, right)
#   7-9: Full height columns (left, middle, right)
#   center: Centered on screen (for simulator)
#
# Exit code: 0 on success, 1 on failure

set -e

# Parse arguments
APP_NAME=""
TITLE_PATTERN=""
WORKSPACE=""
POSITION=""
TIMEOUT=10

while [[ $# -gt 0 ]]; do
    case $1 in
        --app)
            APP_NAME="$2"
            shift 2
            ;;
        --title)
            TITLE_PATTERN="$2"
            shift 2
            ;;
        --workspace)
            WORKSPACE="$2"
            shift 2
            ;;
        --position)
            POSITION="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: position-window.sh --app <app_name> --title <pattern> --workspace <name> --position <1-9|center>"
            echo ""
            echo "Positions:"
            echo "  1-3: Top row (left, middle, right)"
            echo "  4-6: Bottom row (left, middle, right)"
            echo "  7-9: Full height columns (left, middle, right)"
            echo "  center: Centered on screen"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$APP_NAME" ]]; then
    echo "Error: --app is required" >&2
    exit 1
fi

if [[ -z "$TITLE_PATTERN" ]]; then
    echo "Error: --title is required" >&2
    exit 1
fi

if [[ -z "$WORKSPACE" ]]; then
    echo "Error: --workspace is required" >&2
    exit 1
fi

if [[ -z "$POSITION" ]]; then
    echo "Error: --position is required" >&2
    exit 1
fi

log() {
    echo "[position-window] $*" >&2
}

# Get screen dimensions from yabai
get_screen_dimensions() {
    read SCREEN_X SCREEN_Y SCREEN_W SCREEN_H < <(yabai -m query --displays --display | jq -r '"\(.frame.x | floor) \(.frame.y | floor) \(.frame.w | floor) \(.frame.h | floor)"')
    SCREEN_X=${SCREEN_X:-0}
    SCREEN_Y=${SCREEN_Y:-0}
    SCREEN_W=${SCREEN_W:-1920}
    SCREEN_H=${SCREEN_H:-1080}
}

# Calculate position coordinates based on grid position
calculate_position() {
    local pos="$1"

    get_screen_dimensions

    COL_W=$((SCREEN_W / 3))
    ROW_H=$((SCREEN_H / 2))

    COL1_X=$SCREEN_X
    COL2_X=$((SCREEN_X + COL_W))
    COL3_X=$((SCREEN_X + COL_W * 2))

    ROW1_Y=$SCREEN_Y
    ROW2_Y=$((SCREEN_Y + ROW_H))

    case "$pos" in
        1) X=$COL1_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
        2) X=$COL2_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
        3) X=$COL3_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
        4) X=$COL1_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
        5) X=$COL2_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
        6) X=$COL3_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
        7) X=$COL1_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
        8) X=$COL2_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
        9) X=$COL3_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
        center)
            # Simulator: centered, don't resize
            SIM_W=430
            SIM_H=932
            X=$(( SCREEN_X + (SCREEN_W - SIM_W) / 2 ))
            Y=$(( SCREEN_Y + (SCREEN_H - SIM_H) / 2 ))
            [ $Y -lt $SCREEN_Y ] && Y=$SCREEN_Y
            W=""  # Don't resize
            H=""
            ;;
        *)
            echo "Error: Invalid position: $pos" >&2
            exit 1
            ;;
    esac
}

# Find yabai window ID by app name and title pattern
get_yabai_window_id() {
    local app="$1"
    local pattern="$2"
    yabai -m query --windows 2>/dev/null | \
        jq -r ".[] | select(.app == \"$app\" and (.title | test(\"$pattern\"))) | .id" | head -1
}

# Find aerospace window ID by app name and title pattern
get_aerospace_window_id() {
    local app="$1"
    local pattern="$2"
    aerospace list-windows --all --format '%{window-id}|%{app-name}|%{window-title}' 2>/dev/null | \
        while IFS='|' read -r wid wapp wtitle; do
            if [[ "$wapp" == "$app" ]] && [[ "$wtitle" == *"$pattern"* ]]; then
                echo "$wid"
                return
            fi
        done
}

# Wait for window to appear
wait_for_window() {
    local app="$1"
    local pattern="$2"
    local timeout="$3"
    local elapsed=0

    while [[ $elapsed -lt $timeout ]]; do
        local window_id=$(get_yabai_window_id "$app" "$pattern")
        if [[ -n "$window_id" ]]; then
            echo "$window_id"
            return 0
        fi
        sleep 0.5
        elapsed=$((elapsed + 1))
    done

    return 1
}

# Move window to AeroSpace workspace
move_to_workspace() {
    local window_id="$1"
    local workspace="$2"

    # Get aerospace window ID (different from yabai window ID)
    local aero_id=$(aerospace list-windows --all --format '%{window-id}' 2>/dev/null | grep "^$window_id$" | head -1)

    if [[ -z "$aero_id" ]]; then
        # Try to find by the yabai window details
        local app_title=$(yabai -m query --windows --window "$window_id" 2>/dev/null | jq -r '"\(.app)|\(.title)"')
        local app=$(echo "$app_title" | cut -d'|' -f1)
        local title=$(echo "$app_title" | cut -d'|' -f2)
        aero_id=$(get_aerospace_window_id "$app" "${title:0:30}")
    fi

    if [[ -n "$aero_id" ]]; then
        aerospace move-node-to-workspace "$workspace" --window-id "$aero_id" 2>/dev/null || true
        log "Moved window $aero_id to workspace $workspace"
    fi
}

# Position window using yabai
position_window() {
    local window_id="$1"

    # Float the window first to allow manual positioning
    yabai -m window "$window_id" --toggle float 2>/dev/null || true

    # Move
    yabai -m window "$window_id" --move abs:$X:$Y 2>/dev/null || true

    # Resize (if dimensions are set)
    if [[ -n "$W" && -n "$H" ]]; then
        yabai -m window "$window_id" --resize abs:$W:$H 2>/dev/null || true
    fi

    log "Positioned window $window_id at ($X, $Y)"
}

# Main logic
log "Waiting for $APP_NAME window matching '$TITLE_PATTERN'..."

WINDOW_ID=$(wait_for_window "$APP_NAME" "$TITLE_PATTERN" "$TIMEOUT")

if [[ -z "$WINDOW_ID" ]]; then
    log "Warning: Window not found within ${TIMEOUT}s"
    exit 1
fi

log "Found window: $WINDOW_ID"

# Calculate position
calculate_position "$POSITION"

# Move to workspace and position
move_to_workspace "$WINDOW_ID" "$WORKSPACE"
position_window "$WINDOW_ID"

log "Done: $APP_NAME positioned at $POSITION in workspace $WORKSPACE"
