#!/bin/bash

# create-linear-issue.sh - Create a placeholder Linear issue
#
# Usage: create-linear-issue.sh --title "<title>" --prompt "<original prompt>" [--project-uuid <uuid>]
#
# Creates a Linear issue with:
#   - The derived title
#   - A placeholder description with the original prompt
#   - Optional project assignment
#   - Auto-assigns to current user
#
# Outputs: JSON with issue_key and issue_url
# Exit code: 0 on success, 1 on failure

set -e

# Parse arguments
TITLE=""
PROMPT=""
PROJECT_UUID=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --title)
            TITLE="$2"
            shift 2
            ;;
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        --project-uuid)
            PROJECT_UUID="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: create-linear-issue.sh --title \"<title>\" --prompt \"<original prompt>\" [--project-uuid <uuid>]"
            echo ""
            echo "Creates a placeholder Linear issue and outputs JSON with issue_key and issue_url."
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$TITLE" ]]; then
    echo "Error: --title is required" >&2
    exit 1
fi

if [[ -z "$PROMPT" ]]; then
    echo "Error: --prompt is required" >&2
    exit 1
fi

# Build the description with better formatting
# Convert prompt to blockquote by adding > to each line
QUOTED_PROMPT=$(echo "$PROMPT" | sed 's/^/> /')

DESCRIPTION="More details coming soon.

---

_Original prompt:_

$QUOTED_PROMPT"

# Build command args as an array to avoid quoting issues with special characters
CMD_ARGS=(linctl issue create --team STA --title "$TITLE" -m --description "$DESCRIPTION")

# Add project UUID if provided
if [[ -n "$PROJECT_UUID" ]]; then
    CMD_ARGS+=(--project "$PROJECT_UUID")
fi

# Execute the command and capture output
OUTPUT=$("${CMD_ARGS[@]}" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
    echo "Error: Failed to create Linear issue: $OUTPUT" >&2
    exit 1
fi

# Parse the issue key from output (e.g., "Created issue STA-123")
ISSUE_KEY=$(echo "$OUTPUT" | grep -oE 'STA-[0-9]+' | head -1)

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: Could not extract issue key from output: $OUTPUT" >&2
    exit 1
fi

# Extract just the number from the issue key
ISSUE_NUMBER=$(echo "$ISSUE_KEY" | sed 's/STA-//')

# Build the Linear URL
ISSUE_URL="https://linear.app/stardust-labs/issue/$ISSUE_KEY"

# Output JSON
echo "{\"issue_key\":\"$ISSUE_KEY\",\"issue_number\":\"$ISSUE_NUMBER\",\"issue_url\":\"$ISSUE_URL\"}"
