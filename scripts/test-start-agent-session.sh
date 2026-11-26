#!/bin/bash

# Test: start-agent-session.sh creates repo-qualified tmux sessions
#
# Usage: ./scripts/test-start-agent-session.sh (it puts itself under
# test/helpers/tmux-guard-run.sh)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"
run_under_tmux_guard "$0" "$@"

# A run inside a space inherits that space's PAPPARDELLE_*, and the state ones
# (PAPPARDELLE_STATE_DB, PAPPARDELLE_STATUS_SOCKET) would point the hooks past
# the throwaway HOME below.
for name in $(compgen -e | grep '^PAPPARDELLE_' | grep -v '^PAPPARDELLE_TEST_'); do unset "$name"; done

# Unique prefix to avoid collisions with real sessions
TEST_PREFIX="test-$$"
TEST_REPO="testrepo-$$"

# Sessions created by start-agent-session.sh live on the Pappardelle inner
# tmux socket (see STA-860). Use a unique per-run socket name so parallel test
# runs don't interfere with each other or with a developer's live session.
PAPPARDELLE_TMUX_SOCKET="pappardelle_inner_test_$$"
export PAPPARDELLE_TMUX_SOCKET

test_tmpdir TMPDIR_ROOT

# The sessions' hooks and the pre-trust step write under HOME
# (~/.pappardelle/repos, ~/.claude.json), so the run gets a HOME of its own.
# An empty rc keeps zsh's first-run wizard from taking over the shells tmux
# starts. Cases that need another HOME set it on the command.
export HOME="$TMPDIR_ROOT/home"
mkdir -p "$HOME"
touch "$HOME/.zshrc"

# Every case that launches an agent without a shim of its own gets this
# claude, never the real one. With no conversation to continue it fails the way
# claude does, so the erase of that message is exercised.
CLAUDE_SHIM_DIR="$TMPDIR_ROOT/claude-shim"
CLAUDE_SHIM_LOG="$TMPDIR_ROOT/claude-shim-argv.log"
mkdir -p "$CLAUDE_SHIM_DIR"
cat > "$CLAUDE_SHIM_DIR/claude" <<SHIM
#!/bin/bash
printf '%s\n' "\$*" >> "$CLAUDE_SHIM_LOG"
if [[ " \$* " == *" --continue "* ]]; then
    echo "No conversation found to continue."
    exit 1
fi
exec sleep 600
SHIM
chmod +x "$CLAUDE_SHIM_DIR/claude"
export PATH="$CLAUDE_SHIM_DIR:$PATH"

# assert_session <name> <session> [socket]: the session exists on the socket,
# the run's inner socket when none is given. assert_no_session: it does not.
assert_session() {
    local socket="${3:-$PAPPARDELLE_TMUX_SOCKET}"
    if tmux -L "$socket" has-session -t "$2" 2>/dev/null; then
        pass "$1"
    else
        fail "$1" "Expected session $2 on socket $socket"
    fi
}

assert_no_session() {
    local socket="${3:-$PAPPARDELLE_TMUX_SOCKET}"
    if tmux -L "$socket" has-session -t "$2" 2>/dev/null; then
        fail "$1" "Expected no session $2 on socket $socket"
    else
        pass "$1"
    fi
}

# start-agent-session.sh with the names idow passes it, the ones `pappardelle
# space get` reports. None of the keys and repos here needs tmux's escaping,
# so those are agent-<repo>-<key> and companion-<repo>-<key>. A call that
# names its own sessions keeps them.
start_session() {
    local args=("$@") key="" repo="" named=false index
    for ((index = 0; index < ${#args[@]}; index++)); do
        case "${args[index]}" in
            --issue-key) key="${args[index + 1]}" ;;
            --repo-name) repo="${args[index + 1]}" ;;
            --agent-session) named=true ;;
        esac
    done
    if [[ "$named" == false && -n "$key" && -n "$repo" ]]; then
        args+=(--agent-session "agent-$repo-$key" --companion-session "companion-$repo-$key"
            --legacy-agent-session "claude-$repo-$key")
    fi
    "$SCRIPT_DIR/start-agent-session.sh" "${args[@]}"
}

# ==========================================================================

section "creates repo-qualified claude tmux session"
ISSUE_KEY="${TEST_PREFIX}-100"
WORKTREE_PATH="$TMPDIR_ROOT/worktree"
mkdir -p "$WORKTREE_PATH"

CLAUDE_SESSION="agent-${TEST_REPO}-${ISSUE_KEY}"
COMPANION_SESSION="companion-${TEST_REPO}-${ISSUE_KEY}"

assert_no_session "precondition: no existing session" "$CLAUDE_SESSION"

# Run the script
start_session --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-agent \
    --agent-env "SPACED=a b" --agent-env "QUOTED=x'y" --agent-env "PI_PROGRAM_STATUS=0" 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0" "0" "$EXIT_CODE"

assert_session "claude session created with repo-qualified name" "$CLAUDE_SESSION"

# The session environment names the space, for a Claude started later in the pane
MAIN_PANE=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "=$COMPANION_SESSION:" '#{@pappa_pane}' 2>/dev/null)
assert_eq "companion's first pane is named main" "main" "$MAIN_PANE"

SPACE_ENV=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_SPACE 2>/dev/null)
assert_eq "session env carries PAPPARDELLE_SPACE" "PAPPARDELLE_SPACE=$ISSUE_KEY" "$SPACE_ENV"
assert_eq "session env carries PAPPARDELLE_REPO" "PAPPARDELLE_REPO=$TEST_REPO" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PAPPARDELLE_REPO 2>/dev/null)"

