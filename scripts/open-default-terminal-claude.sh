#!/bin/bash

# open-default-terminal-claude.sh - Open a workspace in the default terminal
#
# Usage: open-default-terminal-claude.sh --worktree <path> --issue-key <key> [options]
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
CLAUDE_MODEL=""
CLAUDE_EFFORT=""
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
        --model) CLAUDE_MODEL="$2"; shift 2 ;;
        --effort) CLAUDE_EFFORT="$2"; shift 2 ;;
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

# Create the tmux session name based on repo and issue key. The '.' → '_'
# encoding matches start-claude-session.sh; see the comment there.
SESSION_KEY="${ISSUE_KEY//_/__}"
SESSION_KEY="${SESSION_KEY//./_}"
TMUX_SESSION="claude-${REPO_NAME}-${SESSION_KEY}"

# Per-issue claude/companion sessions live on a dedicated tmux socket so the
# nested viewer pane in Pappardelle can attach without `TMUX=`. See STA-860.
PAPPARDELLE_TMUX_SOCKET="${PAPPARDELLE_TMUX_SOCKET:-pappardelle_inner}"

CLAUDE_PROMPT="$PROMPT"

# AppleScript's `quoted form of`, reproduced so the assembled lines match the
# other two launchers byte for byte: always single-quoted, embedded quotes
# closed and reopened around an escaped one.
quoted_form() {
    local escaped="'\\''"
    printf "'%s'" "${1//\'/$escaped}"
}

LAUNCH_FLAGS=""
if [[ "$SKIP_PERMISSIONS" == true ]]; then
    LAUNCH_FLAGS=" --dangerously-skip-permissions"
fi

append_launch_flag() {
    local flag="$1"
    local value="$2"
    [[ -z "$value" ]] && return 0
    LAUNCH_FLAGS="${LAUNCH_FLAGS} ${flag} $(printf '%q' "$value")"
    return 0
}

append_launch_flag "--model" "$CLAUDE_MODEL"
append_launch_flag "--effort" "$CLAUDE_EFFORT"

if [[ "$PRINT_LAUNCH_FLAGS" == true ]]; then
    printf '%s\n' "$LAUNCH_FLAGS"
    exit 0
fi

TMUX_L="tmux -L ${PAPPARDELLE_TMUX_SOCKET}"

# $CLAUDE_FLAGS stays literal here: the pane shell expands it after the value
# has crossed this script unparsed, the same two-layer scheme the AppleScript
# launchers use.
# shellcheck disable=SC2016  # $CLAUDE_FLAGS is expanded by the pane shell, not here
CLAUDE_CMD='claude$CLAUDE_FLAGS'" --name ${ISSUE_KEY}"
FLAGS_ASSIGN="CLAUDE_FLAGS=$(quoted_form "$LAUNCH_FLAGS"); "

CLAUDE_PREFIX="${FLAGS_ASSIGN}cd '${WORKTREE}' && printf '\\033]0;${ISSUE_KEY}\\007' && ${TMUX_L} new-session -A -s '${TMUX_SESSION}' \"${CLAUDE_CMD} --continue || { printf '\\033[A\\033[2K'; false; } || ${CLAUDE_CMD}"
if [[ -z "$CLAUDE_PROMPT" ]]; then
    CLAUDE_LINE="${CLAUDE_PREFIX}\""
else
    CLAUDE_LINE="${CLAUDE_PREFIX} '${CLAUDE_PROMPT}'\""
fi

COMPANION_SESSION="companion-${TMUX_SESSION:7}"
COMPANION_ASSIGN=""
COMPANION_START="${TMUX_L} new-session -A -s '${COMPANION_SESSION}'"
if [[ -n "$COMPANION_COMMAND" ]]; then
    COMPANION_ASSIGN="COMPANION_CMD=$(quoted_form "$COMPANION_COMMAND"); "
    # shellcheck disable=SC2016 # expanded by the pane shell, not here
    COMPANION_START="${COMPANION_START}"' /bin/sh -c '"'"'"$1" -ic "$2"; exec "$1" -l'"'"' sh "${SHELL:-/bin/sh}" "$COMPANION_CMD"'
fi
COMPANION_LINE="${COMPANION_ASSIGN}cd '${WORKTREE}' && printf '\\033]0;${ISSUE_KEY}\\007' && ${COMPANION_START}"

if [[ "$PRINT_COMMAND" == true ]]; then
    printf '%s\n%s\n' "$CLAUDE_LINE" "$COMPANION_LINE"
    exit 0
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
    printf 'CLAUDE_PANE=%q\n' "$CLAUDE_LINE"
    printf 'COMPANION_PANE=%q\n' "$COMPANION_LINE"
    cat <<'LAUNCHER_END'

# Reopening attaches to the viewer already there; splitting again would stack
# a duplicate pane pair on every press of `o`. A viewer down to one pane lost
# the session behind the other (the TUI's kill deletes the inner Claude
# session), and reattaching it would never bring that pane back.
if tmux has-session -t "=$VIEW_SESSION" 2>/dev/null; then
    if [[ "$(tmux list-panes -t "=$VIEW_SESSION:" 2>/dev/null | wc -l)" -eq 2 ]]; then
        exec tmux attach -t "=$VIEW_SESSION"
    fi
    tmux kill-session -t "=$VIEW_SESSION"
fi

tmux new-session -d -s "$VIEW_SESSION" -c "$WORKTREE" "$CLAUDE_PANE"
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

echo "Default terminal opened with Claude and companion pane for $ISSUE_KEY"
