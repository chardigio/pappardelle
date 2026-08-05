#!/bin/bash

# start-claude-session.sh - Ensure agent and companion tmux sessions exist for an issue
#
# Usage: start-claude-session.sh --issue-key <KEY> --repo-name <NAME> --worktree <PATH> [--init-cmd <CMD>] [--companion-command <CMD>] [--agent <claude|codex>] [--no-claude] [--skip-permissions]
#
# Creates detached tmux sessions (repo-qualified):
#   claude-<REPO>-<KEY>     — runs the agent CLI (see --agent)
#   companion-<REPO>-<KEY>  — runs the companion command (default: gitui; see --companion-command)
#
# The `claude-` session prefix is historical and stays put regardless of which
# harness runs inside: every consumer (viewer panes, the orphan reaper,
# sous-chef) keys off it, and renaming would be churn without benefit.
#
# Idempotent: if sessions already exist, does nothing.
# --agent: which agent CLI to launch (default "claude"). Resolved per-profile by idow.
# --companion-command: command for the companion pane (default "GIT_OPTIONAL_LOCKS=0 gitui").
#                      An empty string leaves a plain shell. Resolved per-profile by idow.
# --no-claude: create sessions but don't launch the agent/the companion command (for testing)
# --skip-permissions: pass the agent's approval-bypass flag

set -e

ISSUE_KEY=""
REPO_NAME=""
WORKTREE_PATH=""
INIT_CMD=""
AGENT_CLI="claude"
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
        --agent)
            AGENT_CLI="$2"
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

if [[ "$AGENT_CLI" != "claude" && "$AGENT_CLI" != "codex" ]]; then
    echo "Error: --agent must be \"claude\" or \"codex\" (got: $AGENT_CLI)" >&2
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

# Pre-trust the worktree directory for Claude Code.
# Claude Code stores workspace trust in ~/.claude.json under projects.<path>.hasTrustDialogAccepted
# Without this, every new worktree triggers a "do you trust this folder?" prompt
# This trust dialog was introduced in Claude Code v2.1.53 for directories with risky project settings
# (e.g. .claude/commands/ with Bash tool access, hooks, etc.)
#
# Skipped for agents that have no such prompt — Codex doesn't gate on workspace
# trust, so writing Claude's config file on its behalf would be meaningless.
if [[ "$AGENT_CLI" == "claude" ]]; then
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
fi

# Ensure the agent tmux session
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$CLAUDE_SESSION" -c "$WORKTREE_PATH"
    if [[ "$NO_CLAUDE" != true ]]; then
        # Build the agent command. Mirrors buildAgentResumeCommand() in
        # source/agents/registry.ts — the resume attempt first, then a fresh
        # session seeded with the initialization prompt. The ANSI escape rewinds
        # and clears the harness's "no conversation found" line so the fallback
        # doesn't leave it stranded on screen.
        SAFE_NAME=$(printf '%q' "$ISSUE_KEY")

        # Build the prompt argument, quoting it to handle special characters
        if [[ -n "$INIT_CMD" ]]; then
            AGENT_PROMPT="${INIT_CMD} ${ISSUE_KEY}"
        else
            AGENT_PROMPT="${ISSUE_KEY}"
        fi
        SAFE_ARG=$(printf '%q' "$AGENT_PROMPT")

        if [[ "$AGENT_CLI" == "codex" ]]; then
            # Codex has no --name; threads are identified by cwd + rollout file.
            AGENT_BASE="codex"
            if [[ "$SKIP_PERMISSIONS" == true ]]; then
                AGENT_BASE="codex --dangerously-bypass-approvals-and-sandbox"
            fi
            RESUME_CMD="${AGENT_BASE} resume --last"
            FRESH_CMD="${AGENT_BASE} ${SAFE_ARG}"
        else
            AGENT_BASE="claude"
            if [[ "$SKIP_PERMISSIONS" == true ]]; then
                AGENT_BASE="claude --dangerously-skip-permissions"
            fi
            RESUME_CMD="${AGENT_BASE} --name ${SAFE_NAME} --continue"
            FRESH_CMD="${AGENT_BASE} --name ${SAFE_NAME} ${SAFE_ARG}"
        fi

        tmux -L "$PAPPARDELLE_TMUX_SOCKET" send-keys -t "$CLAUDE_SESSION" "${RESUME_CMD} || { printf '\\033[A\\033[2K'; false; } || ${FRESH_CMD}" Enter
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
