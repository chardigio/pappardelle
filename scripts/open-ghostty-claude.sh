#!/bin/bash

# open-ghostty-claude.sh - Open a Ghostty tab with tmux/Claude and the companion pane
#
# Usage: open-ghostty-claude.sh --worktree <path> --issue-key <STA-XXX> --repo-name <name> --prompt "<prompt>" [--window-id <id>] [--companion-command <CMD>] [--skip-permissions] [--model <MODEL>] [--effort <LEVEL>]
#
# The Ghostty counterpart to open-iterm-claude.sh. Instead of a new window it
# opens a new tab in the window the Pappardelle TUI is running in, split into:
#   1. A tmux session running Claude (with --dangerously-skip-permissions if --skip-permissions is set)
#   2. A split pane running the companion command (default: gitui; see --companion-command)
#
# Requires Ghostty 1.3 or later for the AppleScript interface, which is macOS
# only. Ghostty has no +new-tab CLI action on any platform, so AppleScript is
# the only way to place a tab in a specific window.
#
# The AppleScript interface is a declared preview and is expected to change in
# Ghostty 1.4. When it breaks, this script exits non-zero and idow falls back to
# the iTerm launcher.
#
# The command assembly below is a verbatim copy of open-iterm-claude.sh, pinned
# by the byte-equality assertions in scripts/test-workspace-launchers.sh.
#
# Exit code: 0 on success, 1 on failure

set -e

# Parse arguments
WORKTREE=""
ISSUE_KEY=""
REPO_NAME=""
PROMPT=""
WINDOW_ID=""
SKIP_PERMISSIONS=false
CLAUDE_MODEL=""
CLAUDE_EFFORT=""
PRINT_LAUNCH_FLAGS=false
PRINT_COMMAND=false
# Default mirrors DEFAULT_COMPANION_COMMAND in pappardelle/source/config.ts.
# An empty value leaves a plain shell in the split pane.
COMPANION_COMMAND="GIT_OPTIONAL_LOCKS=0 gitui"

while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree)
            WORKTREE="$2"
            shift 2
            ;;
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --repo-name)
            REPO_NAME="$2"
            shift 2
            ;;
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        --window-id)
            # Ghostty window to place the tab in. idow captures this before the
            # slow parts of a workspace open, so the tab lands in the TUI's
            # window rather than whichever window is frontmost at the end.
            WINDOW_ID="$2"
            shift 2
            ;;
        --companion-command)
            COMPANION_COMMAND="$2"
            shift 2
            ;;
        --skip-permissions)
            SKIP_PERMISSIONS=true
            shift
            ;;
        --model)
            CLAUDE_MODEL="$2"
            shift 2
            ;;
        --print-launch-flags)
            # Print the resolved claude launch flags and exit without opening
            # Ghostty. Exists so test-claude-model-effort.sh can assert on the
            # flag string without side effects.
            PRINT_LAUNCH_FLAGS=true
            shift
            ;;
        --print-command)
            # Print the two shell command lines the AppleScript would type
            # (claude pane, then companion pane) and exit without opening
            # Ghostty. The lines come from the AppleScript itself, so a test can
            # execute the real bytes rather than a bash-side reimplementation.
            PRINT_COMMAND=true
            shift
            ;;
        --effort)
            CLAUDE_EFFORT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: open-ghostty-claude.sh --worktree <path> --issue-key <STA-XXX> --repo-name <name> --prompt \"<prompt>\" [--window-id <id>] [--companion-command <CMD>] [--skip-permissions] [--model <MODEL>] [--effort <LEVEL>]"
            echo ""
            echo "Debug: --print-launch-flags prints the claude flag string; --print-command"
            echo "prints the two shell lines that would be typed. Neither opens Ghostty."
            echo ""
            echo "Opens a Ghostty tab with tmux/Claude and the companion pane (default gitui) in split panes."
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$WORKTREE" ]]; then
    echo "Error: --worktree is required" >&2
    exit 1
fi

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: --issue-key is required" >&2
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

# The prompt is passed directly - the caller should include the skill prefix (e.g., /idow)
# If empty, Claude will start without any prompt (resume mode)
# In both cases, --continue is tried first to resume an existing Claude conversation
CLAUDE_PROMPT="$PROMPT"

