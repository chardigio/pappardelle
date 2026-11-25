#!/bin/bash

# derive-title.sh - Generate an issue title from a prompt
#
# Usage: derive-title.sh "<prompt text>"
#
# Outputs: Plain text title (e.g., "Add dark mode to settings...")
# Exit code: 0 on success, 1 on failure

set -e

PROMPT="$1"

MAX_TITLE_LENGTH=80
ELLIPSIS="..."

CLEANED_PROMPT=$(printf '%s' "$PROMPT" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')

if [[ -z "$CLEANED_PROMPT" ]]; then
    echo "Usage: derive-title.sh \"<prompt text>\"" >&2
    exit 1
fi

if [[ ${#CLEANED_PROMPT} -gt $MAX_TITLE_LENGTH ]]; then
    TRUNCATED_PROMPT="${CLEANED_PROMPT:0:$((MAX_TITLE_LENGTH - ${#ELLIPSIS}))}"
    printf '%s\n' "${TRUNCATED_PROMPT% }${ELLIPSIS}"
else
    printf '%s\n' "$CLEANED_PROMPT"
fi
