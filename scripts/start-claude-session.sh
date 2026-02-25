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

# Pre-trust the worktree directory for Claude Code
# Claude Code stores workspace trust in ~/.claude.json under projects.<path>.hasTrustDialogAccepted
# Without this, every new worktree triggers a "do you trust this folder?" prompt
# This trust dialog was introduced in Claude Code v2.1.53 for directories with risky project settings
# (e.g. .claude/commands/ with Bash tool access, hooks, etc.)
python3 -c "
import json, os, sys
config_path = os.path.expanduser('~/.claude.json')
try:
    with open(config_path) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}
projects = config.setdefault('projects', {})
path = sys.argv[1]
if path not in projects:
    projects[path] = {}
if not projects[path].get('hasTrustDialogAccepted'):
    projects[path]['hasTrustDialogAccepted'] = True
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
" "$WORKTREE_PATH" 2>/dev/null || true

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
