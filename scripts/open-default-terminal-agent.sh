#!/bin/bash

# open-default-terminal-agent.sh - Open a workspace in the default terminal
#
# Usage: open-default-terminal-agent.sh --worktree <path> --issue-key <key> [options]
#
# The last rung of idow's step 9, reached when the terminal is one Pappardelle
# cannot drive directly (no AppleScript dictionary, or terminal.app naming
# something other than iTerm/Ghostty) and when the iTerm and Ghostty launchers
# both fail.
#
# The two panes come from tmux rather than the terminal, which is what makes
# this work anywhere: macOS has no system-wide default terminal setting, only a
# handler for .command files, so the launch is a generated .command that `open`
# hands to whichever app the user has bound to it.
#
# The pane command lines are byte-identical to the ones the iTerm and Ghostty
# launchers assemble; test-workspace-launchers.sh pins all three together.

set -e

WORKTREE=""
ISSUE_KEY=""
REPO_NAME=""
PROMPT=""
COMPANION_COMMAND="GIT_OPTIONAL_LOCKS=0 gitui"
SKIP_PERMISSIONS=false
# The --agent-* flags follow the same rules as in start-agent-session.sh; see its
# header.
AGENT_COMMAND=""
AGENT_ARGS=""
AGENT_RESUME_ARGS=""
AGENT_RESUME_ARGS_SET=false
AGENT_IS_CLAUDE=""
AGENT_LAUNCH_FLAGS=""
AGENT_PROFILE="claude"
PRINT_LAUNCH_FLAGS=false
PRINT_COMMAND=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --issue-key) ISSUE_KEY="$2"; shift 2 ;;
        --repo-name) REPO_NAME="$2"; shift 2 ;;
        --prompt) PROMPT="$2"; shift 2 ;;
        --companion-command) COMPANION_COMMAND="$2"; shift 2 ;;
        --skip-permissions) SKIP_PERMISSIONS=true; shift ;;
        --agent-command) AGENT_COMMAND="$2"; shift 2 ;;
        --agent-args) AGENT_ARGS="$2"; shift 2 ;;
        --agent-resume-args) AGENT_RESUME_ARGS="$2"; AGENT_RESUME_ARGS_SET=true; shift 2 ;;
        --agent-is-claude) AGENT_IS_CLAUDE="$2"; shift 2 ;;
        --agent-launch-flags) AGENT_LAUNCH_FLAGS="$2"; shift 2 ;;
        --agent-profile) AGENT_PROFILE="$2"; shift 2 ;;
        --print-launch-flags) PRINT_LAUNCH_FLAGS=true; shift ;;
        --print-command) PRINT_COMMAND=true; shift ;;
        *) echo "Error: Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$WORKTREE" || -z "$ISSUE_KEY" ]]; then
    echo "Error: --worktree and --issue-key are required" >&2
    exit 1
fi

if [[ -z "$REPO_NAME" ]]; then
    echo "Error: --repo-name is required" >&2
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

# Create the tmux session name based on repo and issue key. The '.' → '_'
# encoding matches start-agent-session.sh; see the comment there.
SESSION_KEY="${ISSUE_KEY//_/__}"
SESSION_KEY="${SESSION_KEY//./_}"
TMUX_SESSION="agent-${REPO_NAME}-${SESSION_KEY}"
LEGACY_TMUX_SESSION="claude-${REPO_NAME}-${SESSION_KEY}"

# Per-issue agent/companion sessions live on a dedicated tmux socket so the
# nested viewer pane in Pappardelle can attach without `TMUX=`. See STA-860.
PAPPARDELLE_TMUX_SOCKET="${PAPPARDELLE_TMUX_SOCKET:-pappardelle_inner}"

AGENT_PROMPT="$PROMPT"

# AppleScript's `quoted form of`, reproduced so the assembled lines match the
# other two launchers byte for byte: always single-quoted, embedded quotes
# closed and reopened around an escaped one.
quoted_form() {
    local escaped="'\\''"
    printf "'%s'" "${1//\'/$escaped}"
}

