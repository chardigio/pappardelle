#!/bin/bash

# Test: start-claude-session.sh creates repo-qualified tmux sessions
#
# Usage: ./test-start-claude-session.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

# Unique prefix to avoid collisions with real sessions
TEST_PREFIX="test-$$"
TEST_REPO="testrepo-$$"

# Sessions created by start-claude-session.sh live on the Pappardelle inner
# tmux socket (see STA-860). Use a unique per-run socket name so parallel test
# runs don't interfere with each other or with a developer's live session.
PAPPARDELLE_TMUX_SOCKET="pappardelle_inner_test_$$"
export PAPPARDELLE_TMUX_SOCKET

cleanup() {
    # Kill the per-run inner tmux server wholesale. Each test run uses a unique
    # socket (pappardelle_inner_test_$$), so killing the server cleans up every
    # session created during the run without touching the developer's real
    # pappardelle_inner server.
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-server 2>/dev/null || true
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT

assert_eq() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected: $expected"
        echo "    Actual:   $actual"
        FAIL=$((FAIL + 1))
    fi
}

# ==========================================================================

echo -e "${BOLD}Test: creates repo-qualified claude tmux session${RESET}"
TMPDIR_ROOT=$(mktemp -d)
ISSUE_KEY="${TEST_PREFIX}-100"
WORKTREE_PATH="$TMPDIR_ROOT/worktree"
mkdir -p "$WORKTREE_PATH"

CLAUDE_SESSION="claude-${TEST_REPO}-${ISSUE_KEY}"
COMPANION_SESSION="companion-${TEST_REPO}-${ISSUE_KEY}"

# Precondition: no session
if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} precondition: session should not exist"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} precondition: no existing session"
    PASS=$((PASS + 1))
fi

# Run the script
"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-claude 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0" "0" "$EXIT_CODE"

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} claude session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude session created with repo-qualified name ($CLAUDE_SESSION)"
    FAIL=$((FAIL + 1))
fi

# Verify session working directory (resolve symlinks for macOS /var → /private/var)
SESSION_PATH=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -t "$CLAUDE_SESSION" -p '#{pane_current_path}' 2>/dev/null)
RESOLVED_WORKTREE=$(cd "$WORKTREE_PATH" && pwd -P)
RESOLVED_SESSION=$(cd "$SESSION_PATH" && pwd -P)
assert_eq "session has correct working directory" "$RESOLVED_WORKTREE" "$RESOLVED_SESSION"

# ==========================================================================

echo -e "\n${BOLD}Test: idempotent — skips creation when session already exists${RESET}"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-claude 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0 when session already exists" "0" "$EXIT_CODE"

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} session still exists (idempotent)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} session still exists (idempotent)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$CLAUDE_SESSION" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$COMPANION_SESSION" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: also creates repo-qualified companion session${RESET}"
ISSUE_KEY2="${TEST_PREFIX}-200"
WORKTREE_PATH2="$TMPDIR_ROOT/worktree2"
mkdir -p "$WORKTREE_PATH2"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY2" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH2" --no-claude 2>/dev/null

COMPANION_SESSION2="companion-${TEST_REPO}-${ISSUE_KEY2}"
if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$COMPANION_SESSION2" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} companion session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} companion session created with repo-qualified name ($COMPANION_SESSION2)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY2}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$COMPANION_SESSION2" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: --repo-name is required${RESET}"
OUTPUT=$("$SCRIPT_DIR/start-claude-session.sh" --issue-key "X-1" --worktree "/tmp" 2>&1 || true)
if echo "$OUTPUT" | grep -q "repo-name is required"; then
    echo -e "  ${GREEN}PASS${RESET} errors when --repo-name is missing"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} errors when --repo-name is missing"
    FAIL=$((FAIL + 1))
fi

# ==========================================================================

# ==========================================================================

echo -e "\n${BOLD}Test: without init cmd, claude command includes issue key${RESET}"
ISSUE_KEY3="${TEST_PREFIX}-300"
WORKTREE_PATH3="$TMPDIR_ROOT/worktree3"
mkdir -p "$WORKTREE_PATH3"

# Run WITHOUT --no-claude so it sends the actual command to tmux
"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY3" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH3" 2>/dev/null

sleep 0.3

# Capture the full scrollback to see the command that was typed
# -J joins wrapped lines so long commands aren't split across lines
PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -J -t "claude-${TEST_REPO}-${ISSUE_KEY3}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY3"; then
    echo -e "  ${GREEN}PASS${RESET} issue key included in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} issue key included in claude command"
    echo "    Expected pane to contain: $ISSUE_KEY3"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: with init cmd, claude command includes init cmd and issue key${RESET}"
ISSUE_KEY4="${TEST_PREFIX}-400"
WORKTREE_PATH4="$TMPDIR_ROOT/worktree4"
mkdir -p "$WORKTREE_PATH4"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY4" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH4" --init-cmd "/test-skill" 2>/dev/null

sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -J -t "claude-${TEST_REPO}-${ISSUE_KEY4}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "/test-skill" && echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY4"; then
    echo -e "  ${GREEN}PASS${RESET} init cmd + issue key in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} init cmd + issue key in claude command"
    echo "    Expected pane to contain: /test-skill and $ISSUE_KEY4"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: --continue error message is suppressed when no conversation exists${RESET}"
