#!/bin/bash

# derive-title.sh - Generate a WIP title from a prompt
#
# Usage: derive-title.sh "<prompt text>"
#
# Creates a simple "[WIP] <truncated prompt>" title for Linear issues and GitHub PRs.
# The title is truncated to fit within reasonable limits.
#
# Outputs: Plain text title (e.g., "[WIP] Add dark mode to settings...")
# Exit code: 0 on success, 1 on failure

set -e

PROMPT="$1"

if [[ -z "$PROMPT" ]]; then
    echo "Usage: derive-title.sh \"<prompt text>\"" >&2
    exit 1
fi

# Configuration
WIP_PREFIX="[WIP] "
MAX_TITLE_LENGTH=80
ELLIPSIS="..."

# Calculate available space for the prompt text
PREFIX_LENGTH=${#WIP_PREFIX}
ELLIPSIS_LENGTH=${#ELLIPSIS}
AVAILABLE_LENGTH=$((MAX_TITLE_LENGTH - PREFIX_LENGTH))

# Clean up the prompt: remove newlines and extra whitespace
CLEANED_PROMPT=$(echo "$PROMPT" | tr '\n' ' ' | sed 's/  */ /g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

# Truncate if necessary
if [[ ${#CLEANED_PROMPT} -gt $AVAILABLE_LENGTH ]]; then
    # Truncate and add ellipsis
    TRUNCATE_AT=$((AVAILABLE_LENGTH - ELLIPSIS_LENGTH))
    TRUNCATED_PROMPT="${CLEANED_PROMPT:0:$TRUNCATE_AT}${ELLIPSIS}"
else
    TRUNCATED_PROMPT="$CLEANED_PROMPT"
fi

# Build the final title
TITLE="${WIP_PREFIX}${TRUNCATED_PROMPT}"

echo "$TITLE"