# The agent's hook finds its space and agent profile in the stores
# (plugins/pappardelle/hooks/agent_session.py), not in the session
assert_eq "agent session env has no session-id variables" "" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" | grep '^PAPPARDELLE_AGENT_' || true)"
# The agent profile's env
assert_eq "agent session env carries a profile var with a space" "SPACED=a b" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" SPACED 2>/dev/null)"
assert_eq "agent session env carries a profile var with a quote" "QUOTED=x'y" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" QUOTED 2>/dev/null)"
assert_eq "pappardelle's own agent var wins over a profile var of the same name" "PI_PROGRAM_STATUS=1" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$CLAUDE_SESSION" PI_PROGRAM_STATUS 2>/dev/null)"
assert_eq "companion session env has no profile var" "" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" show-environment -t "$COMPANION_SESSION" SPACED 2>/dev/null || true)"

# Verify session working directory (resolve symlinks for macOS /var → /private/var)
SESSION_PATH=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -t "$CLAUDE_SESSION" -p '#{pane_current_path}' 2>/dev/null)
RESOLVED_WORKTREE=$(cd "$WORKTREE_PATH" && pwd -P)
RESOLVED_SESSION=$(cd "$SESSION_PATH" && pwd -P)
assert_eq "session has correct working directory" "$RESOLVED_WORKTREE" "$RESOLVED_SESSION"

# ==========================================================================

section "idempotent — skips creation when session already exists"

start_session --issue-key "$ISSUE_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH" --no-agent 2>/dev/null
EXIT_CODE=$?

assert_eq "exits 0 when session already exists" "0" "$EXIT_CODE"

assert_session "session still exists (idempotent)" "$CLAUDE_SESSION"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$CLAUDE_SESSION" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$COMPANION_SESSION" 2>/dev/null || true

# ==========================================================================

section "also creates repo-qualified companion session"
ISSUE_KEY2="${TEST_PREFIX}-200"
WORKTREE_PATH2="$TMPDIR_ROOT/worktree2"
mkdir -p "$WORKTREE_PATH2"

start_session --issue-key "$ISSUE_KEY2" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH2" --no-agent 2>/dev/null

COMPANION_SESSION2="companion-${TEST_REPO}-${ISSUE_KEY2}"
assert_session "companion session created with repo-qualified name" "$COMPANION_SESSION2"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY2}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$COMPANION_SESSION2" 2>/dev/null || true

# ==========================================================================

section "a session name that prefixes an existing one is distinct"
# tmux -t resolves by prefix when no exact match exists, so STA-1 would find a
# live STA-12 and skip creating its own sessions, leaving the workspace
# attached to the wrong issue.
ISSUE_LONG="${TEST_PREFIX}-2500"
ISSUE_SHORT="${TEST_PREFIX}-250"
WORKTREE_PREFIX="$TMPDIR_ROOT/worktree-prefix"
mkdir -p "$WORKTREE_PREFIX"

start_session --issue-key "$ISSUE_LONG" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PREFIX" --no-agent 2>/dev/null
start_session --issue-key "$ISSUE_SHORT" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PREFIX" --no-agent 2>/dev/null

for kind in agent companion; do
    assert_session "$kind session created despite a longer session sharing its prefix" \
        "=${kind}-${TEST_REPO}-${ISSUE_SHORT}:"
done

for key in "$ISSUE_LONG" "$ISSUE_SHORT"; do
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=agent-${TEST_REPO}-${key}" 2>/dev/null || true
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${key}" 2>/dev/null || true
done

# ==========================================================================

section "the sessions get exactly the names passed"
# The names are decided when the space is created, so the script takes them
# as given, even ones the key and repo would never be spelled as.
NAMED_KEY="${TEST_PREFIX}-260"
NAMED_AGENT="hand_named-agent-$$"
NAMED_COMPANION="hand-named-companion-$$"
start_session --issue-key "$NAMED_KEY" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PREFIX" \
    --agent-session "$NAMED_AGENT" --companion-session "$NAMED_COMPANION" \
    --legacy-agent-session "hand_named-legacy-$$" --no-agent 2>/dev/null
NAMED_SESSIONS=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null |
    grep -- "^hand\|${NAMED_KEY}$" | sort | tr '\n' ' ')
EXPECTED_SESSIONS=$(printf '%s\n' "$NAMED_AGENT" "$NAMED_COMPANION" | sort | tr '\n' ' ')
assert_eq "only the passed agent and companion names exist" "$EXPECTED_SESSIONS" "$NAMED_SESSIONS"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$NAMED_AGENT:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$NAMED_COMPANION:" 2>/dev/null || true

# ==========================================================================

section "the socket is required"
OUTPUT=$(env -u PAPPARDELLE_TMUX_SOCKET "$SCRIPT_DIR/start-agent-session.sh" --issue-key "X-1" --repo-name "$TEST_REPO" \
    --worktree "/tmp" --agent-session agent-x --companion-session companion-x --legacy-agent-session claude-x 2>&1 || true)
assert_eq "errors without PAPPARDELLE_TMUX_SOCKET" \
    "Error: PAPPARDELLE_TMUX_SOCKET is required: idow exports the space's socket from pappardelle space get" "$OUTPUT"

# ==========================================================================

section "the session names are required"
OUTPUT=$("$SCRIPT_DIR/start-agent-session.sh" --issue-key "X-1" --repo-name "$TEST_REPO" --worktree "/tmp" 2>&1 || true)
assert_contains "errors when the session names are missing" \
    "--agent-session, --companion-session and --legacy-agent-session are required" "$OUTPUT"

# ==========================================================================

section "--repo-name is required"
OUTPUT=$(start_session --issue-key "X-1" --worktree "/tmp" 2>&1 || true)
assert_contains "errors when --repo-name is missing" "repo-name is required" "$OUTPUT"

# ==========================================================================

# ==========================================================================

section "without init cmd, claude command includes issue key"
ISSUE_KEY3="${TEST_PREFIX}-300"
WORKTREE_PATH3="$TMPDIR_ROOT/worktree3"
mkdir -p "$WORKTREE_PATH3"

# Run WITHOUT --no-agent so the session is started with the claude command
start_session --issue-key "$ISSUE_KEY3" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH3" 2>/dev/null

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "agent-${TEST_REPO}-${ISSUE_KEY3}" '#{pane_start_command}' 2>/dev/null || echo "")
assert_contains "issue key included in claude command" "$ISSUE_KEY3" "$PANE_CONTENT"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY3}" 2>/dev/null || true

