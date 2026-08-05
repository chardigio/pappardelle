#!/bin/bash

# resolve-claude-config.sh - Resolve agent config values with layered override support
#
# Usage: resolve-claude-config.sh --config <path> [--local-config <path>] [--home-config <path>] [--profile <name>]
#
# Layers (lowest → highest priority):
#   1. Home config   (~/.pappardelle.yml)     — personal defaults across all repos
#   2. Project config (.pappardelle.yml)       — repo-level settings
#   3. Local config   (.pappardelle.local.yml) — personal overrides (gitignored)
#
# Uses yq deep merge so ANY field in the agent section (or any future section)
# is automatically resolved without per-field override logic.
#
# The settings section is `agent:`; the pre-STA-1850 name `claude:` is still
# read as a fallback so existing configs keep working untouched.
#
# --profile selects a profile whose `agent_cli` overrides the top-level one.
#
# Output: JSON object with resolved values:
#   {"init_cmd": "...", "skip_permissions": "true|false", "agent_cli": "claude|codex"}

set -e

CONFIG_PATH=""
LOCAL_CONFIG_PATH=""
HOME_CONFIG_PATH=""
PROFILE_NAME=""

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
        --profile)
            PROFILE_NAME="$2"
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

# Read resolved values from the merged config. `agent:` wins; `claude:` is the
# legacy spelling of the same section and is read when `agent:` is absent.
INIT_CMD=$(echo "$RESOLVED" | yq -r '.agent.initialization_command // .claude.initialization_command // ""')
SKIP_PERMISSIONS=$(echo "$RESOLVED" | yq -r '.agent.dangerously_skip_permissions // .claude.dangerously_skip_permissions // false')

# Validate: dangerously_skip_permissions must be a boolean; fall back to safe default
if [[ "$SKIP_PERMISSIONS" != "true" && "$SKIP_PERMISSIONS" != "false" ]]; then
    SKIP_PERMISSIONS="false"
fi

# Resolve agent_cli: profile-level override, then top-level, then "claude".
#
# The profile name is passed to yq as a *variable* and indexed with brackets
# rather than interpolated into a dotted path. STA-1120 built the path as
# `.profiles.$NAME.agent_cli`, which silently resolved to nothing for a profile
# named e.g. "my.profile" — yq read it as two path segments — and fell through
# to the global default with no error. Bracket indexing treats the whole name as
# one key regardless of what characters are in it.
AGENT_CLI=$(echo "$RESOLVED" | yq -r '.agent_cli // ""')
if [[ -n "$PROFILE_NAME" ]]; then
    PROFILE_AGENT_CLI=$(echo "$RESOLVED" | PROFILE="$PROFILE_NAME" yq -r '.profiles[strenv(PROFILE)].agent_cli // ""')
    if [[ -n "$PROFILE_AGENT_CLI" && "$PROFILE_AGENT_CLI" != "null" ]]; then
        AGENT_CLI="$PROFILE_AGENT_CLI"
    fi
fi

# Unknown or absent values fall back to claude — the pre-STA-1850 behavior.
if [[ "$AGENT_CLI" != "claude" && "$AGENT_CLI" != "codex" ]]; then
    AGENT_CLI="claude"
fi

# Output as JSON (use jq to handle escaping of special characters)
jq -n --arg init_cmd "$INIT_CMD" --arg skip_permissions "$SKIP_PERMISSIONS" --arg agent_cli "$AGENT_CLI" \
  '{init_cmd: $init_cmd, skip_permissions: $skip_permissions, agent_cli: $agent_cli}'
