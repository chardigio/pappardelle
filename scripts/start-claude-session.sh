#!/bin/bash

# start-claude-session.sh - Ensure Claude and lazygit tmux sessions exist for an issue
#
# Usage: start-claude-session.sh --issue-key <KEY> --repo-name <NAME> --worktree <PATH> [--init-cmd <CMD>] [--no-claude]
#
# Creates detached tmux sessions (repo-qualified):
#   claude-<REPO>-<KEY>   — runs Claude with --dangerously-skip-permissions
#   lazygit-<REPO>-<KEY>  — runs lazygit
#
# Idempotent: if sessions already exist, does nothing.
# --no-claude: create sessions but don't launch claude/lazygit (for testing)

set -e

ISSUE_KEY=""
REPO_NAME=""
WORKTREE_PATH=""
INIT_CMD=""
NO_CLAUDE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --repo-name)
            REPO_NAME="$2"
            shift 2
            ;;
        --worktree)
            WORKTREE_PATH="$2"
            shift 2
            ;;
        --init-cmd)
            INIT_CMD="$2"
            shift 2
            ;;
        --no-claude)
            NO_CLAUDE=true
            shift
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

if [[ -z "$REPO_NAME" ]]; then
    echo "Error: --repo-name is required" >&2
    exit 1
fi

if [[ -z "$WORKTREE_PATH" ]]; then
    echo "Error: --worktree is required" >&2
    exit 1
fi

CLAUDE_SESSION="claude-${REPO_NAME}-${ISSUE_KEY}"
LAZYGIT_SESSION="lazygit-${REPO_NAME}-${ISSUE_KEY}"

# Ensure Claude tmux session
if ! tmux has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    tmux new-session -d -s "$CLAUDE_SESSION" -c "$WORKTREE_PATH"
    if [[ "$NO_CLAUDE" != true ]]; then
        # Build the Claude prompt argument, quoting it to handle special characters
        if [[ -n "$INIT_CMD" ]]; then
            CLAUDE_ARG="${INIT_CMD} ${ISSUE_KEY}"
        else
            CLAUDE_ARG="${ISSUE_KEY}"
        fi
        # Use printf %q to safely quote the argument for the shell inside tmux
        SAFE_ARG=$(printf '%q' "$CLAUDE_ARG")
        tmux send-keys -t "$CLAUDE_SESSION" "claude --dangerously-skip-permissions --continue 2>/dev/null || claude --dangerously-skip-permissions ${SAFE_ARG}" Enter
    fi
fi

# Ensure lazygit tmux session
if ! tmux has-session -t "$LAZYGIT_SESSION" 2>/dev/null; then
    tmux new-session -d -s "$LAZYGIT_SESSION" -c "$WORKTREE_PATH"
    if [[ "$NO_CLAUDE" != true ]]; then
        tmux send-keys -t "$LAZYGIT_SESSION" 'lazygit' Enter
    fi
fi