# ==========================================================================

section "with init cmd, claude command includes init cmd and issue key"
ISSUE_KEY4="${TEST_PREFIX}-400"
WORKTREE_PATH4="$TMPDIR_ROOT/worktree4"
mkdir -p "$WORKTREE_PATH4"

start_session --issue-key "$ISSUE_KEY4" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH4" --init-cmd "/test-skill" 2>/dev/null

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "agent-${TEST_REPO}-${ISSUE_KEY4}" '#{pane_start_command}' 2>/dev/null || echo "")
if echo "$PANE_CONTENT" | grep -qF "/test-skill" && echo "$PANE_CONTENT" | grep -qF "$ISSUE_KEY4"; then
    pass "init cmd + issue key in claude command"
else
    fail "init cmd + issue key in claude command" \
        "Expected start command to contain: /test-skill and $ISSUE_KEY4" \
        "Start command: $(echo "$PANE_CONTENT" | head -5)"
fi

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY4}" 2>/dev/null || true

# ==========================================================================

section "--continue error message is suppressed when no conversation exists"
ISSUE_KEY5="${TEST_PREFIX}-500"
WORKTREE_PATH5="$TMPDIR_ROOT/worktree5"
mkdir -p "$WORKTREE_PATH5"

# Run WITHOUT --no-agent in a fresh worktree with no prior conversations.
# claude --continue should fail, but the error message should be erased from the pane.
start_session --issue-key "$ISSUE_KEY5" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH5" 2>/dev/null

# The fresh launch runs only after --continue failed and the erase ran.
shim_calls_for_key5() { grep -F -- "$ISSUE_KEY5" "$CLAUDE_SHIM_LOG" 2>/dev/null || true; }
# shellcheck disable=SC2329  # invoked through wait_until
fresh_launch_ran5() { shim_calls_for_key5 | grep -qv -- '--continue'; }
wait_until fresh_launch_ran5 || true
# The erase was printed before the fresh launch; give tmux time to draw it.
sleep 0.3
RESUME_CALL5=$(shim_calls_for_key5 | tail -2 | head -1)
FRESH_CALL5=$(shim_calls_for_key5 | tail -1)
if [[ "$RESUME_CALL5" == *" --continue"* && "$FRESH_CALL5" != *"--continue"* ]]; then
    pass "claude --continue failed, then the fresh launch ran"
else
    fail "claude --continue failed, then the fresh launch ran" \
        "claude calls: $(cat "$CLAUDE_SHIM_LOG" 2>/dev/null)"
fi

PANE_CONTENT=$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" capture-pane -t "agent-${TEST_REPO}-${ISSUE_KEY5}" -p -S - 2>/dev/null || echo "")
assert_not_contains "error message suppressed" "No conversation found to continue" "$PANE_CONTENT"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY5}" 2>/dev/null || true

# ==========================================================================

section "sessions land on the inner socket, not the default"
ISSUE_KEY6="${TEST_PREFIX}-600"
WORKTREE_PATH6="$TMPDIR_ROOT/worktree6"
mkdir -p "$WORKTREE_PATH6"

start_session --issue-key "$ISSUE_KEY6" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH6" --no-agent 2>/dev/null

assert_session "claude session is on the inner socket" "agent-${TEST_REPO}-${ISSUE_KEY6}"

# Must NOT exist on the default socket (STA-860: the whole point of the fix
# is that inner sessions move off the default socket so the viewer-pane
# attach doesn't collide with tmux's nesting check).
assert_no_session "claude session did not leak onto the default socket" "agent-${TEST_REPO}-${ISSUE_KEY6}" default

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "agent-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY6}" 2>/dev/null || true

# ==========================================================================

# STA-1829: the rendered model/effort flags reach the real claude invocation.
# A shim named `claude` on PATH records its argv, so these assertions read the
# actual command line claude was launched with rather than a pane transcript.
# The shim exits 0, so the `--continue` branch succeeds and runs exactly once.
#
# These two cases get a HOME of their own, apart from the run's: the pre-trust
# check further down reads $SHIM_HOME/.claude.json to see that only the claude
# launch wrote one.
section "launch flags reach the claude command line"
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
    start_session \
    --issue-key "$ISSUE_KEY7" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH7" \
    --agent-launch-flags "--model sonnet --effort high" 2>/dev/null

wait_until test -s "$ARGV_LOG" || true
ARGV=$(head -1 "$ARGV_LOG" 2>/dev/null || echo "")

assert_contains "--model reached claude" "--model sonnet" "$ARGV"
assert_contains "--effort reached claude" "--effort high" "$ARGV"

assert_eq "exact flag order: model → effort → name" "--model sonnet --effort high --name $ISSUE_KEY7 --continue" "$ARGV"

tmux -L "$SHIM_SOCKET" kill-server 2>/dev/null || true

# ==========================================================================

# Off-by-default regression: omit both flags and the command line must be
# exactly what it was before STA-1829.
section "no launch flags → command line unchanged"
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
    start_session \
    --issue-key "$ISSUE_KEY8" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH8" \
    2>/dev/null

wait_until test -s "$ARGV_LOG8" || true
ARGV8=$(head -1 "$ARGV_LOG8" 2>/dev/null || echo "")
assert_eq "bare launch is --name + --continue only" "--name $ISSUE_KEY8 --continue" "$ARGV8"

tmux -L "$SHIM_SOCKET8" kill-server 2>/dev/null || true

# ==========================================================================

