#!/bin/bash

# start-agent-session.sh - Ensure agent and companion tmux sessions exist for an issue
#
# Usage: start-agent-session.sh --issue-key <KEY> --repo-name <NAME> --worktree <PATH> [--init-cmd <CMD>] [--companion-command <CMD>] [--no-agent] [--skip-permissions] [--agent-command <CMD>] [--agent-args <ARGS>] [--agent-resume-args <ARGS>] [--agent-is-claude <true|false>] [--agent-launch-flags <FLAGS>] [--agent-profile <NAME>]
#
# Creates detached tmux sessions (repo-qualified):
#   agent-<REPO>-<KEY>      — runs the configured agent (default: Claude Code)
#   companion-<REPO>-<KEY>  — runs the companion command (default: gitui; see --companion-command)
#
# Idempotent: if sessions already exist, does nothing. A live pre-STE-2
# claude-<REPO>-<KEY> session is renamed to the agent- name instead of being
# duplicated, preserving its running conversation.
# --companion-command: command for the companion pane (default "GIT_OPTIONAL_LOCKS=0 gitui").
#                      An empty string leaves a plain shell. Resolved per-profile by idow.
# --no-agent: create sessions but don't launch the agent/companion command (for testing)
# --skip-permissions: pass --dangerously-skip-permissions to claude (claude agents only)
# --agent-launch-flags: the agent profile's model/effort flags, already
#                     rendered and shell-quoted by resolve-agent-config.sh
#                     (e.g. "-m gpt-5.5 -c model_reasoning_effort=high").
#                     Empty or omitted means no flag at all (the agent's
#                     own default wins).
# --agent-command / --agent-args / --agent-resume-args / --agent-is-claude:
#                     the agent profile resolved by resolve-agent-config.sh
#                     (agent_profiles.<name> in .pappardelle.yml). --agent-is-claude
#                     (pre-trust, --name/model/effort/dsp injection) is
#                     required with --agent-command. Without --agent-command
#                     the built-in claude agent profile runs, resuming with
#                     --continue unless --agent-resume-args says otherwise.
#                     idow passes resume args with {session_id} already
#                     filled in, or empty when no session is recorded.
# --agent-profile: the agent profile's name in agent_profiles: (default: claude).
#                  Set on the agent session as PAPPARDELLE_AGENT_PROFILE so the
#                  hook that records its session id (hooks/agent_session.py)
#                  can tag it.

set -e

ISSUE_KEY=""
REPO_NAME=""
WORKTREE_PATH=""
INIT_CMD=""
NO_AGENT=false
SKIP_PERMISSIONS=false
AGENT_COMMAND=""
AGENT_ARGS=""
AGENT_RESUME_ARGS=""
AGENT_RESUME_ARGS_SET=false
AGENT_IS_CLAUDE=""
AGENT_LAUNCH_FLAGS=""
AGENT_PROFILE="claude"
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
        --no-agent)
            NO_AGENT=true
            shift
            ;;
        --skip-permissions)
            SKIP_PERMISSIONS=true
            shift
            ;;
        --agent-command)
            AGENT_COMMAND="$2"
            shift 2
            ;;
        --agent-args)
            AGENT_ARGS="$2"
            shift 2
            ;;
        --agent-resume-args)
            AGENT_RESUME_ARGS="$2"
            AGENT_RESUME_ARGS_SET=true
            shift 2
            ;;
        --agent-profile)
            AGENT_PROFILE="$2"
            shift 2
            ;;
        --agent-launch-flags)
            AGENT_LAUNCH_FLAGS="$2"
            shift 2
            ;;
        --agent-is-claude)
            AGENT_IS_CLAUDE="$2"
            shift 2
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

if [[ -z "$AGENT_COMMAND" ]]; then
    AGENT_COMMAND="claude"
    AGENT_IS_CLAUDE="true"
    [[ "$AGENT_RESUME_ARGS_SET" == true ]] || AGENT_RESUME_ARGS="--continue"
elif [[ "$AGENT_IS_CLAUDE" != "true" && "$AGENT_IS_CLAUDE" != "false" ]]; then
    echo "Error: --agent-command requires --agent-is-claude true|false" >&2
    exit 1
fi

SESSION_KEY="${ISSUE_KEY//_/__}"
SESSION_KEY="${SESSION_KEY//./_}"
AGENT_SESSION="agent-${REPO_NAME}-${SESSION_KEY}"
LEGACY_AGENT_SESSION="claude-${REPO_NAME}-${SESSION_KEY}"
COMPANION_SESSION="companion-${REPO_NAME}-${SESSION_KEY}"
# Session lookups use `=NAME` targets: a bare name falls back to prefix
# matching when no session has it exactly, so STA-1's checks would find (and
# the legacy rename would take) STA-12's sessions.

# Per-issue agent/companion sessions live on a dedicated tmux socket so the
# nested viewer pane in Pappardelle can attach without `TMUX=` (which would
# otherwise defeat $TMUX propagation to subprocesses like Claude Code's
# Agent Teams feature). See STA-860 for the full rationale and the matching
# INNER_SOCKET constant in pappardelle/source/tmux.ts.
PAPPARDELLE_TMUX_SOCKET="${PAPPARDELLE_TMUX_SOCKET:-pappardelle_inner}"

# Set on the tmux session rather than exported here: these sessions are created
# on a long-lived server that inherited its environment from whatever started
# it, so a plain export would never reach the panes. Claude Code's hooks read
# it to find the main checkout without walking back out of the worktree.
# PAPPARDELLE_SPACE names the space the pane belongs to, so a Claude started
# later in the pane by hand (a restart, `claude --resume` from another
# directory) still reports its status under this space, not under its cwd.
SESSION_ENV=(-e "PAPPARDELLE_SPACE=$ISSUE_KEY")
if [[ -n "${PAPPARDELLE_MAIN_REPO_ROOT:-}" ]]; then
    SESSION_ENV+=(-e "PAPPARDELLE_MAIN_REPO_ROOT=$PAPPARDELLE_MAIN_REPO_ROOT")
