#!/bin/bash

# resolve-terminal-app.sh - Resolve which terminal launcher idow should drive
#
# Usage: resolve-terminal-app.sh --config <path> [--local-config <path>] [--home-config <path>]
#
# Layers (lowest → highest priority), matching resolve-claude-config.sh:
#   1. Home config    (~/.pappardelle/.pappardelle.yml)
#   2. Project config (.pappardelle.yml)
#   3. Local config   (.pappardelle.local.yml)
#
# terminal.app defaults to "auto", which detects Ghostty and otherwise falls
# back to iTerm. An explicit value is echoed back unchanged.
#
# Terminal choice is a per-machine fact, so the layering matters: the value
# belongs in the gitignored .pappardelle.local.yml or the home config rather
# than in the shared project config.
#
# Output: one word on stdout, the terminal app name.

set -e

# Get the directory where this script lives (resolving symlinks)
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_SOURCE" ]]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
    SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
    [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"

# shellcheck source=provider-helpers.sh
source "$SCRIPT_DIR/provider-helpers.sh"

CONFIG_PATH=""
LOCAL_CONFIG_PATH=""
HOME_CONFIG_PATH=""

# Overridable so the test suite can point detection at a fake bundle.
GHOSTTY_APP="${GHOSTTY_APP:-/Applications/Ghostty.app}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --config)
            CONFIG_PATH="$2"
            shift 2
            ;;
        --local-config)
            LOCAL_CONFIG_PATH="$2"
            shift 2
            ;;
        --home-config)
            HOME_CONFIG_PATH="$2"
            shift 2
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$CONFIG_PATH" ]]; then
    echo "Error: --config is required" >&2
    exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "Error: Config file not found: $CONFIG_PATH" >&2
    exit 1
fi

RESOLVED=$(merge_config_layers "$HOME_CONFIG_PATH" "$CONFIG_PATH" "$LOCAL_CONFIG_PATH")

TERMINAL_APP=$(echo "$RESOLVED" | yq -r '.terminal.app // "auto"')
if [[ -z "$TERMINAL_APP" || "$TERMINAL_APP" == "null" ]]; then
    TERMINAL_APP="auto"
fi

# idow dispatches on an exact name, so fold the known values to their canonical
# spelling. An unrecognized value is passed through untouched for idow to warn
# about, spelled the way the user wrote it.
case "$(printf '%s' "$TERMINAL_APP" | tr '[:upper:]' '[:lower:]')" in
    auto)
        ;;
    iterm|iterm2)
        printf 'iTerm\n'
        exit 0
        ;;
    ghostty)
        printf 'Ghostty\n'
        exit 0
        ;;
    *)
        printf '%s\n' "$TERMINAL_APP"
        exit 0
        ;;
esac

# tmux clobbers TERM_PROGRAM, but these two survive it and reach idow through
# buildSpawnEnv(). They record where the process was *started*, so a TUI opened
# in Ghostty and later reattached from another terminal still detects Ghostty;
# the terminal.app override is the escape hatch for that.
GHOSTTY_ENV=false
if [[ "${__CFBundleIdentifier:-}" == "com.mitchellh.ghostty" || -n "${GHOSTTY_BIN_DIR:-}" ]]; then
    GHOSTTY_ENV=true
fi

# The AppleScript dictionary only ships in Ghostty 1.3 and later, so its
# presence is what separates a driveable build from one auto-detection must
# not pick.
GHOSTTY_SCRIPTABLE=false
if [[ -f "$GHOSTTY_APP/Contents/Resources/Ghostty.sdef" ]]; then
    GHOSTTY_SCRIPTABLE=true
fi

if [[ "$GHOSTTY_ENV" == true && "$GHOSTTY_SCRIPTABLE" == true ]]; then
    printf 'Ghostty\n'
else
    printf 'iTerm\n'
fi
