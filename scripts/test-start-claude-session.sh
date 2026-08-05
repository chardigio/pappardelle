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
# STA-1850: --agent selects which harness launches
# ==========================================================================

echo -e "\n${BOLD}Test: --agent codex launches codex, not claude${RESET}"
ISSUE_KEY7="${TEST_PREFIX}-700"
WORKTREE_PATH7="$TMPDIR_ROOT/worktree7"
mkdir -p "$WORKTREE_PATH7"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY7" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH7" --agent codex 2>/dev/null
sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -J -t "claude-${TEST_REPO}-${ISSUE_KEY7}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "codex resume --last"; then
    echo -e "  ${GREEN}PASS${RESET} codex resume command sent"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} codex resume command sent"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

if echo "$PANE_CONTENT" | grep -qF -- "--name"; then
    echo -e "  ${RED}FAIL${RESET} codex must not be given Claude's --name flag"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} codex not given Claude-only flags"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY7}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY7}" 2>/dev/null || true

echo -e "\n${BOLD}Test: --agent codex --skip-permissions uses codex's bypass flag${RESET}"
ISSUE_KEY8="${TEST_PREFIX}-800"
WORKTREE_PATH8="$TMPDIR_ROOT/worktree8"
mkdir -p "$WORKTREE_PATH8"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY8" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH8" --agent codex --skip-permissions 2>/dev/null
sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -J -t "claude-${TEST_REPO}-${ISSUE_KEY8}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF -- "--dangerously-bypass-approvals-and-sandbox"; then
    echo -e "  ${GREEN}PASS${RESET} codex bypass flag used"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} codex bypass flag used"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY8}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY8}" 2>/dev/null || true

echo -e "\n${BOLD}Test: --agent defaults to claude when omitted${RESET}"
ISSUE_KEY9="${TEST_PREFIX}-900"
WORKTREE_PATH9="$TMPDIR_ROOT/worktree9"
mkdir -p "$WORKTREE_PATH9"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY9" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH9" 2>/dev/null
sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -J -t "claude-${TEST_REPO}-${ISSUE_KEY9}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF -- "claude --name"; then
    echo -e "  ${GREEN}PASS${RESET} defaults to claude (byte-identical to pre-STA-1850)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} defaults to claude"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY9}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY9}" 2>/dev/null || true

echo -e "\n${BOLD}Test: an unknown --agent is rejected${RESET}"
if "$SCRIPT_DIR/start-claude-session.sh" --issue-key "${TEST_PREFIX}-901" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH9" --agent cursor 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} should reject an unknown agent"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} rejects an unknown agent"
    PASS=$((PASS + 1))
fi

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