# STA-2663: claude.extra_args arrive inside the rendered launch flags, quoted
# by resolve-agent-config.sh, and each reaches claude as one argument after
# --effort and before --name. The shim brackets every argument so a value with
# spaces or JSON braces shows whether it was split.
section "rendered extra args reach claude as separate arguments"
ISSUE_KEY9="${TEST_PREFIX}-900"
WORKTREE_PATH9="$TMPDIR_ROOT/worktree9"
ARGV_LOG9="$TMPDIR_ROOT/claude-argv-9.log"
mkdir -p "$WORKTREE_PATH9"
cat > "$SHIM_DIR/claude" <<SHIM
#!/bin/bash
printf '[%s]' "\$@" >> "$ARGV_LOG9"
printf '\n' >> "$ARGV_LOG9"
exit 0
SHIM
chmod +x "$SHIM_DIR/claude"

SHIM_SOCKET9="pappardelle_inner_shim9_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET9" \
    start_session \
    --issue-key "$ISSUE_KEY9" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH9" \
    --agent-launch-flags "--effort high --strict-mcp-config --tools 'Bash,Read' '{\"mcpServers\": {}}'" 2>/dev/null

wait_until test -s "$ARGV_LOG9" || true
ARGV9=$(head -1 "$ARGV_LOG9" 2>/dev/null || echo "")
assert_eq "extra args keep their boundaries and order" \
    "[--effort][high][--strict-mcp-config][--tools][Bash,Read][--mcpServers-placeholder]" \
    "$(echo "$ARGV9" | sed 's/\[{"mcpServers": {}}\]/[--mcpServers-placeholder]/; s/\[--name\].*//')"

tmux -L "$SHIM_SOCKET9" kill-server 2>/dev/null || true

# ==========================================================================

section "initialization prompt reaches a continued conversation"
ISSUE_KEY10="${TEST_PREFIX}-1000"
WORKTREE_PATH10="$TMPDIR_ROOT/worktree10"
ARGV_LOG10="$TMPDIR_ROOT/claude-argv-10.log"
mkdir -p "$WORKTREE_PATH10"
cat > "$SHIM_DIR/claude" <<SHIM
#!/bin/bash
printf '[%s]' "\$@" >> "$ARGV_LOG10"
printf '\n' >> "$ARGV_LOG10"
exit 0
SHIM
chmod +x "$SHIM_DIR/claude"

SHIM_SOCKET10="pappardelle_inner_shim10_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET10" \
    start_session \
    --issue-key "$ISSUE_KEY10" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH10" \
    --init-cmd '/test-skill --mode "strict"' --companion-command "" 2>/dev/null

wait_until test -s "$ARGV_LOG10" || true
ARGV10=$(cat "$ARGV_LOG10" 2>/dev/null || echo "")
assert_eq "continued conversation receives initialization as one argument without a fresh fallback" \
    "[--name][$ISSUE_KEY10][--continue][/test-skill --mode \"strict\" $ISSUE_KEY10]" "$ARGV10"

tmux -L "$SHIM_SOCKET10" kill-server 2>/dev/null || true

# ==========================================================================

# pappardelle-2i0: launches must not be typed at a prompt, or the user's shell
# records them in its history file. An isolated zsh (ZDOTDIR) with its own
# HISTFILE and INC_APPEND_HISTORY writes every line it reads from the prompt
# straight to disk, so a typed launch would show up there immediately.
section "launches leave no trace in shell history"
if ! ZSH_BIN=$(command -v zsh); then
    skip "launches leave no trace in shell history (zsh not installed)"
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
            start_session \
            --issue-key "$key" --repo-name "$TEST_REPO" --worktree "$TMPDIR_ROOT/wt-$key" \
            --companion-command "$companion" 2>/dev/null
        sleep 2
    }

    HIST_SOCKET="pappardelle_inner_hist_$$"
    KEY9="${TEST_PREFIX}-900"
    start_hist_session "$HIST_SOCKET" "$KEY9" "GIT_OPTIONAL_LOCKS=0 gitui"

    assert_eq "history file has no launch entries" "" "$(grep -E 'claude|gitui' "$HIST_FILE" 2>/dev/null || true)"

    SHELL_RESULT="$TMPDIR_ROOT/shell-result"
    tmux -L "$HIST_SOCKET" send-keys -t "agent-${TEST_REPO}-${KEY9}" -l \
        "printf '%s' \"\${ZSH_VERSION:+zsh}\" > $(printf '%q' "$SHELL_RESULT")"
    tmux -L "$HIST_SOCKET" send-keys -t "agent-${TEST_REPO}-${KEY9}" Enter
    wait_until test -s "$SHELL_RESULT" || true
    assert_eq "agent session leaves a responsive login shell after claude exits" "zsh" \
        "$(cat "$SHELL_RESULT" 2>/dev/null)"
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
section "pre-trust writes ~/.claude.json for claude agents only"
if [[ -f "$SHIM_HOME/.claude.json" ]]; then
    pass "claude launch pre-trusted the worktree"
else
    fail "claude launch pre-trusted the worktree"
fi

# ==========================================================================

# A non-claude agent runs `{command} {args}` verbatim — no --name, no
# dsp, no pre-trust. With resume args the resume attempt runs
# first (shim exits 0, so the fallback never fires).
section "codex agent gets its own command line, no claude flags"
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
    start_session \
    --issue-key "$ISSUE_KEY9" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH9" \
    --skip-permissions \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "resume --last" --agent-is-claude false \
    2>/dev/null

wait_until test -s "$ARGV_LOG9" || true
ARGV9=$(head -1 "$ARGV_LOG9" 2>/dev/null || echo "")
assert_eq "codex argv is args + resume args only" "--yolo resume --last" "$ARGV9"

if [[ -f "$CODEX_HOME/.claude.json" ]]; then
    fail "codex launch must not pre-trust ~/.claude.json"
else
    pass "codex launch skipped the ~/.claude.json pre-trust"
fi

tmux -L "$SHIM_SOCKET9" kill-server 2>/dev/null || true

# ==========================================================================

# With empty resume args a non-claude agent launches directly with the
# prompt argument (init cmd + issue key) — no resume-fallback chain. The
# resolver sends "" for agents without resume_args; when the flag is omitted
# entirely the leaf script defaults to --continue for claude agents only.
section "codex agent without resume args launches directly with prompt"
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
    start_session \
    --issue-key "$ISSUE_KEY10" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH10" \
    --init-cmd "/idow" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "" --agent-is-claude false \
    2>/dev/null

