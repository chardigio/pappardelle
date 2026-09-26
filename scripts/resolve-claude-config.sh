#!/bin/bash

# resolve-claude-config.sh - Resolve claude config values with layered override support
#
# Usage: resolve-claude-config.sh --config <path> [--local-config <path>] [--home-config <path>] [--profile <name>]
#
# Layers (lowest → highest priority):
#   1. Home config    (~/.pappardelle/.pappardelle.yml) — personal defaults across all repos
#   2. Project config (.pappardelle.yml)                — repo-level settings
#   3. Local config   (.pappardelle.local.yml)          — personal overrides (gitignored)
#
# Uses yq deep merge so ANY field in the claude section (or any future section)
# is automatically resolved without per-field override logic.
#
# --profile <name> additionally resolves the pass-through launch flags
# (model, effort) profile-first: profiles.<name>.claude.<field> beats the
# top-level claude.<field>. An explicit empty string at the profile level is
# preserved, which is how a profile opts out of an inherited value — same
# empty-string-is-meaningful convention companion_command uses.
#
# init_cmd and skip_permissions stay top-level-only here even when --profile is
# given: idow layers the per-profile initialization_command itself (and has
# since before this script was profile-aware), so resolving it here too would
# change which layer wins. Mirrored by getClaudeModel()/getClaudeEffort() in
# source/config.ts and pinned by scripts/test-claude-model-effort.sh.
#
# companion_command is resolved here too, profile-first over the merged layers,
# so a top-level value in the home config reaches every repo. The built-in
# default applies only when no layer defines the key at any level; an explicit
# "" (plain shell) is preserved. Mirrors getCompanionCommand() in source/config.ts.
#
# Output: JSON object with resolved values:
#   {"init_cmd": "...", "skip_permissions": "true|false", "model": "...", "effort": "...",
#    "companion_command": "..."}

set -eo pipefail

CONFIG_PATH=""
LOCAL_CONFIG_PATH=""
HOME_CONFIG_PATH=""
PROFILE=""

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
            PROFILE="$2"
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

# Resolve all fields from one parse; startup calls this for the selected profile.
# Select only the keys read below before the JSON step: yq cannot write values
# such as .inf or a 20-digit integer as JSON, and such a value in an unrelated
# key must not stop idow (which runs with set -e).
# shellcheck disable=SC2016 # $selected and strenv() are yq, not shell
printf '%s\n' "$RESOLVED" | PROFILE="$PROFILE" yq -o=json '
    (.profiles[strenv(PROFILE)] // {}) as $selected |
    {
        "claude": {
            "initialization_command": .claude.initialization_command,
            "dangerously_skip_permissions": .claude.dangerously_skip_permissions,
            "model": .claude.model,
            "effort": .claude.effort
        },
        "companion_command": .companion_command,
        "selected": {
            "claude": {"model": $selected.claude.model, "effort": $selected.claude.effort},
            "companion_command": $selected.companion_command
        }
    }
' | jq '
    .selected as $selected |
    {
        init_cmd: (.claude.initialization_command // ""),
        skip_permissions: (.claude.dangerously_skip_permissions // false),
        model: ($selected.claude.model // .claude.model // ""),
        effort: ($selected.claude.effort // .claude.effort // ""),
        companion_command: ($selected.companion_command // .companion_command // "GIT_OPTIONAL_LOCKS=0 gitui")
    } |
    with_entries(.value |= tostring) |
    .skip_permissions = ((.skip_permissions == "true") | tostring)
'
