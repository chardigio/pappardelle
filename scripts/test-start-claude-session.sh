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

cleanup() {
    # Kill all test sessions matching our unique repo name
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "$TEST_REPO" | while read -r session; do
        tmux kill-session -t "$session" 2>/dev/null || true
    done
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
LAZYGIT_SESSION="lazygit-${TEST_REPO}-${ISSUE_KEY}"

# Precondition: no session
if tmux has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
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

if tmux has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} claude session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude session created with repo-qualified name ($CLAUDE_SESSION)"
    FAIL=$((FAIL + 1))
fi

# Verify session working directory (resolve symlinks for macOS /var → /private/var)
SESSION_PATH=$(tmux display-message -t "$CLAUDE_SESSION" -p '#{pane_current_path}' 2>/dev/null)
RESOLVED_WORKTREE=$(cd "$WORKTREE_PATH" && pwd -P)
RESOLVED_SESSION=$(cd "$SESSION_PATH" && pwd -P)
assert_eq "session has correct working directory" "$RESOLVED_WORKTREE" "$RESOLVED_SESSION"

# ==========================================================================

echo -e "\n${BOLD}Test: idempotent — skips creation when session already exists${RESET}"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-claude 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0 when session already exists" "0" "$EXIT_CODE"

if tmux has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} session still exists (idempotent)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} session still exists (idempotent)"
    FAIL=$((FAIL + 1))
fi

tmux kill-session -t "$CLAUDE_SESSION" 2>/dev/null || true
tmux kill-session -t "$LAZYGIT_SESSION" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: also creates repo-qualified lazygit session${RESET}"
ISSUE_KEY2="${TEST_PREFIX}-200"
WORKTREE_PATH2="$TMPDIR_ROOT/worktree2"
mkdir -p "$WORKTREE_PATH2"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY2" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH2" --no-claude 2>/dev/null

LAZYGIT_SESSION2="lazygit-${TEST_REPO}-${ISSUE_KEY2}"
if tmux has-session -t "$LAZYGIT_SESSION2" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} lazygit session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} lazygit session created with repo-qualified name ($LAZYGIT_SESSION2)"
    FAIL=$((FAIL + 1))
fi

tmux kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY2}" 2>/dev/null || true
tmux kill-session -t "$LAZYGIT_SESSION2" 2>/dev/null || true

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
PANE_CONTENT=$(tmux capture-pane -t "claude-${TEST_REPO}-${ISSUE_KEY3}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY3"; then
    echo -e "  ${GREEN}PASS${RESET} issue key included in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} issue key included in claude command"
    echo "    Expected pane to contain: $ISSUE_KEY3"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true
tmux kill-session -t "lazygit-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: with init cmd, claude command includes init cmd and issue key${RESET}"
ISSUE_KEY4="${TEST_PREFIX}-400"
WORKTREE_PATH4="$TMPDIR_ROOT/worktree4"
mkdir -p "$WORKTREE_PATH4"

"$SCRIPT_DIR/start-claude-session.sh" --issue-key "$ISSUE_KEY4" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH4" --init-cmd "/test-skill" 2>/dev/null

sleep 0.3

PANE_CONTENT=$(tmux capture-pane -t "claude-${TEST_REPO}-${ISSUE_KEY4}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "/test-skill" && echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY4"; then
    echo -e "  ${GREEN}PASS${RESET} init cmd + issue key in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} init cmd + issue key in claude command"
    echo "    Expected pane to contain: /test-skill and $ISSUE_KEY4"
    echo "    Pane content: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux kill-session -t "claude-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true
tmux kill-session -t "lazygit-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true

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