LAUNCH_FLAGS=""
if [[ "$AGENT_IS_CLAUDE" == "true" && "$SKIP_PERMISSIONS" == true ]]; then
    LAUNCH_FLAGS=" --dangerously-skip-permissions"
fi
if [[ -n "$AGENT_ARGS" ]]; then
    LAUNCH_FLAGS="${LAUNCH_FLAGS} ${AGENT_ARGS}"
fi

# The agent profile's model/effort flags arrive rendered and already quoted
# for the inner shell by resolve-agent-config.sh, for any agent.
if [[ -n "$AGENT_LAUNCH_FLAGS" ]]; then
    LAUNCH_FLAGS="${LAUNCH_FLAGS} ${AGENT_LAUNCH_FLAGS}"
fi
if [[ "$AGENT_IS_CLAUDE" == "true" ]]; then
    NAME_FLAG=" --name ${ISSUE_KEY}"
else
    NAME_FLAG=""
fi

# Mirrors AGENT_SESSION_ENV in start-agent-session.sh: the agent's hook
# records its session id under these when this launcher creates the session.
SPACE_STATE="$HOME/.pappardelle/repos/$REPO_NAME/space-state/$ISSUE_KEY.json"

# Resume args carry their own leading space (concatenated onto the command).
AGENT_RESUME_STR="${AGENT_RESUME_ARGS:+ $AGENT_RESUME_ARGS}"

if [[ "$PRINT_LAUNCH_FLAGS" == true ]]; then
    printf '%s\n' "$LAUNCH_FLAGS"
    exit 0
fi

TMUX_L="tmux -L ${PAPPARDELLE_TMUX_SOCKET}"

# $AGENT_CMD, $AGENT_FLAGS and $AGENT_RESUME stay literal here: the pane shell
# expands them after the values have crossed this script unparsed, the same
# two-layer scheme the AppleScript launchers use.
# shellcheck disable=SC2016  # expanded by the pane shell, not here
AGENT_CMD_WORD='$AGENT_CMD$AGENT_FLAGS'"${NAME_FLAG}"
FLAGS_ASSIGN="AGENT_CMD=$(quoted_form "$AGENT_COMMAND"); AGENT_FLAGS=$(quoted_form "$LAUNCH_FLAGS"); AGENT_RESUME=$(quoted_form "$AGENT_RESUME_STR"); AGENT_PROFILE=$(quoted_form "$AGENT_PROFILE"); SPACE_STATE=$(quoted_form "$SPACE_STATE"); "
# shellcheck disable=SC2016  # expanded by the pane shell, not here
AGENT_ENV=' -e "PAPPARDELLE_AGENT_PROFILE=$AGENT_PROFILE" -e "PAPPARDELLE_AGENT_COMMAND=$AGENT_CMD" -e "PAPPARDELLE_SPACE_STATE=$SPACE_STATE"'
RESUME_CHAIN=""
if [[ -n "$AGENT_RESUME_STR" ]]; then
    # shellcheck disable=SC2016  # expanded by the pane shell, not here
    RESUME_CHAIN='$AGENT_RESUME'" || { printf '\\033[A\\033[2K'; false; } || ${AGENT_CMD_WORD}"
fi

AGENT_PREFIX="${FLAGS_ASSIGN}cd '${WORKTREE}' && printf '\\033]0;${ISSUE_KEY}\\007' && ${TMUX_L} new-session -A -s '${TMUX_SESSION}'${AGENT_ENV} \"${AGENT_CMD_WORD}${RESUME_CHAIN}"
if [[ -z "$AGENT_PROMPT" ]]; then
    AGENT_LINE="${AGENT_PREFIX}\""
else
    AGENT_LINE="${AGENT_PREFIX} '${AGENT_PROMPT}'\""
fi

