#!/bin/bash

# create-github-pr.sh - Create a placeholder GitHub PR
#
# Usage: create-github-pr.sh --issue-key <STA-XXX> --title "<title>" --worktree <path> [--label <label>] [--prompt "<prompt>"]
#
# Creates a GitHub PR with:
#   - Title: "[STA-XXX] <title>"
#   - Placeholder body with original prompt
#   - Optional label
#
# Must be run after the worktree/branch has been created.
#
# Outputs: JSON with pr_url and pr_number
# Exit code: 0 on success, 1 on failure

set -e

# Parse arguments
ISSUE_KEY=""
TITLE=""
WORKTREE=""
LABEL=""
PROMPT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --title)
            TITLE="$2"
            shift 2
            ;;
        --worktree)
            WORKTREE="$2"
            shift 2
            ;;
        --label)
            LABEL="$2"
            shift 2
            ;;
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: create-github-pr.sh --issue-key <STA-XXX> --title \"<title>\" --worktree <path> [--label <label>] [--prompt \"<prompt>\"]"
            echo ""
            echo "Creates a placeholder GitHub PR and outputs JSON with pr_url and pr_number."
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: --issue-key is required" >&2
    exit 1
fi

if [[ -z "$TITLE" ]]; then
    echo "Error: --title is required" >&2
    exit 1
fi

if [[ -z "$WORKTREE" ]]; then
    echo "Error: --worktree is required" >&2
    exit 1
fi

if [[ ! -d "$WORKTREE" ]]; then
    echo "Error: Worktree directory does not exist: $WORKTREE" >&2
    exit 1
fi

cd "$WORKTREE"

# Get the current branch name (should match issue key)
BRANCH=$(git branch --show-current)

if [[ -z "$BRANCH" ]]; then
    echo "Error: Could not determine current branch" >&2
    exit 1
fi

# Create an empty commit to enable PR creation
# (PRs require at least one commit different from base)
# Redirect stdout to stderr to keep JSON output clean
git commit --allow-empty -m "[$ISSUE_KEY] Placeholder commit for PR creation" >&2 2>&1

# Push the branch to origin (redirect output to stderr)
git push -u origin "$BRANCH" >&2 2>&1 || {
    echo "Error: Failed to push branch to origin" >&2
    exit 1
}

# Build PR title
PR_TITLE="[$ISSUE_KEY] $TITLE"

# Convert prompt to blockquote by adding > to each line
QUOTED_PROMPT=$(echo "$PROMPT" | sed 's/^/> /')

# Build PR body with better formatting
PR_BODY="## Summary
Work in progress - more details coming soon.

## Linear Issue
https://linear.app/stardust-labs/issue/$ISSUE_KEY

---

_Original prompt:_

$QUOTED_PROMPT

---
Generated with [Claude Code](https://claude.com/claude-code)"

# Build command args as an array to avoid quoting issues with special characters
PR_CREATE_ARGS=(gh pr create --title "$PR_TITLE" --body "$PR_BODY")

# Always add placeholder label (to skip Claude review until real commits)
PR_CREATE_ARGS+=(--label "placeholder")

# Add additional label if provided (e.g., project-specific label)
if [[ -n "$LABEL" ]]; then
    PR_CREATE_ARGS+=(--label "$LABEL")
fi

# Execute PR creation
PR_OUTPUT=$("${PR_CREATE_ARGS[@]}" 2>&1)
PR_EXIT_CODE=$?

if [[ $PR_EXIT_CODE -ne 0 ]]; then
    echo "Error: Failed to create PR: $PR_OUTPUT" >&2
    exit 1
fi

# Reset the empty placeholder commit locally so it doesn't appear in history
# when real changes are force-pushed. The commit exists on remote (needed for PR)
# but won't be in local history.
git reset HEAD~1 >&2 2>&1

# Extract PR URL from output (gh pr create outputs the URL)
PR_URL=$(echo "$PR_OUTPUT" | grep -oE 'https://github.com/[^[:space:]]+' | head -1)

if [[ -z "$PR_URL" ]]; then
    echo "Error: Could not extract PR URL from output: $PR_OUTPUT" >&2
    exit 1
fi

# Extract PR number from URL
PR_NUMBER=$(echo "$PR_URL" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+')

# Note: The placeholder label is removed by CI workflow (.github/workflows/remove-placeholder-label.yml)
# This ensures the removal happens on the same timeline as other CI jobs like Claude review

# Output JSON
echo "{\"pr_url\":\"$PR_URL\",\"pr_number\":\"$PR_NUMBER\",\"branch\":\"$BRANCH\"}"
