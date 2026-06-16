#!/bin/bash

# start-claude-session.sh - Ensure Claude and companion tmux sessions exist for an issue
#
# Usage: start-claude-session.sh --issue-key <KEY> --repo-name <NAME> --worktree <PATH> [--init-cmd <CMD>] [--companion-command <CMD>] [--no-claude] [--skip-permissions]
#
# Creates detached tmux sessions (repo-qualified):
#   claude-<REPO>-<KEY>     — runs Claude (with --dangerously-skip-permissions if --skip-permissions is set)
#   companion-<REPO>-<KEY>  — runs the companion command (default: gitui; see --companion-command)
#
# Idempotent: if sessions already exist, does nothing.
# --companion-command: command for the companion pane (default "GIT_OPTIONAL_LOCKS=0 gitui").
#                      An empty string leaves a plain shell. Resolved per-profile by idow.
# --no-claude: create sessions but don't launch claude/the companion command (for testing)
# --skip-permissions: pass --dangerously-skip-permissions to claude

set -e

ISSUE_KEY=""
REPO_NAME=""
WORKTREE_PATH=""
INIT_CMD=""
NO_CLAUDE=false
SKIP_PERMISSIONS=false
# Default mirrors DEFAULT_COMPANION_COMMAND in pappardelle/source/config.ts.
# An empty value (passed explicitly via --companion-command "") leaves a plain
# shell; the non-empty default means the companion command is sent.
COMPANION_COMMAND="GIT_OPTIONAL_LOCKS=0 gitui"

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
        --companion-command)
            COMPANION_COMMAND="$2"
            shift 2
            ;;
        --no-claude)
            NO_CLAUDE=true
            shift
            ;;
        --skip-permissions)
            SKIP_PERMISSIONS=true
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
COMPANION_SESSION="companion-${REPO_NAME}-${ISSUE_KEY}"

# Per-issue claude/companion sessions live on a dedicated tmux socket so the
# nested viewer pane in Pappardelle can attach without `TMUX=` (which would
# otherwise defeat $TMUX propagation to subprocesses like Claude Code's
# Agent Teams feature). See STA-860 for the full rationale and the matching
# INNER_SOCKET constant in pappardelle/source/tmux.ts.
PAPPARDELLE_TMUX_SOCKET="${PAPPARDELLE_TMUX_SOCKET:-pappardelle_inner}"

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
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$CLAUDE_SESSION" -c "$WORKTREE_PATH"
    if [[ "$NO_CLAUDE" != true ]]; then
        # Build the Claude command with optional --dangerously-skip-permissions
        # and --name set to the issue key so the session is findable via /resume
        # and shows up in the terminal title.
        SAFE_NAME=$(printf '%q' "$ISSUE_KEY")
        CLAUDE_CMD="claude --name ${SAFE_NAME}"
        if [[ "$SKIP_PERMISSIONS" == true ]]; then
            CLAUDE_CMD="claude --dangerously-skip-permissions --name ${SAFE_NAME}"
        fi

        # Build the Claude prompt argument, quoting it to handle special characters
        if [[ -n "$INIT_CMD" ]]; then
            CLAUDE_ARG="${INIT_CMD} ${ISSUE_KEY}"
        else
            CLAUDE_ARG="${ISSUE_KEY}"
        fi
        # Use printf %q to safely quote the argument for the shell inside tmux
        SAFE_ARG=$(printf '%q' "$CLAUDE_ARG")
        tmux -L "$PAPPARDELLE_TMUX_SOCKET" send-keys -t "$CLAUDE_SESSION" "${CLAUDE_CMD} --continue || { printf '\\033[A\\033[2K'; false; } || ${CLAUDE_CMD} ${SAFE_ARG}" Enter
    fi
fi

# Ensure companion tmux session (default: gitui; overridable via --companion-command).
# A shell-based session is created first so the pane persists even if the
# command exits; an empty command leaves that plain shell untouched.
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$COMPANION_SESSION" 2>/dev/null; then
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$COMPANION_SESSION" -c "$WORKTREE_PATH"
    if [[ "$NO_CLAUDE" != true && -n "$COMPANION_COMMAND" ]]; then
        tmux -L "$PAPPARDELLE_TMUX_SOCKET" send-keys -t "$COMPANION_SESSION" "$COMPANION_COMMAND" Enter
    fi
fi
