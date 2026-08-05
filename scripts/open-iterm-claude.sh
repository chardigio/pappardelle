#!/bin/bash

# open-iterm-claude.sh - Open iTerm with tmux/the agent and the companion pane
#
# Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --prompt "<prompt>" [--companion-command <CMD>] [--agent <claude|codex>] [--skip-permissions]
#
# Opens a new iTerm window with:
#   1. A tmux session running the agent CLI (see --agent; --skip-permissions maps
#      to whichever approval-bypass flag that harness uses)
#   2. The prompt is sent to the agent as-is (caller should include skill prefix like /idow)
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
AGENT_CLI="claude"
SKIP_PERMISSIONS=false
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
        --agent)
            AGENT_CLI="$2"
            shift 2
            ;;
        --skip-permissions)
            SKIP_PERMISSIONS=true
            shift
            ;;
        --help|-h)
            echo "Usage: open-iterm-claude.sh --worktree <path> --issue-key <STA-XXX> --repo-name <name> --prompt \"<prompt>\" [--companion-command <CMD>] [--agent <claude|codex>] [--skip-permissions]"
            echo ""
            echo "Opens iTerm with tmux/the agent and the companion pane (default gitui) in split panes."
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

if [[ "$AGENT_CLI" != "claude" && "$AGENT_CLI" != "codex" ]]; then
    echo "Error: --agent must be \"claude\" or \"codex\" (got: $AGENT_CLI)" >&2
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

# Build the agent's resume and fresh-start commands here rather than in
# AppleScript. Mirrors buildAgentResumeCommand() in source/agents/registry.ts and
# the equivalent block in start-claude-session.sh; keeping the assembly in bash
# is what lets the AppleScript below stay harness-neutral.
#
# issueKey is always PROJECT-NUMBER format (validated upstream), so direct
# interpolation is safe here.
if [[ "$AGENT_CLI" == "codex" ]]; then
    AGENT_BASE="codex"
    if [[ "$SKIP_PERMISSIONS" == true ]]; then
        AGENT_BASE="codex --dangerously-bypass-approvals-and-sandbox"
    fi
    # Codex has no --name; threads are keyed by cwd + rollout file.
    AGENT_RESUME_CMD="$AGENT_BASE resume --last"
    AGENT_FRESH_CMD="$AGENT_BASE"
else
    AGENT_BASE="claude"
    if [[ "$SKIP_PERMISSIONS" == true ]]; then
        AGENT_BASE="claude --dangerously-skip-permissions"
    fi
    AGENT_RESUME_CMD="$AGENT_BASE --name $ISSUE_KEY --continue"
    AGENT_FRESH_CMD="$AGENT_BASE --name $ISSUE_KEY"
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
    set agentResumeCmd to item 6 of argv
    set tmuxSocket to item 7 of argv
    set companionCommand to item 8 of argv
    set agentFreshCmd to item 9 of argv

    -- Build the `tmux -L <socket>` prefix once. Inner sessions (claude /
    -- companion) live on a dedicated socket so Pappardelle's nested viewer
    -- pane can attach without TMUX=. See STA-860.
    set tmuxL to "tmux -L " & tmuxSocket

    tell application "iTerm"
        activate

        -- Create a new window
        set newWindow to (create window with default profile)

        tell newWindow
            tell current session
                -- Set the session name/title to include the issue key
                set name to issueKey

                -- Change to worktree directory and start tmux with the agent.
                -- Always try the resume command first to pick up an existing
                -- conversation in this worktree. If it fails (no prior session
                -- or a crash), fall back to:
                --   resume mode (empty prompt): a bare fresh session
                --   normal mode: a fresh session seeded with the skill prompt
                -- Both command strings are assembled by the shell above, so this
                -- block is identical for every harness.
                set agentChain to agentResumeCmd & " || { printf '\\033[A\\033[2K'; false; } || " & agentFreshCmd
                if claudePrompt is equal to "" then
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & tmuxL & " new-session -A -s '" & tmuxSession & "' \"" & agentChain & "\""
                else
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & tmuxL & " new-session -A -s '" & tmuxSession & "' \"" & agentChain & " '" & claudePrompt & "'\""
                end if

                -- Wait for Claude to start
                delay 2
            end tell

            -- Create a vertical split for the companion command (in its own tmux session)
            -- Create shell-based session so it persists even if the command exits (like claude sessions)
            tell current session
                set newSession to (split vertically with default profile)
                tell newSession
                    set name to issueKey & " - companion"
                    set companionSession to "companion-" & repoName & "-" & issueKey
                    -- Create session with shell (not the command directly), send the
                    -- companion command (skipped when empty → plain shell), then attach.
                    -- All three commands target the same inner tmux socket so the attach
                    -- doesn't need TMUX= (different socket → no nesting check).
                    -- The companion command is an arbitrary user-authored shell string,
                    -- so route it through a shell variable via `quoted form of` rather
                    -- than embedding it in a single-quoted string — that way an embedded
                    -- single quote (e.g. DESTDIR='/tmp') can't break out. send-keys then
                    -- receives the value as one double-quoted arg, matching the safe
                    -- pattern in start-claude-session.sh.
                    set sendPart to ""
                    if companionCommand is not equal to "" then
                        set sendPart to "COMPANION_CMD=" & quoted form of companionCommand & "; " & tmuxL & " send-keys -t '" & companionSession & "' \"$COMPANION_CMD\" Enter 2>/dev/null; "
                    end if
                    write text "cd '" & worktreePath & "' && printf '\\033]0;" & issueKey & "\\007' && " & tmuxL & " new-session -d -s '" & companionSession & "' 2>/dev/null; " & sendPart & tmuxL & " attach -t '" & companionSession & "'"
                end tell
            end tell
        end tell
    end tell
end run
APPLESCRIPT_END

# Run the AppleScript with arguments
osascript "$APPLESCRIPT" "$ISSUE_KEY" "$WORKTREE" "$TMUX_SESSION" "$CLAUDE_PROMPT" "$REPO_NAME" "$AGENT_RESUME_CMD" "$PAPPARDELLE_TMUX_SOCKET" "$COMPANION_COMMAND" "$AGENT_FRESH_CMD"
rm -f "$APPLESCRIPT"

echo "iTerm window opened with $AGENT_CLI and companion pane for $ISSUE_KEY"
