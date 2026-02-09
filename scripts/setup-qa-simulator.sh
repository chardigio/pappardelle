#!/bin/bash

# setup-qa-simulator.sh - Clone and boot a QA simulator for an issue
#
# Usage: setup-qa-simulator.sh --worktree <path> --issue-key <STA-XXX> --ios-app-dir <dir> --bundle-id <id>
#
# Creates an isolated simulator clone (QA-STA-XXX) with the app built and installed.
# Copies app data from the base simulator to preserve login state.
#
# Outputs: JSON with simulator_udid
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

# Configuration
BASE_SIMULATOR="iPhone 17 Pro"

# Parse arguments
WORKTREE=""
ISSUE_KEY=""
IOS_APP_DIR=""
BUNDLE_ID=""

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
        --ios-app-dir)
            IOS_APP_DIR="$2"
            shift 2
            ;;
        --bundle-id)
            BUNDLE_ID="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: setup-qa-simulator.sh --worktree <path> --issue-key <STA-XXX> --ios-app-dir <dir> --bundle-id <id>"
            echo ""
            echo "Clones and boots a QA simulator with the app installed."
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

if [[ -z "$IOS_APP_DIR" ]]; then
    echo "Error: --ios-app-dir is required" >&2
    exit 1
fi

if [[ -z "$BUNDLE_ID" ]]; then
    echo "Error: --bundle-id is required" >&2
    exit 1
fi

log() {
    echo "[setup-qa-simulator] $*" >&2
}

# Full path to the iOS app directory
APP_DIR="$WORKTREE/$IOS_APP_DIR"
APP_NAME=$(basename "$IOS_APP_DIR")
SIM_NAME="QA-$ISSUE_KEY"

if [[ ! -d "$APP_DIR" ]]; then
    echo "Error: iOS app directory does not exist: $APP_DIR" >&2
    exit 1
fi

# Wait for simulator to reach a specific state
wait_for_sim_state() {
    local udid="$1"
    local target_state="$2"
    local timeout="${3:-30}"
    local elapsed=0

    while [[ $elapsed -lt $timeout ]]; do
        local state=$(xcrun simctl list devices | grep "$udid" | grep -oE '\((Booted|Shutdown|Shutting Down)\)' | tr -d '()' || echo "Shutdown")
        if [[ "$state" == "$target_state" ]]; then
            return 0
        fi
        sleep 1
        ((elapsed++))
    done
    log "Warning: Timeout waiting for simulator to reach state: $target_state"
    return 1
}

# Find base simulator UDID
log "Finding base simulator: $BASE_SIMULATOR"
BASE_SIM_UDID=$(xcrun simctl list devices available | grep "$BASE_SIMULATOR" | grep -oE '[A-F0-9-]{36}' | head -1)

if [[ -z "$BASE_SIM_UDID" ]]; then
    log "Error: Base simulator '$BASE_SIMULATOR' not found"
    exit 1
fi

log "Found base simulator: $BASE_SIM_UDID"

# Shutdown base simulator if booted (required for cloning)
BASE_SIM_STATE=$(xcrun simctl list devices | grep "$BASE_SIM_UDID" | grep -oE '\(Booted\)' || true)
if [[ -n "$BASE_SIM_STATE" ]]; then
    log "Shutting down base simulator for cloning..."
    xcrun simctl shutdown "$BASE_SIM_UDID" 2>/dev/null || true
    wait_for_sim_state "$BASE_SIM_UDID" "Shutdown" 30 || true
fi

# Check if QA simulator already exists
EXISTING_SIM=$(xcrun simctl list devices | grep "$SIM_NAME" | grep -oE '[A-F0-9-]{36}' | head -1 || true)

if [[ -n "$EXISTING_SIM" ]]; then
    log "Simulator $SIM_NAME already exists (UDID: $EXISTING_SIM)"
    SIM_UDID="$EXISTING_SIM"
else
    # Create QA simulator
    log "Cloning simulator: $BASE_SIMULATOR -> $SIM_NAME"
    SIM_UDID=$(xcrun simctl clone "$BASE_SIM_UDID" "$SIM_NAME")
    log "Created simulator: $SIM_UDID"
fi

# Find xcodeproj (may be renamed with issue key)
XCODEPROJ=$(find "$APP_DIR" -maxdepth 1 -name "*.xcodeproj" -type d | head -1)

if [[ -z "$XCODEPROJ" ]]; then
    log "Error: No xcodeproj found in $APP_DIR"
    exit 1
fi

PROJECT_NAME=$(basename "$XCODEPROJ")
SCHEME="$APP_NAME"
DERIVED_DATA="$APP_DIR/DerivedData"
DESTINATION="platform=iOS Simulator,id=$SIM_UDID"

# Build for simulator
log "Building $APP_NAME for simulator..."
BUILD_START=$(date +%s)

(cd "$APP_DIR" && xcodebuild \
    -project "$PROJECT_NAME" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "$DESTINATION" \
    -derivedDataPath "$DERIVED_DATA" \
    -quiet \
    build) 2>&1 | grep -E "error:|warning:" || true

BUILD_END=$(date +%s)
BUILD_TIME=$((BUILD_END - BUILD_START))
log "Build completed in ${BUILD_TIME}s"

# Find built app
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
    log "Error: Built app not found at: $APP_PATH"
    exit 1
fi

# Boot simulator
log "Booting simulator: $SIM_NAME"
xcrun simctl boot "$SIM_UDID" 2>/dev/null || true

# Open Simulator.app to show the window
open -a Simulator

# Position simulator window immediately (center)
"$SCRIPT_DIR/position-window.sh" \
    --app "Simulator" \
    --title "QA-$ISSUE_KEY" \
    --workspace "$ISSUE_KEY" \
    --position center &

# Wait for simulator to boot
wait_for_sim_state "$SIM_UDID" "Booted" 60 || true

# Install app
log "Installing app..."
xcrun simctl install "$SIM_UDID" "$APP_PATH"

# Copy app data from base simulator (preserves login state, UserDefaults, etc.)
log "Copying app data from base simulator..."
BASE_APP_DATA=$(xcrun simctl get_app_container "$BASE_SIM_UDID" "$BUNDLE_ID" data 2>/dev/null || true)
if [[ -n "$BASE_APP_DATA" && -d "$BASE_APP_DATA" ]]; then
    QA_APP_DATA=$(xcrun simctl get_app_container "$SIM_UDID" "$BUNDLE_ID" data 2>/dev/null || true)
    if [[ -n "$QA_APP_DATA" && -d "$QA_APP_DATA" ]]; then
        rsync -a --exclude 'Caches' "$BASE_APP_DATA/" "$QA_APP_DATA/"
        log "App data copied from base simulator (login state preserved)"
    fi
fi

# Launch app
log "Launching app..."
xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID" 2>/dev/null || true

# Output JSON
echo "{\"simulator_udid\":\"$SIM_UDID\",\"simulator_name\":\"$SIM_NAME\",\"build_time\":$BUILD_TIME}"