fi
# Only the agent session gets these, mirroring buildAgentSessionEnvArgs() in
# source/spawn-env.ts: an agent started by hand in the companion pane isn't the
# space's agent, so its session id must not be recorded.
AGENT_SESSION_ENV=(
    -e "PAPPARDELLE_AGENT_PROFILE=$AGENT_PROFILE"
    -e "PAPPARDELLE_AGENT_COMMAND=$AGENT_COMMAND"
    -e "PAPPARDELLE_SPACE_STATE=$HOME/.pappardelle/repos/$REPO_NAME/space-state/$ISSUE_KEY.json"
)

# Pre-trust the worktree directory for Claude Code (skipped for other agents:
# the trust dialog is a Claude Code behavior).
# Claude Code stores workspace trust in ~/.claude.json under projects.<path>.hasTrustDialogAccepted
# Without this, every new worktree triggers a "do you trust this folder?" prompt
# This trust dialog was introduced in Claude Code v2.1.53 for directories with risky project settings
# (e.g. .claude/commands/ with Bash tool access, hooks, etc.)
if [[ "$AGENT_IS_CLAUDE" == "true" ]]; then
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

# Launches are handed to tmux as the pane's command rather than typed at a
# prompt, so they never land in the user's shell history (pappardelle-2i0).
# The trailing `:` stops the interactive shell from exec'ing its last command
# in place, so it hands the terminal back when it exits. Without it, bash 3.2
# (macOS /bin/sh and /bin/bash) starts the login shell outside the terminal's
# foreground process group, where it spins at 100% CPU and never reads input.
new_launch_session() {
    local session="$1" command="$2"
    shift 2
    # shellcheck disable=SC2016 # expanded by the inner sh, not here
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$session" -c "$WORKTREE_PATH" "${SESSION_ENV[@]}" "$@" \
        /bin/sh -c '"$1" -ic "$2$(printf "\n:")"; exec "$1" -l' sh "${SHELL:-/bin/sh}" "$command"
}

# A live pre-STE-2 claude-<REPO>-<KEY> session is the same space mid-upgrade.
# Rename it in place (panes and running processes survive a rename) rather
# than spawning a duplicate agent beside it.
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$AGENT_SESSION" 2>/dev/null \
    && tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$LEGACY_AGENT_SESSION" 2>/dev/null; then
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" rename-session -t "=$LEGACY_AGENT_SESSION" "$AGENT_SESSION" 2>/dev/null || true
fi

if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$AGENT_SESSION" 2>/dev/null; then
    if [[ "$NO_AGENT" == true ]]; then
        tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$AGENT_SESSION" -c "$WORKTREE_PATH" "${SESSION_ENV[@]}" "${AGENT_SESSION_ENV[@]}"
    else
        # Claude agents get --dangerously-skip-permissions and --name set to the issue key so the session is findable via /resume
        # and shows up in the terminal title. Other agents run `{command} {args}`
        # plus their rendered model/effort flags. Flag order matches
        # buildAgentResumeCommand() in source/tmux.ts and open-iterm-agent.sh:
        #   command → --dangerously-skip-permissions → args → model/effort → --name
        # Model/effort flags precede the resume args so a resume subcommand
        # (codex's `resume`) still follows every flag.
        # Agent args and launch flags arrive as ready-made shell words, so
        # they're not quoted again.
        AGENT_CMD="$AGENT_COMMAND"
        if [[ "$AGENT_IS_CLAUDE" == "true" && "$SKIP_PERMISSIONS" == true ]]; then
            AGENT_CMD="${AGENT_CMD} --dangerously-skip-permissions"
        fi
        if [[ -n "$AGENT_ARGS" ]]; then
            AGENT_CMD="${AGENT_CMD} ${AGENT_ARGS}"
        fi
        if [[ -n "$AGENT_LAUNCH_FLAGS" ]]; then
            AGENT_CMD="${AGENT_CMD} ${AGENT_LAUNCH_FLAGS}"
        fi
        if [[ "$AGENT_IS_CLAUDE" == "true" ]]; then
            AGENT_CMD="${AGENT_CMD} --name $(printf '%q' "$ISSUE_KEY")"
        fi

        if [[ -n "$INIT_CMD" ]]; then
            AGENT_ARG="${INIT_CMD} ${ISSUE_KEY}"
        else
            AGENT_ARG="${ISSUE_KEY}"
        fi
        SAFE_ARG=$(printf '%q' "$AGENT_ARG")
        if [[ -n "$AGENT_RESUME_ARGS" ]]; then
            new_launch_session "$AGENT_SESSION" "${AGENT_CMD} ${AGENT_RESUME_ARGS} || { printf '\\033[A\\033[2K'; false; } || ${AGENT_CMD} ${SAFE_ARG}" "${AGENT_SESSION_ENV[@]}"
        else
            new_launch_session "$AGENT_SESSION" "${AGENT_CMD} ${SAFE_ARG}" "${AGENT_SESSION_ENV[@]}"
        fi
    fi
fi

# Ensure companion tmux session (default: gitui; overridable via --companion-command).
# An empty command leaves a plain shell.
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$COMPANION_SESSION" 2>/dev/null; then
    if [[ "$NO_AGENT" != true && -n "$COMPANION_COMMAND" ]]; then
        new_launch_session "$COMPANION_SESSION" "$COMPANION_COMMAND"
    else
        tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$COMPANION_SESSION" -c "$WORKTREE_PATH" "${SESSION_ENV[@]}"
    fi
fi
