#!/bin/bash

# open-iterm-claude.sh - Open iTerm with tmux/Claude and lazygit
#
# Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --prompt "<prompt>"
#
# Opens a new iTerm window with:
#   1. A tmux session running Claude with --dangerously-skip-permissions
#   2. The prompt is sent to Claude as-is (caller should include skill prefix like /idow or /dow)
#   3. A split pane running lazygit
#
# The window title is set to include the issue key for AeroSpace organization.
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
PROMPT=""

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
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --prompt \"<prompt>\""
            echo ""
            echo "Opens iTerm with tmux/Claude and lazygit in split panes."
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

# Create the tmux session name based on issue key
TMUX_SESSION="claude-$ISSUE_KEY"

# The prompt is passed directly - the caller should include the skill prefix (/idow or /dow)
# If empty, Claude will start without any prompt (resume mode)
# In both cases, --continue is tried first to resume an existing Claude conversation
CLAUDE_PROMPT="$PROMPT"

# Write the AppleScript to a temp file to avoid heredoc escaping issues
APPLESCRIPT=$(mktemp)
cat > "$APPLESCRIPT" << 'APPLESCRIPT_END'
on run argv
    set issueKey to item 1 of argv
    set worktreePath to item 2 of argv
    set tmuxSession to item 3 of argv
    set claudePrompt to item 4 of argv

    tell application "iTerm"
        activate

        -- Create a new window
        set newWindow to (create window with default profile)

        tell newWindow
            tell current session
                -- Set the session name/title to include the issue key
                set name to issueKey

                -- Change to worktree directory and start tmux with Claude
                -- Always try --continue first to resume an existing Claude conversation.
                -- If --continue fails (no prior session or crash), fall back to:
                --   resume mode (empty prompt): bare Claude
                --   normal mode: Claude with the skill prompt
                if claudePrompt is equal to "" then
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && tmux new-session -A -s '" & tmuxSession & "' \"claude --dangerously-skip-permissions --continue 2>/dev/null || claude --dangerously-skip-permissions\""
                else
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && tmux new-session -A -s '" & tmuxSession & "' \"claude --dangerously-skip-permissions --continue 2>/dev/null || claude --dangerously-skip-permissions '" & claudePrompt & "'\""
                end if

                -- Wait for Claude to start
                delay 2
            end tell

            -- Create a vertical split for lazygit (in its own tmux session)
            -- Create shell-based session so it persists even if lazygit exits (like claude sessions)
            tell current session
                set newSession to (split vertically with default profile)
                tell newSession
                    set name to issueKey & " - lazygit"
                    -- Create session with shell (not lazygit directly), send lazygit command, then attach
                    -- This ensures session persists if user quits lazygit
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && tmux new-session -d -s 'lazygit-" & issueKey & "' 2>/dev/null; tmux send-keys -t 'lazygit-" & issueKey & "' lazygit Enter 2>/dev/null; TMUX= tmux attach -t 'lazygit-" & issueKey & "'"
                end tell
            end tell
        end tell
    end tell
end run
APPLESCRIPT_END

# Run the AppleScript with arguments
osascript "$APPLESCRIPT" "$ISSUE_KEY" "$WORKTREE" "$TMUX_SESSION" "$CLAUDE_PROMPT"
rm -f "$APPLESCRIPT"

# Position window immediately (position 6 = bottom right)
"$SCRIPT_DIR/position-window.sh" \
    --app "iTerm2" \
    --title "$ISSUE_KEY" \
    --workspace "$ISSUE_KEY" \
    --position 6 &

echo "iTerm window opened with Claude and lazygit for $ISSUE_KEY"