wait_until test -s "$ARGV_LOG10" || true
ARGV10=$(head -1 "$ARGV_LOG10" 2>/dev/null || echo "")
assert_eq "codex launch-only argv is args + prompt" "--yolo /idow $ISSUE_KEY10" "$ARGV10"

tmux -L "$SHIM_SOCKET10" kill-server 2>/dev/null || true

# ==========================================================================

# The agent profile's model/effort flags arrive rendered and quoted by
# resolve-agent-config.sh. They must reach the agent as separate literal
# arguments, ahead of codex's `resume` subcommand.
section "--agent-launch-flags reach the agent before its resume args"
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
    start_session \
    --issue-key "$ISSUE_KEY_LF" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH_LF" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "resume abc" --agent-is-claude false \
    --agent-launch-flags "-m 'gpt-5.5 [1m]' -c model_reasoning_effort=high" \
    2>/dev/null

wait_until test -s "$ARGV_LOG_LF" || true
assert_eq "launch flags sit between args and resume args" \
    "<--yolo><-m><gpt-5.5 [1m]><-c><model_reasoning_effort=high><resume><abc>" \
    "$(head -1 "$ARGV_LOG_LF" 2>/dev/null || echo "")"

tmux -L "$SHIM_SOCKET_LF" kill-server 2>/dev/null || true

# ==========================================================================

# --agent-is-claude true forces claude treatment for a wrapper whose
# basename isn't "claude" (e.g. a claude-local alias).
section "--agent-is-claude true gives a wrapper the claude flags"
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
    start_session \
    --issue-key "$ISSUE_KEY11" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH11" \
    --agent-launch-flags "--model sonnet" \
    --agent-command claude-local --agent-is-claude true --agent-resume-args --continue \
    2>/dev/null

wait_until test -s "$ARGV_LOG11" || true
ARGV11=$(head -1 "$ARGV_LOG11" 2>/dev/null || echo "")
assert_eq "wrapper argv gets model/name/continue" "--model sonnet --name $ISSUE_KEY11 --continue" "$ARGV11"

tmux -L "$SHIM_SOCKET11" kill-server 2>/dev/null || true

# ==========================================================================

# A live legacy claude-<repo>-<key> session is renamed to the
# agent- name instead of a duplicate being created beside it.
section "legacy claude-* session is renamed, not duplicated"
ISSUE_KEY12="${TEST_PREFIX}-1200"
WORKTREE_PATH12="$TMPDIR_ROOT/worktree12"
mkdir -p "$WORKTREE_PATH12"
LEGACY_SESSION="claude-${TEST_REPO}-${ISSUE_KEY12}"
RENAMED_SESSION="agent-${TEST_REPO}-${ISSUE_KEY12}"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$LEGACY_SESSION" -c "$WORKTREE_PATH12"

start_session --issue-key "$ISSUE_KEY12" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH12" --no-agent 2>/dev/null

assert_session "legacy session renamed to agent-*" "$RENAMED_SESSION"
assert_no_session "legacy claude-* name is gone after rename" "$LEGACY_SESSION"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "$RENAMED_SESSION" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "companion-${TEST_REPO}-${ISSUE_KEY12}" 2>/dev/null || true

section "the legacy name renamed is the one passed"
HAND_LEGACY="hand-legacy-${ISSUE_KEY12}"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$HAND_LEGACY" -c "$WORKTREE_PATH12"
start_session --issue-key "$ISSUE_KEY12" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH12" \
    --agent-session "$RENAMED_SESSION" --companion-session "companion-${TEST_REPO}-${ISSUE_KEY12}" \
    --legacy-agent-session "$HAND_LEGACY" --no-agent 2>/dev/null
assert_eq "the passed legacy session is renamed to the agent name" "$RENAMED_SESSION" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep -x -- "$RENAMED_SESSION\|$HAND_LEGACY")"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$RENAMED_SESSION:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${ISSUE_KEY12}:" 2>/dev/null || true

# With both names live, the agent- session is the one pappardelle attaches, so
# the legacy one would run unseen.
section "a legacy session beside its agent- session is killed"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$LEGACY_SESSION" -c "$WORKTREE_PATH12"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$RENAMED_SESSION" -c "$WORKTREE_PATH12"

start_session --issue-key "$ISSUE_KEY12" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH12" --no-agent 2>/dev/null

assert_no_session "legacy session killed" "=$LEGACY_SESSION:"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$RENAMED_SESSION:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${ISSUE_KEY12}:" 2>/dev/null || true

# ==========================================================================

# tmux falls back to prefix matching when no session has the exact name, so a
# bare `-t agent-<repo>-<KEY>1` lookup finds `agent-<repo>-<KEY>12`. Starting a
# space whose sessions don't exist yet must create them, and must leave
# another space's legacy session alone.
section "session checks never match another space's sessions by prefix"
ISSUE_KEY13="${TEST_PREFIX}-130"
OTHER_KEY13="${TEST_PREFIX}-1300"
WORKTREE_PATH13="$TMPDIR_ROOT/worktree13"
mkdir -p "$WORKTREE_PATH13"
OTHER_LEGACY13="claude-${TEST_REPO}-${OTHER_KEY13}"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "$OTHER_LEGACY13" -c "$WORKTREE_PATH13"
tmux -L "$PAPPARDELLE_TMUX_SOCKET" new-session -d -s "companion-${TEST_REPO}-${OTHER_KEY13}" -c "$WORKTREE_PATH13"

start_session --issue-key "$ISSUE_KEY13" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH13" --no-agent 2>/dev/null

assert_session "other space's legacy session kept its name" "=$OTHER_LEGACY13:"
assert_session "a fresh agent session was created for the new space" "=agent-${TEST_REPO}-${ISSUE_KEY13}:"
assert_session "a companion session was created despite another space's companion" \
    "=companion-${TEST_REPO}-${ISSUE_KEY13}:"

tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=$OTHER_LEGACY13:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${OTHER_KEY13}:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=agent-${TEST_REPO}-${ISSUE_KEY13}:" 2>/dev/null || true
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-${TEST_REPO}-${ISSUE_KEY13}:" 2>/dev/null || true

# ==========================================================================

# A named agent profile must come with its resolved claude treatment; the script no
# longer guesses it from the command.
section "--agent-command without --agent-is-claude is an error"
ISSUE_KEY14="${TEST_PREFIX}-1400"
SHIM_SOCKET14="pappardelle_inner_shim14_$$"
if PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET14" start_session \
    --issue-key "$ISSUE_KEY14" --repo-name "$TEST_REPO" --worktree "$TMPDIR_ROOT" \
    --agent-command codex 2>/dev/null; then
    fail "script should exit non-zero"
else
    pass "script exits non-zero"
fi
assert_no_session "no session is created" "=agent-${TEST_REPO}-${ISSUE_KEY14}:" "$SHIM_SOCKET14"
tmux -L "$SHIM_SOCKET14" kill-server 2>/dev/null || true

# ==========================================================================

# macOS /bin/sh and /bin/bash are bash 3.2. If the launch leaves the terminal
# with the launch's process group, the login shell that follows never gets the
# foreground: it spins at 100% CPU without reading input and outlives
# kill-server as an orphan.
section "a bash pane is a working shell after the launch exits"
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
    start_session \
    --issue-key "$ISSUE_KEY15" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH15" \
    --companion-command "/usr/bin/true" \
    --agent-command codex --agent-args "--yolo" --agent-resume-args "" --agent-is-claude false \
    2>/dev/null

wait_until test -s "$ARGV_LOG15" || true
for kind in agent companion; do
    REPLY_FILE="$TMPDIR_ROOT/bash-reply-$kind"
    tmux -L "$SHIM_SOCKET15" send-keys -t "=${kind}-${TEST_REPO}-${ISSUE_KEY15}:" -l "echo ok > $(printf '%q' "$REPLY_FILE")"
    tmux -L "$SHIM_SOCKET15" send-keys -t "=${kind}-${TEST_REPO}-${ISSUE_KEY15}:" Enter
    wait_until test -s "$REPLY_FILE" || true
    assert_eq "$kind pane answers input" "ok" "$(cat "$REPLY_FILE" 2>/dev/null)"
done

tmux -L "$SHIM_SOCKET15" kill-server 2>/dev/null || true

