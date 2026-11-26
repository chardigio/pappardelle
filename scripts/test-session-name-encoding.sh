#!/bin/bash

# Test: open-iterm-agent.sh attaches to the companion session it is given
#
# The session names are stored when the space is created and handed to the
# launchers by idow. open-iterm-agent.sh used to rebuild the companion name
# from the agent's, which diverged from the stored name for any space whose
# names do not follow agent-<repo>-<key> — silently, because `new-session -A
# -s` just creates whatever name it is handed, orphaning the companion session
# that already existed. The encoding of a key into a name is covered by
# getSessionNames in source/tmux-sessions.test.ts.
#
# The command lines are assembled inside open-iterm-agent.sh's AppleScript, so
# this runs the launcher with --print-command, and an osascript shim strips the
# script's `tell application "iTerm"` block before the real osascript runs it
# with the launcher's own arguments. AppleScript resolves an application's
# dictionary at compile time, so on a machine without iTerm2 installed the whole
# script fails to compile, and even --print-command cannot run although it
# returns well before iTerm. Everything this test cares about lives above that
# block. test-workspace-launchers.sh checks the companion name too, but needs
# iTerm installed.
#
# Usage: ./test-session-name-encoding.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"

# osascript is macOS-only; the whole test is an AppleScript harness, so there is
# nothing left to exercise elsewhere.
if ! command -v osascript >/dev/null 2>&1; then
    skip "test-session-name-encoding (no osascript — macOS only)"
    summarize
fi

test_tmpdir TMPDIR_ROOT

REAL_OSASCRIPT=$(command -v osascript)
STRIPPED="$TMPDIR_ROOT/stripped.applescript"
mkdir -p "$TMPDIR_ROOT/bin"
cat > "$TMPDIR_ROOT/bin/osascript" <<SHIM
#!/bin/bash
if ! grep -q '^    tell application "iTerm"\$' "\$1"; then
    echo "osascript shim: no tell application \"iTerm\" block in the launcher's AppleScript" >&2
    exit 1
fi
awk '/^    tell application "iTerm"\$/{skip=1} skip && /^end run\$/{skip=0} !skip' "\$1" > "$STRIPPED"
if ! grep -q '^end run\$' "$STRIPPED"; then
    echo "osascript shim: no end run after the tell application \"iTerm\" block" >&2
    exit 1
fi
shift
exec "$REAL_OSASCRIPT" "$STRIPPED" "\$@"
SHIM
chmod +x "$TMPDIR_ROOT/bin/osascript"

# Pull the session name out of a `tmux ... -s 'NAME'` or `-t 'NAME'` command line.
session_from() {
    sed -E "s/.*$1 '([^']*)'.*/\1/" <<< "$2"
}

assert_sessions() {
    local test_name="$1" expected_agent="$2" expected_companion="$3"

    local out agent_line companion_line actual_agent actual_companion
    out=$(PATH="$TMPDIR_ROOT/bin:$PATH" PAPPARDELLE_TMUX_SOCKET=sock "$SCRIPT_DIR/open-iterm-agent.sh" \
        --worktree /tmp/wt --issue-key QA-1 --repo-name testrepo \
        --agent-session "$expected_agent" --companion-session "$expected_companion" --prompt '' --print-command)
    agent_line=$(sed -n '1p' <<< "$out")
    companion_line=$(sed -n '2p' <<< "$out")
    actual_agent=$(session_from '-s' "$agent_line")
    actual_companion=$(session_from '-s' "$companion_line")

    if [[ "$actual_agent" == "$expected_agent" && "$actual_companion" == "$expected_companion" ]]; then
        pass "$test_name"
    else
        fail "$test_name" \
            "agent     expected: \"$expected_agent\"  actual: \"$actual_agent\"" \
            "companion expected: \"$expected_companion\"  actual: \"$actual_companion\""
    fi
}

echo -e "\n${BOLD}Test: the launcher attaches to the session names it is given${RESET}"

assert_sessions "names idow gives a beads child issue" "agent-testrepo-bd-a3f8e9_1" "companion-testrepo-bd-a3f8e9_1"
assert_sessions "a companion name that is not the agent's with another prefix" "agent-testrepo-STA-1" "hand-named_companion"
assert_sessions "names in no Pappardelle spelling" "hand.named_agent" "other-companion"

summarize