COMPANION_SESSION="companion-${REPO_NAME}-${SESSION_KEY}"
COMPANION_ASSIGN=""
COMPANION_START="${TMUX_L} new-session -A -s '${COMPANION_SESSION}'"
if [[ -n "$COMPANION_COMMAND" ]]; then
    COMPANION_ASSIGN="COMPANION_CMD=$(quoted_form "$COMPANION_COMMAND"); "
    # shellcheck disable=SC2016 # expanded by the pane shell, not here
    COMPANION_START="${COMPANION_START}"' /bin/sh -c '"'"'"$1" -ic "$2$(printf "\n:")"; exec "$1" -l'"'"' sh "${SHELL:-/bin/sh}" "$COMPANION_CMD"'
fi
COMPANION_LINE="${COMPANION_ASSIGN}cd '${WORKTREE}' && printf '\\033]0;${ISSUE_KEY}\\007' && ${COMPANION_START}"

if [[ "$PRINT_COMMAND" == true ]]; then
    printf '%s\n%s\n' "$AGENT_LINE" "$COMPANION_LINE"
    exit 0
fi

# A live pre-STE-2 claude-<REPO>-<KEY> session is the same space mid-upgrade.
# Rename it in place so `new-session -A` below attaches to it instead of
# spawning a duplicate agent beside it. tmux may not be running yet; both
# checks are best-effort. `=NAME` targets for the same reason
# as start-agent-session.sh: a bare name can prefix-match another space.
if ! tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$TMUX_SESSION" 2>/dev/null \
    && tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$LEGACY_TMUX_SESSION" 2>/dev/null; then
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" rename-session -t "=$LEGACY_TMUX_SESSION" "$TMUX_SESSION" 2>/dev/null || true
fi

# The viewer session sits on the default socket, so its panes can attach to the
# inner socket without tmux's nesting check rejecting them.
VIEW_SESSION="pappardelle-view-${REPO_NAME}-${SESSION_KEY}"

# Kept under $HOME rather than mktemp: `open` returns as soon as the terminal is
# handed the file, so deleting it here would race the shell that has to read it.
# One stable name per workspace, overwritten on each open, so it never piles up.
LAUNCH_DIR="${HOME}/.pappardelle/launch"
mkdir -p "$LAUNCH_DIR"
CMD_FILE="${LAUNCH_DIR}/${REPO_NAME}-${SESSION_KEY}.command"

{
    printf '%s\n' '#!/bin/bash'
    printf 'VIEW_SESSION=%q\n' "$VIEW_SESSION"
    printf 'WORKTREE=%q\n' "$WORKTREE"
    printf 'AGENT_PANE=%q\n' "$AGENT_LINE"
    printf 'COMPANION_PANE=%q\n' "$COMPANION_LINE"
    cat <<'LAUNCHER_END'

# Reopening attaches to the viewer already there; splitting again would stack
# a duplicate pane pair on every press of `o`. A viewer down to one pane lost
# the session behind the other (the TUI's kill deletes the inner agent
# session), and reattaching it would never bring that pane back.
if tmux has-session -t "=$VIEW_SESSION" 2>/dev/null; then
    if [[ "$(tmux list-panes -t "=$VIEW_SESSION:" 2>/dev/null | wc -l)" -eq 2 ]]; then
        exec tmux attach -t "=$VIEW_SESSION"
    fi
    tmux kill-session -t "=$VIEW_SESSION"
fi

tmux new-session -d -s "$VIEW_SESSION" -c "$WORKTREE" "$AGENT_PANE"
tmux split-window -h -t "=$VIEW_SESSION:" -c "$WORKTREE" "$COMPANION_PANE"
tmux select-pane -t "=$VIEW_SESSION:.0"
exec tmux attach -t "=$VIEW_SESSION"
LAUNCHER_END
} > "$CMD_FILE"
chmod +x "$CMD_FILE"

if ! open "$CMD_FILE"; then
    echo "Error: could not open $CMD_FILE in a terminal" >&2
    exit 1
fi

echo "Default terminal opened with the agent and companion pane for $ISSUE_KEY"
