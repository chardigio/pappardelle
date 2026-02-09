#!/bin/bash
# Position the focused window to a predefined screen region using yabai
# Usage: yabai-position <1-9>
#
# 2x3 Grid Layout:
#   +-------+-------+-------+
#   |   1   |   2   |   3   |  <- Top row cells
#   +-------+-------+-------+
#   |   4   |   5   |   6   |  <- Bottom row cells
#   +-------+-------+-------+
#
#   7: Left column (full height)
#   8: Middle column (full height)
#   9: Right column (full height)

POSITION="$1"

# Get main display dimensions from yabai
read SCREEN_X SCREEN_Y SCREEN_W SCREEN_H < <(yabai -m query --displays --display | jq -r '"\(.frame.x | floor) \(.frame.y | floor) \(.frame.w | floor) \(.frame.h | floor)"')

# Fallback if detection fails
SCREEN_X=${SCREEN_X:-0}
SCREEN_Y=${SCREEN_Y:-0}
SCREEN_W=${SCREEN_W:-1920}
SCREEN_H=${SCREEN_H:-1080}

# Calculate 2x3 grid (3 equal columns, 2 equal rows)
COL_W=$((SCREEN_W / 3))
ROW_H=$((SCREEN_H / 2))

# Column X positions
COL1_X=$SCREEN_X
COL2_X=$((SCREEN_X + COL_W))
COL3_X=$((SCREEN_X + COL_W * 2))

# Row Y positions
ROW1_Y=$SCREEN_Y
ROW2_Y=$((SCREEN_Y + ROW_H))

# Get focused window ID
WINDOW_ID=$(yabai -m query --windows --window | jq -r '.id')

if [[ -z "$WINDOW_ID" || "$WINDOW_ID" == "null" ]]; then
    echo "No focused window" >&2
    exit 1
fi

# Float the window first to allow manual positioning
yabai -m window "$WINDOW_ID" --toggle float 2>/dev/null || true

case "$POSITION" in
    # Top row cells
    1) X=$COL1_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
    2) X=$COL2_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
    3) X=$COL3_X; Y=$ROW1_Y; W=$COL_W; H=$ROW_H ;;
    # Bottom row cells
    4) X=$COL1_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
    5) X=$COL2_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
    6) X=$COL3_X; Y=$ROW2_Y; W=$COL_W; H=$ROW_H ;;
    # Full height columns
    7) X=$COL1_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
    8) X=$COL2_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
    9) X=$COL3_X; Y=$SCREEN_Y; W=$COL_W; H=$SCREEN_H ;;
    *)
        echo "Usage: yabai-position <1-9>" >&2
        echo "  1-3: Top row (left, middle, right)" >&2
        echo "  4-6: Bottom row (left, middle, right)" >&2
        echo "  7-9: Full height columns (left, middle, right)" >&2
        exit 1
        ;;
esac

# Move and resize the window
yabai -m window "$WINDOW_ID" --move abs:$X:$Y
yabai -m window "$WINDOW_ID" --resize abs:$W:$H