ISSUE_KEY5="${TEST_PREFIX}-500"
WORKTREE_PATH5="$TMPDIR_ROOT/worktree5"
mkdir -p "$WORKTREE_PATH5"

# Run WITHOUT --no-claude in a fresh worktree with no prior conversations.
# claude --continue should fail, but the error message should be erased from the pane.
"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY5" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH5" 2>/dev/null

# Wait for claude --continue to fail and the cleanup to execute
sleep 3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -t "claude-${TEST_REPO}-${ISSUE_KEY5}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "No conversation found to continue"; then
    echo -e "  ${RED}FAIL${RESET} error message should be suppressed"
    echo "    Pane contains: $(echo "$PANE_CONTENT" | grep 'No conversation')"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} error message suppressed"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: sessions land on the inner socket, not the default${RESET}"
ISSUE_KEY6="${TEST_PREFIX}-600"
WORKTREE_PATH6="$TMPDIR_ROOT/worktree6"
mkdir -p "$WORKTREE_PATH6"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY6" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH6" --no-claude 2>/dev/null

# Must exist on the inner socket
if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "claude-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} claude session is on the inner socket"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude session is on the inner socket"
    FAIL=$((FAIL + 1))
fi

# Must NOT exist on the default socket (STA-860: the whole point of the fix
# is that inner sessions move off the default socket so the viewer-pane
# attach doesn't collide with tmux's nesting check).
if tmux has-session -t "claude-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} claude session leaked onto the default socket"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} claude session did not leak onto the default socket"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true

# ==========================================================================

# STA-1829: --model / --effort are forwarded to the real claude invocation.
# A shim named `claude` on PATH records its argv, so these assertions read the
# actual command line claude was launched with rather than a pane transcript.
# The shim exits 0, so the `--continue` branch succeeds and runs exactly once.
#
# HOME is redirected to a throwaway dir for these two cases: the interactive
# shell tmux spawns would otherwise source the developer's ~/.zshrc and put the
# real claude ahead of the shim on PATH. It also keeps the pre-trust step out of
# the real ~/.claude.json.
echo -e "\n${BOLD}Test: --model / --effort reach the claude command line${RESET}"
ISSUE_KEY7="${TEST_PREFIX}-700"
WORKTREE_PATH7="$TMPDIR_ROOT/worktree7"
SHIM_DIR="$TMPDIR_ROOT/shim"
SHIM_HOME="$TMPDIR_ROOT/shim-home"
ARGV_LOG="$TMPDIR_ROOT/claude-argv.log"
mkdir -p "$WORKTREE_PATH7" "$SHIM_DIR" "$SHIM_HOME"
cat > "$SHIM_DIR/claude" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG"
exit 0
SHIM
chmod +x "$SHIM_DIR/claude"

# The sessions below need a server whose environment already has the shim on
# PATH, so they get their own socket (the shared one may already be running).
SHIM_SOCKET="pappardelle_inner_shim_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET" \
    "$SCRIPT_DIR/start-claude-session.sh" \
    --issue-key "$ISSUE_KEY7" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH7" \
    --model sonnet --effort high 2>/dev/null

sleep 1
ARGV=$(head -1 "$ARGV_LOG" 2>/dev/null || echo "")

if [[ "$ARGV" == *"--model sonnet"* ]]; then
    echo -e "  ${GREEN}PASS${RESET} --model reached claude ($ARGV)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} --model reached claude"
    echo "    argv: $ARGV"
    FAIL=$((FAIL + 1))
fi

if [[ "$ARGV" == *"--effort high"* ]]; then
    echo -e "  ${GREEN}PASS${RESET} --effort reached claude"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} --effort reached claude"
    echo "    argv: $ARGV"
    FAIL=$((FAIL + 1))
fi

if [[ "$ARGV" == "--model sonnet --effort high --name $ISSUE_KEY7 --continue" ]]; then
    echo -e "  ${GREEN}PASS${RESET} exact flag order: model → effort → name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} exact flag order: model → effort → name"
    echo "    Expected: --model sonnet --effort high --name $ISSUE_KEY7 --continue"
    echo "    Actual:   $ARGV"
    FAIL=$((FAIL + 1))
fi

tmux -L "$SHIM_SOCKET" kill-server 2>/dev/null || true

# ==========================================================================

# Off-by-default regression: omit both flags and the command line must be
# exactly what it was before STA-1829.
echo -e "\n${BOLD}Test: no --model/--effort → command line unchanged${RESET}"
ISSUE_KEY8="${TEST_PREFIX}-800"
WORKTREE_PATH8="$TMPDIR_ROOT/worktree8"
ARGV_LOG8="$TMPDIR_ROOT/claude-argv-8.log"
mkdir -p "$WORKTREE_PATH8"
cat > "$SHIM_DIR/claude" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG8"
exit 0
SHIM
chmod +x "$SHIM_DIR/claude"

SHIM_SOCKET8="pappardelle_inner_shim8_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET8" \
    "$SCRIPT_DIR/start-claude-session.sh" \
    --issue-key "$ISSUE_KEY8" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH8" \
    2>/dev/null

sleep 1
ARGV8=$(head -1 "$ARGV_LOG8" 2>/dev/null || echo "")
assert_eq "bare launch is --name + --continue only" "--name $ISSUE_KEY8 --continue" "$ARGV8"

tmux -L "$SHIM_SOCKET8" kill-server 2>/dev/null || true

# ==========================================================================

rm -rf "$TMPDIR_ROOT"

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