# ==========================================================================
# tmux next-3.9 starts every session in the server's own working directory
# once that directory is deleted, whatever -c says.
section "the inner server outlives the worktree it was started from"
WORKTREE_PATH16="$TMPDIR_ROOT/worktree16"
WORKTREE_PATH17="$TMPDIR_ROOT/worktree17"
mkdir -p "$WORKTREE_PATH16" "$WORKTREE_PATH17"
SHIM_SOCKET16="pappardelle_inner_shim16_$$"
start_space() {
    (cd "$2" && PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET16" \
        start_session \
        --issue-key "$1" --repo-name "$TEST_REPO" --worktree "$2" \
        --no-agent 2>/dev/null)
}
start_space "${TEST_PREFIX}-1600" "$WORKTREE_PATH16"
rm -rf "$WORKTREE_PATH16"
start_space "${TEST_PREFIX}-1700" "$WORKTREE_PATH17"
CWD_FILE="$TMPDIR_ROOT/cwd17"
tmux -L "$SHIM_SOCKET16" send-keys -t "=agent-${TEST_REPO}-${TEST_PREFIX}-1700:" -l "pwd -P > $(printf '%q' "$CWD_FILE")"
tmux -L "$SHIM_SOCKET16" send-keys -t "=agent-${TEST_REPO}-${TEST_PREFIX}-1700:" Enter
wait_until test -s "$CWD_FILE" || true
assert_eq "a later space starts in its own worktree" "$(cd "$WORKTREE_PATH17" && pwd -P)" "$(cat "$CWD_FILE" 2>/dev/null)"
tmux -L "$SHIM_SOCKET16" kill-server 2>/dev/null || true

# ==========================================================================

# Each run of a shim agent logs its argv as one line; a run whose args hold
# RESUME_FAIL exits 1, so the chain falls through to the fresh launch.
make_argv_shim() {
    local name="$1" log="$2"
    cat > "$SHIM_DIR/$name" <<SHIM
#!/bin/bash
[[ \$# -gt 0 ]] && printf '<%s>' "\$@" >> "$log"
printf '\n' >> "$log"
[[ "\$*" == *RESUME_FAIL* ]] && exit 1
exit 0
SHIM
    chmod +x "$SHIM_DIR/$name"
}

# has_lines <file> <count>: the file has at least count lines.
# shellcheck disable=SC2329  # invoked through wait_until
has_lines() {
    [[ -f "$1" && $(wc -l < "$1") -ge "$2" ]]
}

# agy refuses a bare prompt; --agent-prompt-args puts it behind -i on both
# sides of the chain, after the resume args, as one word whatever it holds.
section "--agent-prompt-args wraps the prompt on both sides of the chain"
ISSUE_KEY_PA="${TEST_PREFIX}-1800"
WORKTREE_PATH_PA="$TMPDIR_ROOT/worktree-prompt-args"
ARGV_LOG_PA="$TMPDIR_ROOT/agy-argv-prompt-args.log"
mkdir -p "$WORKTREE_PATH_PA"
make_argv_shim agy "$ARGV_LOG_PA"
SHIM_SOCKET_PA="pappardelle_inner_shim_pa_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET_PA" \
    start_session \
    --issue-key "$ISSUE_KEY_PA" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH_PA" \
    --init-cmd "/it's & \$HOME" \
    --agent-command agy --agent-is-claude false --agent-launch-flags "--model m1" \
    --agent-resume-args "--conversation RESUME_FAIL" --agent-prompt-args "-i {prompt}" \
    2>/dev/null
wait_until has_lines "$ARGV_LOG_PA" 2 || true
assert_eq "resume attempt: resume args, then -i and the prompt" \
    "<--model><m1><--conversation><RESUME_FAIL><-i></it's & \$HOME $ISSUE_KEY_PA>" \
    "$(sed -n 1p "$ARGV_LOG_PA" 2>/dev/null)"
assert_eq "fresh launch: -i and the prompt" \
    "<--model><m1><-i></it's & \$HOME $ISSUE_KEY_PA>" \
    "$(sed -n 2p "$ARGV_LOG_PA" 2>/dev/null)"
tmux -L "$SHIM_SOCKET_PA" kill-server 2>/dev/null || true

section "--agent-prompt-args with no init command wraps the issue key"
ISSUE_KEY_PK="${TEST_PREFIX}-1810"
WORKTREE_PATH_PK="$TMPDIR_ROOT/worktree-prompt-key"
ARGV_LOG_PK="$TMPDIR_ROOT/agy-argv-prompt-key.log"
mkdir -p "$WORKTREE_PATH_PK"
make_argv_shim agy "$ARGV_LOG_PK"
SHIM_SOCKET_PK="pappardelle_inner_shim_pk_$$"
PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_TMUX_SOCKET="$SHIM_SOCKET_PK" \
    start_session \
    --issue-key "$ISSUE_KEY_PK" --repo-name "$TEST_REPO" --worktree "$WORKTREE_PATH_PK" \
    --agent-command agy --agent-is-claude false --agent-prompt-args "-i {prompt}" \
    2>/dev/null
wait_until has_lines "$ARGV_LOG_PK" 1 || true
assert_eq "the key goes behind -i" "<-i><$ISSUE_KEY_PK>" "$(sed -n 1p "$ARGV_LOG_PK" 2>/dev/null)"
tmux -L "$SHIM_SOCKET_PK" kill-server 2>/dev/null || true

# idow's resume mode: when the resume fails, the agent starts idle rather than
# being handed the issue key, for every kind of agent.
NP_INDEX=0
for np_case in "claude|true|--resume RESUME_FAIL|" "codex|false|resume RESUME_FAIL|" "agy|false|--conversation RESUME_FAIL|-i {prompt}"; do
    IFS='|' read -r np_agent np_is_claude np_resume np_prompt_args <<< "$np_case"
    NP_INDEX=$((NP_INDEX + 1))
    section "--no-prompt launches $np_agent without a prompt after a failed resume"
    np_key="${TEST_PREFIX}-19${NP_INDEX}0"
    np_worktree="$TMPDIR_ROOT/worktree-no-prompt-$np_agent"
    np_log="$TMPDIR_ROOT/$np_agent-argv-no-prompt.log"
    np_socket="pappardelle_inner_shim_np${NP_INDEX}_$$"
    mkdir -p "$np_worktree"
    make_argv_shim "$np_agent" "$np_log"
    np_args=(--issue-key "$np_key" --repo-name "$TEST_REPO" --worktree "$np_worktree" --no-prompt
        --agent-command "$np_agent" --agent-is-claude "$np_is_claude" --agent-resume-args "$np_resume")
    [[ -n "$np_prompt_args" ]] && np_args+=(--agent-prompt-args "$np_prompt_args")
    PATH="$SHIM_DIR:$PATH" HOME="$SHIM_HOME" PAPPARDELLE_CLAUDE_CONFIG_PATH="$TMPDIR_ROOT/claude-np.json" \
        PAPPARDELLE_TMUX_SOCKET="$np_socket" start_session "${np_args[@]}" 2>/dev/null
    wait_until has_lines "$np_log" 2 || true
    np_name=""
    [[ "$np_is_claude" == true ]] && np_name="<--name><$np_key>"
    np_resume_words=""
    for word in $np_resume; do np_resume_words+="<$word>"; done
    assert_eq "$np_agent resume attempt has no prompt" "$np_name$np_resume_words" "$(sed -n 1p "$np_log" 2>/dev/null)"
    assert_eq "$np_agent fresh launch has no prompt" "$np_name" "$(sed -n 2p "$np_log" 2>/dev/null)"
    tmux -L "$np_socket" kill-server 2>/dev/null || true
done

# ==========================================================================

section "sessions survive a tmux.conf that drops unattached sessions"
KEEP_KEY="${TEST_PREFIX}-keep"
KEEP_HOME="$TMPDIR_ROOT/keep-home"
KEEP_SOCKET="pappardelle_inner_keep_$$"
mkdir -p "$KEEP_HOME" "$TMPDIR_ROOT/keep-worktree"
touch "$KEEP_HOME/.zshrc"
printf 'set -g destroy-unattached on\nset -g exit-unattached on\n' > "$KEEP_HOME/.tmux.conf"
env -u XDG_CONFIG_HOME HOME="$KEEP_HOME" PAPPARDELLE_TMUX_SOCKET="$KEEP_SOCKET" \
    "$SCRIPT_DIR/start-agent-session.sh" --issue-key "$KEEP_KEY" --repo-name "$TEST_REPO" \
    --agent-session "agent-$TEST_REPO-$KEEP_KEY" --companion-session "companion-$TEST_REPO-$KEEP_KEY" \
    --legacy-agent-session "claude-$TEST_REPO-$KEEP_KEY" \
    --worktree "$TMPDIR_ROOT/keep-worktree" --no-agent --companion-command '' 2>/dev/null || true
assert_eq "agent and companion sessions outlive the script" \
    "$(printf 'agent-%s-%s\ncompanion-%s-%s' "$TEST_REPO" "$KEEP_KEY" "$TEST_REPO" "$KEEP_KEY")" \
    "$(tmux -L "$KEEP_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | sort)"
tmux -L "$KEEP_SOCKET" kill-server 2>/dev/null || true

# ==========================================================================

section "the inner server outlives its last space, so the next one starts"
EMPTY_KEY="${TEST_PREFIX}-empty"
EMPTY_SOCKET="pappardelle_inner_empty_$$"
mkdir -p "$TMPDIR_ROOT/empty-worktree"
start_empty_space() {
    PAPPARDELLE_TMUX_SOCKET="$EMPTY_SOCKET" start_session --issue-key "$EMPTY_KEY" \
        --repo-name "$TEST_REPO" --worktree "$TMPDIR_ROOT/empty-worktree" \
        --no-agent --companion-command '' 2>/dev/null
}
start_empty_space
tmux -L "$EMPTY_SOCKET" kill-session -t "=agent-$TEST_REPO-$EMPTY_KEY:"
tmux -L "$EMPTY_SOCKET" kill-session -t "=companion-$TEST_REPO-$EMPTY_KEY:"
assert_eq "the server answers with no sessions left" "0" \
    "$(tmux -L "$EMPTY_SOCKET" list-sessions >/dev/null 2>&1; echo $?)"
assert_eq "a space started right after starts" "0" "$(start_empty_space; echo $?)"
tmux -L "$EMPTY_SOCKET" kill-server 2>/dev/null || true

# ==========================================================================

section "a worktree path that reads as a tmux format is where the space starts"
HASH_KEY="${TEST_PREFIX}-hash"
HASH_WORKTREE="$TMPDIR_ROOT/pasta#S"
mkdir -p "$HASH_WORKTREE"
start_session --issue-key "$HASH_KEY" --repo-name "$TEST_REPO" --worktree "$HASH_WORKTREE" \
    --no-agent --companion-command '' 2>/dev/null || true
assert_eq "agent session starts in the worktree" "$HASH_WORKTREE" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "=agent-$TEST_REPO-$HASH_KEY:" '#{session_path}' 2>/dev/null)"
assert_eq "companion session starts in the worktree" "$HASH_WORKTREE" \
    "$(tmux -L "$PAPPARDELLE_TMUX_SOCKET" display-message -p -t "=companion-$TEST_REPO-$HASH_KEY:" '#{session_path}' 2>/dev/null)"

# ==========================================================================

section "agy launch pre-trusts worktree in settings.json without clobbering corrupt JSON"
AGY_TRUST_DIR="$TMPDIR_ROOT/agy-trust"
AGY_SETTINGS="$AGY_TRUST_DIR/nested/settings.json"
AGY_WT1="$TMPDIR_ROOT/agy-wt1"
AGY_WT2="$TMPDIR_ROOT/agy-wt2"
AGY_WT3="$TMPDIR_ROOT/agy-wt3"
mkdir -p "$AGY_WT1" "$AGY_WT2" "$AGY_WT3"

read_agy_settings() {
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
trusted = ",".join(d.get("trustedWorkspaces", []))
print(d.get("editorMode", "") + "|" + trusted if sys.argv[2] == "with-mode" else trusted)
' "$1" "${2:-trusted}" 2>/dev/null
}

# Bare agy command creates parent directory and writes trustedWorkspaces.
PAPPARDELLE_AGY_SETTINGS_PATH="$AGY_SETTINGS" \
    start_session --issue-key "${TEST_PREFIX}-agy1" --repo-name "$TEST_REPO" --worktree "$AGY_WT1" \
    --agent-command agy --agent-is-claude false --no-agent --companion-command '' 2>/dev/null
assert_eq "agy pre-trust writes trustedWorkspaces entry" "$AGY_WT1" \
    "$(read_agy_settings "$AGY_SETTINGS")"

# Wrapped `env FOO=1 agy` appends without duplicating or dropping other keys.
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["editorMode"]="vim"; json.dump(d, open(p,"w"))' "$AGY_SETTINGS"
PAPPARDELLE_AGY_SETTINGS_PATH="$AGY_SETTINGS" \
    start_session --issue-key "${TEST_PREFIX}-agy2" --repo-name "$TEST_REPO" --worktree "$AGY_WT2" \
    --agent-command "env FOO=1 agy" --agent-is-claude false --no-agent --companion-command '' 2>/dev/null
assert_eq "wrapped agy preserves existing keys and appends worktree" "vim|$AGY_WT1,$AGY_WT2" \
    "$(read_agy_settings "$AGY_SETTINGS" with-mode)"

# Non-agy (codex) does not add to agy settings.
PAPPARDELLE_AGY_SETTINGS_PATH="$AGY_SETTINGS" \
    start_session --issue-key "${TEST_PREFIX}-agy3" --repo-name "$TEST_REPO" --worktree "$AGY_WT3" \
    --agent-command codex --agent-is-claude false --no-agent --companion-command '' 2>/dev/null
assert_eq "codex launch does not add to agy trustedWorkspaces" "$AGY_WT1,$AGY_WT2" \
    "$(read_agy_settings "$AGY_SETTINGS")"

# Corrupt existing settings.json is left untouched (never clobbered).
AGY_CORRUPT="$TMPDIR_ROOT/agy-corrupt.json"
printf 'not valid json{{{' > "$AGY_CORRUPT"
PAPPARDELLE_AGY_SETTINGS_PATH="$AGY_CORRUPT" \
    start_session --issue-key "${TEST_PREFIX}-agy4" --repo-name "$TEST_REPO" --worktree "$AGY_WT3" \
    --agent-command agy --agent-is-claude false --no-agent --companion-command '' 2>/dev/null
assert_eq "corrupt agy settings.json is preserved" "not valid json{{{" "$(cat "$AGY_CORRUPT")"

for k in agy1 agy2 agy3 agy4; do
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=agent-$TEST_REPO-${TEST_PREFIX}-${k}:" 2>/dev/null || true
    tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-session -t "=companion-$TEST_REPO-${TEST_PREFIX}-${k}:" 2>/dev/null || true
done

# ==========================================================================

# The inner server never exits on its own, and a server left running fails
# the guard's leak check.
tmux -L "$PAPPARDELLE_TMUX_SOCKET" kill-server 2>/dev/null || true

summarize

