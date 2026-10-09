#!/bin/bash

# Test: start-agent-session.sh creates repo-qualified tmux sessions
#
# Usage: ./test-start-agent-session.sh

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

# Sessions created by start-agent-session.sh live on the Pappardelle inner
# tmux socket (see STA-860). Use a unique per-run socket name so parallel test
# runs don't interfere with each other or with a developer's live session.
PAPPARDELLE_TMUX_SOCKET="pappardelle_inner_test_$$"
export PAPPARDELLE_TMUX_SOCKET

# Every server the run starts, on any -L name, lands in this directory, so the
# exit trap can find them all: a test that aborts under `set -e` skips its own
# kill-server. Kept short because tmux socket paths are limited to ~104 bytes.
TMUX_TMPDIR=$(mktemp -d /tmp/pappardelle-test-tmux.XXXXXX)
export TMUX_TMPDIR

# shellcheck disable=SC2329  # invoked via trap
cleanup() {
    local socket pids pid
    for socket in "$TMUX_TMPDIR"/tmux-*/*; do
        [[ -S "$socket" ]] || continue
        pids=$(tmux -S "$socket" list-panes -a -F '#{pane_pid}' 2>/dev/null || true)
        tmux -S "$socket" kill-server 2>/dev/null || true
        # A pane shell that never got the terminal ignores the SIGHUP from
        # kill-server and keeps running as an orphan, so make sure.
        for pid in $pids; do
            pkill -9 -P "$pid" 2>/dev/null || true
            kill -9 "$pid" 2>/dev/null || true
        done
    done
    rm -rf "$TMUX_TMPDIR"
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT
# bash skips the EXIT trap when a signal kills it.
trap 'exit 130' INT
trap 'exit 143' TERM

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

# Poll for a shim argv log to appear. The command send-keys types runs in an
# interactive shell that sources the user's rc files first, so a fixed sleep
# is flaky under load — wait up to 15s instead.
wait_for_file() {
    local file="$1"
    for _ in $(seq 1 150); do
        [[ -s "$file" ]] && return 0
        sleep 0.1
    done
    return 1
}

# ==========================================================================

echo -e "${BOLD}Test: creates repo-qualified claude tmux session${RESET}"
TMPDIR_ROOT=$(mktemp -d)
ISSUE_KEY="${TEST_PREFIX}-100"
WORKTREE_PATH="$TMPDIR_ROOT/worktree"
mkdir -p "$WORKTREE_PATH"

CLAUDE_SESSION="agent-${TEST_REPO}-${ISSUE_KEY}"
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
"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-agent 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0" "0" "$EXIT_CODE"

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$CLAUDE_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} claude session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude session created with repo-qualified name ($CLAUDE_SESSION)"
    FAIL=$((FAIL + 1))
fi

# The session environment names the space, for a Claude started later in the pane
SPACE_ENV=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_SPACE 2>/dev/null)
assert_eq "session env carries PAPPARDELLE_SPACE" "PAPPARDELLE_SPACE=$ISSUE_KEY" "$SPACE_ENV"

# The agent's hook records its session id under these (hooks/agent_session.py)
assert_eq "agent session env names the agent" "PAPPARDELLE_AGENT_PROFILE=claude" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_AGENT_PROFILE 2>/dev/null)"
assert_eq "agent session env names the agent's command" "PAPPARDELLE_AGENT_COMMAND=claude" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_AGENT_COMMAND 2>/dev/null)"
assert_eq "agent session env names the space-state file" \
    "PAPPARDELLE_SPACE_STATE=$HOME/.pappardelle/repos/$TEST_REPO/space-state/$ISSUE_KEY.json" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_SPACE_STATE 2>/dev/null)"
# An agent started by hand in the companion isn't the space's agent
assert_eq "companion session env has no agent profile" "" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$COMPANION_SESSION" PAPPARDELLE_AGENT_PROFILE 2>/dev/null || true)"

# Verify session working directory (resolve symlinks for macOS /var → /private/var)
SESSION_PATH=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -t "$CLAUDE_SESSION" -p '#{pane_current_path}' 2>/dev/null)
RESOLVED_WORKTREE=$(cd "$WORKTREE_PATH" && pwd -P)
RESOLVED_SESSION=$(cd "$SESSION_PATH" && pwd -P)
assert_eq "session has correct working directory" "$RESOLVED_WORKTREE" "$RESOLVED_SESSION"

# ==========================================================================

echo -e "\n${BOLD}Test: idempotent — skips creation when session already exists${RESET}"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-agent 2>/dev/null
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

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY2" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH2" --no-agent 2>/dev/null

COMPANION_SESSION2="companion-${TEST_REPO}-${ISSUE_KEY2}"
if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$COMPANION_SESSION2" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} companion session created with repo-qualified name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} companion session created with repo-qualified name ($COMPANION_SESSION2)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY2}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$COMPANION_SESSION2" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: a session name that prefixes an existing one is distinct${RESET}"
# tmux -t resolves by prefix when no exact match exists, so STA-1 would find a
# live STA-12 and skip creating its own sessions, leaving the workspace
# attached to the wrong issue.
ISSUE_LONG="${TEST_PREFIX}-2500"
ISSUE_SHORT="${TEST_PREFIX}-250"
WORKTREE_PREFIX="$TMPDIR_ROOT/worktree-prefix"
mkdir -p "$WORKTREE_PREFIX"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_LONG" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PREFIX" --no-agent 2>/dev/null
"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_SHORT" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PREFIX" --no-agent 2>/dev/null

for kind in agent companion; do
    SHORT_SESSION="${kind}-${TEST_REPO}-${ISSUE_SHORT}"
    if tmux -L "$PAPPARDELLE_TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "$SHORT_SESSION"; then
        echo -e "  ${GREEN}PASS${RESET} $kind session created despite a longer session sharing its prefix"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $kind session created despite a longer session sharing its prefix ($SHORT_SESSION)"
        FAIL=$((FAIL + 1))
    fi
done

for key in "$ISSUE_LONG" "$ISSUE_SHORT"; do
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=agent-${TEST_REPO}-${key}" 2>/dev/null || true
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${key}" 2>/dev/null || true
done

# ==========================================================================

echo -e "\n${BOLD}Test: --repo-name is required${RESET}"
OUTPUT=$("$SCRIPT_DIR/start-agent-session.sh" --issue-key "X-1" --worktree "/tmp" 2>&1 || true)
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

# Run WITHOUT --no-agent so the session is started with the claude command
"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY3" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH3" 2>/dev/null

sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "agent-${TEST_REPO}-${ISSUE_KEY3}" '#{pane_start_command}' 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY3"; then
    echo -e "  ${GREEN}PASS${RESET} issue key included in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} issue key included in claude command"
    echo "    Expected start command to contain: $ISSUE_KEY3"
    echo "    Start command: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: with init cmd, claude command includes init cmd and issue key${RESET}"
ISSUE_KEY4="${TEST_PREFIX}-400"
WORKTREE_PATH4="$TMPDIR_ROOT/worktree4"
mkdir -p "$WORKTREE_PATH4"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY4" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH4" --init-cmd "/test-skill" 2>/dev/null

sleep 0.3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "agent-${TEST_REPO}-${ISSUE_KEY4}" '#{pane_start_command}' 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "/test-skill" && echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY4"; then
    echo -e "  ${GREEN}PASS${RESET} init cmd + issue key in claude command"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} init cmd + issue key in claude command"
    echo "    Expected start command to contain: /test-skill and $ISSUE_KEY4"
    echo "    Start command: $(echo "$PANE_CONTENT" | head -5)"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: --continue error message is suppressed when no conversation exists${RESET}"
ISSUE_KEY5="${TEST_PREFIX}-500"
WORKTREE_PATH5="$TMPDIR_ROOT/worktree5"
mkdir -p "$WORKTREE_PATH5"

# Run WITHOUT --no-agent in a fresh worktree with no prior conversations.
# claude --continue should fail, but the error message should be erased from the pane.
"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY5" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH5" 2>/dev/null

# Wait for claude --continue to fail and the cleanup to execute
sleep 3

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -t "agent-${TEST_REPO}-${ISSUE_KEY5}" -p -S - 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "No conversation found to continue"; then
    echo -e "  ${RED}FAIL${RESET} error message should be suppressed"
    echo "    Pane contains: $(echo "$PANE_CONTENT" | grep 'No conversation')"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} error message suppressed"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true

# ==========================================================================

echo -e "\n${BOLD}Test: sessions land on the inner socket, not the default${RESET}"
ISSUE_KEY6="${TEST_PREFIX}-600"
WORKTREE_PATH6="$TMPDIR_ROOT/worktree6"
mkdir -p "$WORKTREE_PATH6"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY6" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH6" --no-agent 2>/dev/null

# Must exist on the inner socket
if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "agent-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} claude session is on the inner socket"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude session is on the inner socket"
    FAIL=$((FAIL + 1))
fi

# Must NOT exist on the default socket (STA-860: the whole point of the fix
# is that inner sessions move off the default socket so the viewer-pane
# attach doesn't collide with tmux's nesting check).
if tmux has-session -t "agent-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} claude session leaked onto the default socket"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} claude session did not leak onto the default socket"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true

# ==========================================================================

# STA-1829: the rendered model/effort flags reach the real claude invocation.
# A shim named `claude` on PATH records its argv, so these assertions read the
# actual command line claude was launched with rather than a pane transcript.
# The shim exits 0, so the `--continue` branch succeeds and runs exactly once.
#
# HOME is redirected to a throwaway dir for these two cases: the interactive
# shell tmux spawns would otherwise source the developer's ~/.zshrc and put the
# real claude ahead of the shim on PATH. It also keeps the pre-trust step out of
# the real ~/.claude.json.
echo -e "\n${BOLD}Test: launch flags reach the claude command line${RESET}"
ISSUE_KEY7="${TEST_PREFIX}-700"
WORKTREE_PATH7="$TMPDIR_ROOT/worktree7"
SHIM_DIR="$TMPDIR_ROOT/shim"
SHIM_HOME="$TMPDIR_ROOT/shim-home"
ARGV_LOG="$TMPDIR_ROOT/claude-argv.log"
mkdir -p "$WORKTREE_PATH7" "$SHIM_DIR" "$SHIM_HOME"
# An empty rc keeps zsh's first-run wizard from taking over the interactive
# shell that runs the launch.
touch "$SHIM_HOME/.zshrc"
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
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY7" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH7" \
    --agent-launch-flags "--model sonnet --effort high" 2>/dev/null

wait_for_file "$ARGV_LOG" || true
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
echo -e "\n${BOLD}Test: no launch flags → command line unchanged${RESET}"
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
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY8" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH8" \
    2>/dev/null

wait_for_file "$ARGV_LOG8" || true
ARGV8=$(head -1 "$ARGV_LOG8" 2>/dev/null || echo "")
assert_eq "bare launch is --name + --continue only" "--name $ISSUE_KEY8 --continue" "$ARGV8"

tmux -L "$SHIM_SOCKET8" kill-server 2>/dev/null || true

# ==========================================================================

# pappardelle-2i0: launches must not be typed at a prompt, or the user's shell
# records them in its history file. An isolated zsh (ZDOTDIR) with its own
# HISTFILE and INC_APPEND_HISTORY writes every line it reads from the prompt
# straight to disk, so a typed launch would show up there immediately.
echo -e "\n${BOLD}Test: launches leave no trace in shell history${RESET}"
if ! ZSH_BIN=$(command -v zsh); then
    echo "  SKIP (zsh not installed)"
else
    HIST_ZDOTDIR="$TMPDIR_ROOT/zdotdir"
    HIST_FILE="$TMPDIR_ROOT/zsh_history"
    HIST_SHIM_DIR="$TMPDIR_ROOT/hist-shim"
    mkdir -p "$HIST_ZDOTDIR" "$HIST_SHIM_DIR" "$SHIM_HOME"
    cat > "$HIST_ZDOTDIR/.zshrc" <<ZSHRC
HISTFILE="$HIST_FILE"
HISTSIZE=1000
SAVEHIST=1000
setopt INC_APPEND_HISTORY
PATH="$HIST_SHIM_DIR:\$PATH"
ZSHRC
    for tool in claude gitui; do
        printf '#!/bin/bash\nexit 0\n' > "$HIST_SHIM_DIR/$tool"
        chmod +x "$HIST_SHIM_DIR/$tool"
    done

    # Starts a session pair on its own socket (the server inherits SHELL and
    # ZDOTDIR) and waits for the shims to exit.
    start_hist_session() {
        local socket="$1" key="$2" companion="$3"
        mkdir -p "$TMPDIR_ROOT/wt-$key"
        SHELL="$ZSH_BIN" ZDOTDIR="$HIST_ZDOTDIR" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$socket" \
            "$SCRIPT_DIR/start-agent-session.sh" \
            --issue-key "$key" --repo-name "$TEST_REPO" --worktree "$TMPDIR_ROOT/wt-$key" \
            --companion-command "$companion" 2>/dev/null
        sleep 2
    }

    HIST_SOCKET="pappardelle_inner_hist_$$"
    KEY9="${TEST_PREFIX}-900"
    start_hist_session "$HIST_SOCKET" "$KEY9" "GIT_OPTIONAL_LOCKS=0 gitui"

    if [[ -f "$HIST_FILE" ]] && grep -qE 'claude|gitui' "$HIST_FILE"; then
        echo -e "  ${RED}FAIL${RESET} history file has no launch entries"
        echo "    History: $(cat "$HIST_FILE")"
        FAIL=$((FAIL + 1))
    else
        echo -e "  ${GREEN}PASS${RESET} history file has no launch entries"
        PASS=$((PASS + 1))
    fi

    assert_eq "agent session leaves a shell after claude exits" "zsh" \
        "$(tmux -L "$HIST_SOCKET" display-message -p -t "agent-${TEST_REPO}-${KEY9}" '#{pane_current_command}' 2>/dev/null)"
    assert_eq "companion session leaves a shell after the command exits" "zsh" \
        "$(tmux -L "$HIST_SOCKET" display-message -p -t "companion-${TEST_REPO}-${KEY9}" '#{pane_current_command}' 2>/dev/null)"
    tmux -L "$HIST_SOCKET" kill-server 2>/dev/null || true

    # A user-authored companion command that ends in a comment or exits the
    # shell itself must still leave a shell behind.
    for companion in 'true # trailing comment' 'exit 3'; do
        SOCK="pappardelle_inner_hist_${RANDOM}_$$"
        KEY="${TEST_PREFIX}-9${RANDOM}"
        start_hist_session "$SOCK" "$KEY" "$companion"
        assert_eq "companion '$companion' leaves a shell" "zsh" \
            "$(tmux -L "$SOCK" display-message -p -t "companion-${TEST_REPO}-${KEY}" '#{pane_current_command}' 2>/dev/null)"
        tmux -L "$SOCK" kill-server 2>/dev/null || true
    done
fi

# ==========================================================================

# Pre-trust is claude-only. The claude shim runs above redirected HOME
# to SHIM_HOME, so ~/.claude.json must have appeared there; the codex run
# below must NOT create one in its own home.
echo -e "\n${BOLD}Test: pre-trust writes ~/.claude.json for claude agents only${RESET}"
if [[ -f "$SHIM_HOME/.claude.json" ]]; then
    echo -e "  ${GREEN}PASS${RESET} claude launch pre-trusted the worktree"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} claude launch pre-trusted the worktree"
    FAIL=$((FAIL + 1))
fi

# ==========================================================================

# A non-claude agent runs `{command} {args}` verbatim — no --name, no
# dsp, no pre-trust. With resume args the resume attempt runs
# first (shim exits 0, so the fallback never fires).
echo -e "\n${BOLD}Test: codex agent gets its own command line, no claude flags${RESET}"
ISSUE_KEY9="${TEST_PREFIX}-950"
WORKTREE_PATH9="$TMPDIR_ROOT/worktree9"
CODEX_HOME="$TMPDIR_ROOT/codex-home"
ARGV_LOG9="$TMPDIR_ROOT/codex-argv.log"
mkdir -p "$WORKTREE_PATH9" "$CODEX_HOME"
# An empty rc keeps zsh's first-run wizard from taking over the interactive
# shell that runs the launch.
touch "$CODEX_HOME/.zshrc"
cat > "$SHIM_DIR/codex" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG9"
exit 0
SHIM
chmod +x "$SHIM_DIR/codex"

SHIM_SOCKET9="pappardelle_inner_shim9_$$"
PATH="$SHIM_DIR:$PATH" HOME="$CODEX_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET9" \
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY9" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH9" \
    --skip-permissions \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "resume --last" --agent-is-claude false \
    2>/dev/null

wait_for_file "$ARGV_LOG9" || true
ARGV9=$(head -1 "$ARGV_LOG9" 2>/dev/null || echo "")
assert_eq "codex argv is args + resume args only" "--yolo resume --last" "$ARGV9"

if [[ -f "$CODEX_HOME/.claude.json" ]]; then
    echo -e "  ${RED}FAIL${RESET} codex launch must not pre-trust ~/.claude.json"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} codex launch skipped the ~/.claude.json pre-trust"
    PASS=$((PASS + 1))
fi

tmux -L "$SHIM_SOCKET9" kill-server 2>/dev/null || true

# ==========================================================================

# With empty resume args a non-claude agent launches directly with the
# prompt argument (init cmd + issue key) — no resume-fallback chain. The
# resolver sends "" for agents without resume_args; when the flag is omitted
# entirely the leaf script defaults to --continue for claude agents only.
echo -e "\n${BOLD}Test: codex agent without resume args launches directly with prompt${RESET}"
ISSUE_KEY10="${TEST_PREFIX}-1000"
WORKTREE_PATH10="$TMPDIR_ROOT/worktree10"
ARGV_LOG10="$TMPDIR_ROOT/codex-argv-10.log"
mkdir -p "$WORKTREE_PATH10"
cat > "$SHIM_DIR/codex" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG10"
exit 0
SHIM
chmod +x "$SHIM_DIR/codex"

SHIM_SOCKET10="pappardelle_inner_shim10_$$"
PATH="$SHIM_DIR:$PATH" HOME="$CODEX_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET10" \
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY10" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH10" \
    --init-cmd "/idow" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "" --agent-is-claude false \
    2>/dev/null

wait_for_file "$ARGV_LOG10" || true
ARGV10=$(head -1 "$ARGV_LOG10" 2>/dev/null || echo "")
assert_eq "codex launch-only argv is args + prompt" "--yolo /idow $ISSUE_KEY10" "$ARGV10"

tmux -L "$SHIM_SOCKET10" kill-server 2>/dev/null || true

# ==========================================================================

# The agent profile's model/effort flags arrive rendered and quoted by
# resolve-agent-config.sh. They must reach the agent as separate literal
# arguments, ahead of codex's `resume` subcommand.
echo -e "\n${BOLD}Test: --agent-launch-flags reach the agent before its resume args${RESET}"
ISSUE_KEY_LF="${TEST_PREFIX}-1050"
WORKTREE_PATH_LF="$TMPDIR_ROOT/worktree-launch-flags"
ARGV_LOG_LF="$TMPDIR_ROOT/codex-argv-launch-flags.log"
mkdir -p "$WORKTREE_PATH_LF"
cat > "$SHIM_DIR/codex" <<SHIM
#!/bin/bash
printf '<%s>' "\$@" >> "$ARGV_LOG_LF"
printf '\n' >> "$ARGV_LOG_LF"
exit 0
SHIM
chmod +x "$SHIM_DIR/codex"

SHIM_SOCKET_LF="pappardelle_inner_shim_lf_$$"
PATH="$SHIM_DIR:$PATH" HOME="$CODEX_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET_LF" \
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY_LF" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH_LF" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "resume abc" --agent-is-claude false \
    --agent-launch-flags "-m 'gpt-5.5 [1m]' -c model_reasoning_effort=high" \
    2>/dev/null

wait_for_file "$ARGV_LOG_LF" || true
assert_eq "launch flags sit between args and resume args" \
    "<--yolo><-m><gpt-5.5 [1m]><-c><model_reasoning_effort=high><resume><abc>" \
    "$(head -1 "$ARGV_LOG_LF" 2>/dev/null || echo "")"

tmux -L "$SHIM_SOCKET_LF" kill-server 2>/dev/null || true

# ==========================================================================

# --agent-is-claude true forces claude treatment for a wrapper whose
# basename isn't "claude" (e.g. a claude-local alias).
echo -e "\n${BOLD}Test: --agent-is-claude true gives a wrapper the claude flags${RESET}"
ISSUE_KEY11="${TEST_PREFIX}-1100"
WORKTREE_PATH11="$TMPDIR_ROOT/worktree11"
ARGV_LOG11="$TMPDIR_ROOT/wrapper-argv.log"
mkdir -p "$WORKTREE_PATH11"
cat > "$SHIM_DIR/claude-local" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG11"
exit 0
SHIM
chmod +x "$SHIM_DIR/claude-local"

SHIM_SOCKET11="pappardelle_inner_shim11_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET11" \
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY11" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH11" \
    --agent-launch-flags "--model sonnet" \
    --agent-command claude-local --agent-is-claude true --agent-resume-args --continue \
    2>/dev/null

wait_for_file "$ARGV_LOG11" || true
ARGV11=$(head -1 "$ARGV_LOG11" 2>/dev/null || echo "")
assert_eq "wrapper argv gets model/name/continue" "--model sonnet --name $ISSUE_KEY11 --continue" "$ARGV11"

tmux -L "$SHIM_SOCKET11" kill-server 2>/dev/null || true

# ==========================================================================

# A live legacy claude-<repo>-<key> session is renamed to the
# agent- name instead of a duplicate being created beside it.
echo -e "\n${BOLD}Test: legacy claude-* session is renamed, not duplicated${RESET}"
ISSUE_KEY12="${TEST_PREFIX}-1200"
WORKTREE_PATH12="$TMPDIR_ROOT/worktree12"
mkdir -p "$WORKTREE_PATH12"
LEGACY_SESSION="claude-${TEST_REPO}-${ISSUE_KEY12}"
RENAMED_SESSION="agent-${TEST_REPO}-${ISSUE_KEY12}"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$LEGACY_SESSION" -c "$WORKTREE_PATH12"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY12" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH12" --no-agent 2>/dev/null

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$RENAMED_SESSION" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} legacy session renamed to agent-*"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} legacy session renamed to agent-*"
    FAIL=$((FAIL + 1))
fi

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "$LEGACY_SESSION" 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} legacy claude-* name should be gone after rename"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} legacy claude-* name is gone after rename"
    PASS=$((PASS + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$RENAMED_SESSION" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY12}" 2>/dev/null || true

# ==========================================================================

# tmux falls back to prefix matching when no session has the exact name, so a
# bare `-t agent-<repo>-<KEY>1` lookup finds `agent-<repo>-<KEY>12`. Starting a
# space whose sessions don't exist yet must create them, and must leave
# another space's legacy session alone.
echo -e "\n${BOLD}Test: session checks never match another space's sessions by prefix${RESET}"
ISSUE_KEY13="${TEST_PREFIX}-130"
OTHER_KEY13="${TEST_PREFIX}-1300"
WORKTREE_PATH13="$TMPDIR_ROOT/worktree13"
mkdir -p "$WORKTREE_PATH13"
OTHER_LEGACY13="claude-${TEST_REPO}-${OTHER_KEY13}"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$OTHER_LEGACY13" -c "$WORKTREE_PATH13"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "companion-${TEST_REPO}-${OTHER_KEY13}" -c "$WORKTREE_PATH13"

"$SCRIPT_DIR/start-agent-session.sh" --issue-key "$ISSUE_KEY13" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH13" --no-agent 2>/dev/null

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=$OTHER_LEGACY13" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} other space's legacy session kept its name"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} other space's legacy session kept its name"
    FAIL=$((FAIL + 1))
fi

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=agent-${TEST_REPO}-${ISSUE_KEY13}" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} a fresh agent session was created for the new space"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} a fresh agent session was created for the new space"
    FAIL=$((FAIL + 1))
fi

if tmux -L "$PAPPARDELLE_TMUX_SOCKET" has-session -t "=companion-${TEST_REPO}-${ISSUE_KEY13}" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} a companion session was created despite another space's companion"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} a companion session was created despite another space's companion"
    FAIL=$((FAIL + 1))
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$OTHER_LEGACY13" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${OTHER_KEY13}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=agent-${TEST_REPO}-${ISSUE_KEY13}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${ISSUE_KEY13}" 2>/dev/null || true

# ==========================================================================

# A named agent profile must come with its resolved claude treatment; the script no
# longer guesses it from the command.
echo -e "\n${BOLD}Test: --agent-command without --agent-is-claude is an error${RESET}"
ISSUE_KEY14="${TEST_PREFIX}-1400"
SHIM_SOCKET14="pappardelle_inner_shim14_$$"
if PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET14" "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY14" --repo-name "$TEST_REPO" --worktree "$TMPDIR_ROOT" \
    --agent-command codex 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} script should exit non-zero"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} script exits non-zero"
    PASS=$((PASS + 1))
fi
if tmux -L "$SHIM_SOCKET14" has-session -t "=agent-${TEST_REPO}-${ISSUE_KEY14}" 2>/dev/null; then
    echo -e "  ${RED}FAIL${RESET} no session is created"
    FAIL=$((FAIL + 1))
else
    echo -e "  ${GREEN}PASS${RESET} no session is created"
    PASS=$((PASS + 1))
fi
tmux -L "$SHIM_SOCKET14" kill-server 2>/dev/null || true

# ==========================================================================

# macOS /bin/sh and /bin/bash are bash 3.2. If the launch leaves the terminal
# with the launch's process group, the login shell that follows never gets the
# foreground: it spins at 100% CPU without reading input and outlives
# kill-server as an orphan.
echo -e "\n${BOLD}Test: a bash pane is a working shell after the launch exits${RESET}"
ISSUE_KEY15="${TEST_PREFIX}-1500"
WORKTREE_PATH15="$TMPDIR_ROOT/worktree15"
ARGV_LOG15="$TMPDIR_ROOT/codex-argv-15.log"
mkdir -p "$WORKTREE_PATH15"
cat > "$SHIM_DIR/codex" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGV_LOG15"
exit 0
SHIM
chmod +x "$SHIM_DIR/codex"

SHIM_SOCKET15="pappardelle_inner_shim15_$$"
SHELL=/bin/bash PATH="$SHIM_DIR:$PATH" HOME="$CODEX_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET15" \
    "$SCRIPT_DIR/start-agent-session.sh" \
    --issue-key "$ISSUE_KEY15" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH15" \
    --companion-command "/usr/bin/true" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "" --agent-is-claude false \
    2>/dev/null

wait_for_file "$ARGV_LOG15" || true
for kind in agent companion; do
    REPLY_FILE="$TMPDIR_ROOT/bash-reply-$kind"
    tmux -L "$SHIM_SOCKET15" send-keys -t "=${kind}-${TEST_REPO}-${ISSUE_KEY15}:" -l "echo ok > $(printf '%q' "$REPLY_FILE")"
    tmux -L "$SHIM_SOCKET15" send-keys -t "=${kind}-${TEST_REPO}-${ISSUE_KEY15}:" Enter
    wait_for_file "$REPLY_FILE" || true
    assert_eq "$kind pane answers input" "ok" "$(cat "$REPLY_FILE" 2>/dev/null)"
done

tmux -L "$SHIM_SOCKET15" kill-server 2>/dev/null || true

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