# Build the launch-flag string appended to every `claude` invocation below
# (--dangerously-skip-permissions, --model, --effort — in that order, matching
# start-claude-session.sh and buildClaudeResumeCommand() in source/tmux.ts).
# Leading spaces are intentional — the value is concatenated onto the claude
# command word, so each space separates its flag cleanly.
#
# Two layers of quoting, because the string crosses two shells:
#   1. printf %q here makes each config-supplied value safe for the INNER shell
#      (tmux runs the new-session command through sh -c).
#   2. `quoted form of` in the AppleScript makes the whole string safe for the
#      OUTER shell Ghostty feeds it to — see the CLAUDE_FLAGS assignment below.
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

# Write the AppleScript to a temp file to avoid heredoc escaping issues.
# Removed via trap because set -e aborts here whenever Ghostty cannot be
# driven, which is the fallback path idow is built around.
APPLESCRIPT=$(mktemp)
trap 'rm -f "$APPLESCRIPT"' EXIT
cat > "$APPLESCRIPT" << 'APPLESCRIPT_END'
on run argv
    set issueKey to item 1 of argv
    set worktreePath to item 2 of argv
    set tmuxSession to item 3 of argv
    set claudePrompt to item 4 of argv
    set repoName to item 5 of argv
    set launchFlags to item 6 of argv
    set tmuxSocket to item 7 of argv
    set companionCommand to item 8 of argv
    -- "true" => return the assembled command lines instead of driving Ghostty.
    -- Everything below this point that builds a string runs either way, so the
    -- printed lines are the exact bytes the surface configuration would carry.
    set printOnly to item 9 of argv
    -- Empty => no window was captured, go straight to the front-window rung.
    set windowID to item 10 of argv
    -- Absolute path of the user's shell. Each Ghostty pane runs its line
    -- through it as `-ilc` instead of typing the line at a prompt, so nothing
    -- lands in the user's shell history (pappardelle-2i0).
    set userShell to item 11 of argv

    -- Build the `tmux -L <socket>` prefix once. Inner sessions (claude /
    -- companion) live on a dedicated socket so Pappardelle's nested viewer
    -- pane can attach without TMUX=. See STA-860.
    set tmuxL to "tmux -L " & tmuxSocket

    -- Command assembly happens up front, outside the `tell application` block,
    -- so it is reachable (and testable) without automating Ghostty.
    --
    -- Always try --continue first to resume an existing Claude conversation.
    -- If --continue fails (no prior session or crash), fall back to:
    --   resume mode (empty prompt): bare Claude
    --   normal mode: Claude with the skill prompt
    -- issueKey is always PROJECT-NUMBER format (safe for direct interpolation).
    -- The TS helper and start-claude-session.sh shell-quote for defense-in-depth;
    -- AppleScript string assembly makes quoting awkward, so we rely on caller
    -- validation here instead.
    --
    -- launchFlags (--model/--effort) is NOT interpolated into the double-quoted
    -- tmux argument — a quote or space in a config value would break the string
    -- apart. Instead it's assigned to a shell variable via `quoted form of` (the
    -- same pattern the companion command uses) and referenced as $CLAUDE_FLAGS.
    -- The outer shell expands it *after* quote processing, so only the inner
    -- `sh -c` ever parses the value — and the caller already ran each value
    -- through printf %q for exactly that parse. Empty flags yield CLAUDE_FLAGS=''
    -- and the command word is unchanged.
    set nameFlag to " --name " & issueKey
    set flagsAssign to "CLAUDE_FLAGS=" & quoted form of launchFlags & "; "
    set claudeCmd to "claude$CLAUDE_FLAGS" & nameFlag
    set claudePrefix to flagsAssign & "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & tmuxL & " new-session -A -s '" & tmuxSession & "' \"" & claudeCmd & " --continue || { printf '\\033[A\\033[2K'; false; } || " & claudeCmd
    if claudePrompt is equal to "" then
        set claudeLine to claudePrefix & "\""
    else
        set claudeLine to claudePrefix & " '" & claudePrompt & "'\""
    end if

    -- Companion pane: create-or-attach a session on the inner socket (so the
    -- attach doesn't need TMUX=; different socket => no nesting check). A new
    -- session runs the companion command with the same wrapper as
    -- start-claude-session.sh: the user's shell runs it interactively, then a
    -- login shell takes over when it exits. An empty command leaves a plain
    -- shell. The companion command is an arbitrary user-authored shell string,
    -- so route it through a shell variable via `quoted form of` rather than
    -- embedding it in a single-quoted string; that way an embedded single quote
    -- (e.g. DESTDIR='/tmp') can't break out.
    set companionSession to "companion-" & (text 8 thru -1 of tmuxSession)
    set companionAssign to ""
    set companionStart to tmuxL & " new-session -A -s '" & companionSession & "'"
    if companionCommand is not equal to "" then
        set companionAssign to "COMPANION_CMD=" & quoted form of companionCommand & "; "
        set companionStart to companionStart & " /bin/sh -c '\"$1\" -ic \"$2\"; exec \"$1\" -l' sh \"${SHELL:-/bin/sh}\" \"$COMPANION_CMD\""
    end if
    set companionLine to companionAssign & "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & companionStart

    if printOnly is equal to "true" then
        return claudeLine & linefeed & companionLine
    end if

    tell application "Ghostty"
        activate

        set cfg to (new surface configuration)
        set initial working directory of cfg to worktreePath
        set command of cfg to my paneCommand(userShell, claudeLine)

        -- Three rungs: the window idow captured, whatever window is frontmost
        -- now, and finally a brand new window when Ghostty has none open.
        set theTab to missing value
        if windowID is not equal to "" then
            try
                set theTab to (new tab in (first window whose id is windowID) with configuration cfg)
            end try
        end if
        if theTab is missing value then
            try
                set theTab to (new tab in front window with configuration cfg)
            on error
                set theTab to selected tab of (new window with configuration cfg)
            end try
        end if

        -- The tab is the open. Anything failing after it exists must not be
        -- reported as failure, or idow retries with the iTerm launcher and the
        -- user ends up with two terminals attached to the same tmux sessions.
        try
            set claudeTerm to focused terminal of theTab

            -- Wait for Claude to start, matching the iTerm launcher.
            delay 2

            set cfg2 to (new surface configuration)
            set initial working directory of cfg2 to worktreePath
            set command of cfg2 to my paneCommand(userShell, companionLine)
            split claudeTerm direction right with configuration cfg2
        on error errMsg
            return "warning: companion pane not opened: " & errMsg
        end try
    end tell
    return ""
end run

-- The line travels base64-encoded, the same as the iTerm launcher's, so none
-- of its quoting has to survive Ghostty's parsing of `command`; the user's
-- shell decodes it.
on paneCommand(userShell, lineText)
    set encoded to do shell script "printf %s " & quoted form of lineText & " | base64"
    return userShell & " -ilc 'eval \"$(printf %s " & encoded & " | base64 --decode)\"; exec \"$SHELL\" -l'"
end paneCommand
APPLESCRIPT_END

# Run the AppleScript with arguments. Argument 9 is the print-only switch: when
# true the script returns the assembled command lines and never touches Ghostty.
USER_SHELL=$(command -v "${SHELL:-zsh}" || echo /bin/zsh)
OSA_OUTPUT=$(osascript "$APPLESCRIPT" "$ISSUE_KEY" "$WORKTREE" "$TMUX_SESSION" "$CLAUDE_PROMPT" "$REPO_NAME" "$LAUNCH_FLAGS" "$PAPPARDELLE_TMUX_SOCKET" "$COMPANION_COMMAND" "$PRINT_COMMAND" "$WINDOW_ID" "$USER_SHELL")

if [[ "$PRINT_COMMAND" == true ]]; then
    printf '%s\n' "$OSA_OUTPUT"
    exit 0
fi

case "$OSA_OUTPUT" in
    warning:*)
        echo "$OSA_OUTPUT" >&2
        ;;
esac

echo "Ghostty tab opened with Claude and companion pane for $ISSUE_KEY"
