#!/bin/bash

# resolve-claude-config.sh - Resolve claude config values with layered override support
#
# Usage: resolve-claude-config.sh --config <path> [--local-config <path>] [--home-config <path>]
#
# Layers (lowest → highest priority):
#   1. Home config   (~/.pappardelle.yml)     — personal defaults across all repos
#   2. Project config (.pappardelle.yml)       — repo-level settings
#   3. Local config   (.pappardelle.local.yml) — personal overrides (gitignored)
#
# Uses yq deep merge so ANY field in the claude section (or any future section)
# is automatically resolved without per-field override logic.
#
# Output: JSON object with resolved values:
#   {"init_cmd": "...", "skip_permissions": "true|false"}

set -e

CONFIG_PATH=""
LOCAL_CONFIG_PATH=""
HOME_CONFIG_PATH=""

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

# Build the list of config files to merge (lowest → highest priority).
# Only include files that actually exist.
MERGE_FILES=()
if [[ -n "$HOME_CONFIG_PATH" && -f "$HOME_CONFIG_PATH" ]]; then
    MERGE_FILES+=("$HOME_CONFIG_PATH")
fi
MERGE_FILES+=("$CONFIG_PATH")
if [[ -n "$LOCAL_CONFIG_PATH" && -f "$LOCAL_CONFIG_PATH" ]]; then
    MERGE_FILES+=("$LOCAL_CONFIG_PATH")
fi

# Deep-merge all layers using yq. Later files override earlier ones.
# With a single file, eval-all just reads it; with 2+ it merges via *.
if [[ ${#MERGE_FILES[@]} -eq 1 ]]; then
    RESOLVED=$(cat "${MERGE_FILES[0]}")
else
    # Build a yq merge expression: select(fi==0) * select(fi==1) * ...
    MERGE_EXPR="select(fileIndex==0)"
    for (( i=1; i<${#MERGE_FILES[@]}; i++ )); do
        MERGE_EXPR="$MERGE_EXPR * select(fileIndex==$i)"
    done
    RESOLVED=$(yq eval-all "$MERGE_EXPR" "${MERGE_FILES[@]}")
fi

# Read resolved values from the merged config
INIT_CMD=$(echo "$RESOLVED" | yq -r '.claude.initialization_command // ""')
SKIP_PERMISSIONS=$(echo "$RESOLVED" | yq -r '.claude.dangerously_skip_permissions // false')

# Validate: dangerously_skip_permissions must be a boolean; fall back to safe default
if [[ "$SKIP_PERMISSIONS" != "true" && "$SKIP_PERMISSIONS" != "false" ]]; then
    SKIP_PERMISSIONS="false"
fi

# Output as JSON (use jq to handle escaping of special characters)
jq -n --arg init_cmd "$INIT_CMD" --arg skip_permissions "$SKIP_PERMISSIONS" \
  '{init_cmd: $init_cmd, skip_permissions: $skip_permissions}'
