#!/bin/bash

# open-iterm-claude.sh - Open iTerm with tmux/Claude and the companion pane
#
# Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --prompt "<prompt>" [--companion-command <CMD>] [--skip-permissions] [--model <MODEL>] [--effort <LEVEL>]
#
# Opens a new iTerm window with:
#   1. A tmux session running Claude (with --dangerously-skip-permissions if --skip-permissions is set)
#   2. The prompt is sent to Claude as-is (caller should include skill prefix like /idow)
#   3. A split pane running the companion command (default: gitui; see --companion-command)
#
# The window title is set to include the issue key.
#
# Exit code: 0 on success, 1 on failure

set -e

# Get the directory where this script lives (resolving symlinks)
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_SOURCE" ]]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
    SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
    [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"

# Parse arguments
WORKTREE=""
ISSUE_KEY=""
REPO_NAME=""
PROMPT=""
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
            # iTerm. Exists so test-claude-model-effort.sh can assert on the
            # flag string without side effects.
            PRINT_LAUNCH_FLAGS=true
            shift
            ;;
        --print-command)
            # Print the two shell command lines the AppleScript would type
            # (claude pane, then companion pane) and exit without opening iTerm.
            # The lines come from the AppleScript itself, so a test can execute
            # the real bytes rather than a bash-side reimplementation of them.
            PRINT_COMMAND=true
            shift
            ;;
        --effort)
            CLAUDE_EFFORT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --repo-name <name> --prompt \"<prompt>\" [--companion-command <CMD>] [--skip-permissions] [--model <MODEL>] [--effort <LEVEL>]"
            echo ""
            echo "Debug: --print-launch-flags prints the claude flag string; --print-command"
            echo "prints the two shell lines that would be typed. Neither opens iTerm."
            echo ""
            echo "Opens iTerm with tmux/Claude and the companion pane (default gitui) in split panes."
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

# Create the tmux session name based on repo and issue key
TMUX_SESSION="claude-${REPO_NAME}-${ISSUE_KEY}"

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
#      OUTER shell iTerm types it into — see the CLAUDE_FLAGS assignment below.
# That pairing is what lets any value through unharmed, so there's no charset
# restriction and nothing is ever silently dropped; the tmux path
# (start-claude-session.sh) reaches the same place with printf %q alone.
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

# Write the AppleScript to a temp file to avoid heredoc escaping issues
APPLESCRIPT=$(mktemp)
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
    -- "true" => return the assembled command lines instead of driving iTerm.
    -- Everything below this point that builds a string runs either way, so the
    -- printed lines are the exact bytes `write text` would send. Used by
    -- test-claude-model-effort.sh, which can then run them through a real shell.
    set printOnly to item 9 of argv

    -- Build the `tmux -L <socket>` prefix once. Inner sessions (claude /
    -- companion) live on a dedicated socket so Pappardelle's nested viewer
    -- pane can attach without TMUX=. See STA-860.
    set tmuxL to "tmux -L " & tmuxSocket

    -- Command assembly happens up front, outside the `tell application` block,
    -- so it is reachable (and testable) without automating iTerm.
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

    -- Companion pane: create a shell-based session so it persists even if the
    -- command exits (like claude sessions), send the companion command (skipped
    -- when empty => plain shell), then attach. All three commands target the same
    -- inner tmux socket so the attach doesn't need TMUX= (different socket => no
    -- nesting check). The companion command is an arbitrary user-authored shell
    -- string, so route it through a shell variable via `quoted form of` rather
    -- than embedding it in a single-quoted string — that way an embedded single
    -- quote (e.g. DESTDIR='/tmp') can't break out. send-keys then receives the
    -- value as one double-quoted arg, matching the safe pattern in
    -- start-claude-session.sh.
    set companionSession to "companion-" & repoName & "-" & issueKey
    set sendPart to ""
    if companionCommand is not equal to "" then
        set sendPart to "COMPANION_CMD=" & quoted form of companionCommand & "; " & tmuxL & " send-keys -t '" & companionSession & "' \"$COMPANION_CMD\" Enter 2>/dev/null; "
    end if
    set companionLine to "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & tmuxL & " new-session -d -s '" & companionSession & "' 2>/dev/null; " & sendPart & tmuxL & " attach -t '" & companionSession & "'"

    if printOnly is equal to "true" then
        return claudeLine & linefeed & companionLine
    end if

    tell application "iTerm"
        activate

        -- Create a new window
        set newWindow to (create window with default profile)

        tell newWindow
            tell current session
                -- Set the session name/title to include the issue key
                set name to issueKey

                write text claudeLine

                -- Wait for Claude to start
                delay 2
            end tell

            -- Create a vertical split for the companion command (in its own tmux session)
            -- Create shell-based session so it persists even if the command exits (like claude sessions)
            tell current session
                set newSession to (split vertically with default profile)
                tell newSession
                    set name to issueKey & " - companion"
                    write text companionLine
                end tell
            end tell
        end tell
    end tell
end run
APPLESCRIPT_END

# Run the AppleScript with arguments. The trailing argument is the print-only
# switch: when true the script returns the assembled command lines and never
# touches iTerm.
osascript "$APPLESCRIPT" "$ISSUE_KEY" "$WORKTREE" "$TMUX_SESSION" "$CLAUDE_PROMPT" "$REPO_NAME" "$LAUNCH_FLAGS" "$PAPPARDELLE_TMUX_SOCKET" "$COMPANION_COMMAND" "$PRINT_COMMAND"
rm -f "$APPLESCRIPT"

if [[ "$PRINT_COMMAND" == true ]]; then
    exit 0
fi

echo "iTerm window opened with Claude and companion pane for $ISSUE_KEY"
