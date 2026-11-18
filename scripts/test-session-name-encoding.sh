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
# this runs that AppleScript directly. Its `tell application "iTerm"` block is
# stripped first: AppleScript resolves an application's dictionary at compile
# time, so on a machine without iTerm2 installed the whole script fails to
# compile and even --print-command (which returns well before iTerm) cannot run.
# Everything this test cares about lives above that block.
#
# Usage: ./test-session-name-encoding.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

# osascript is macOS-only; the whole test is an AppleScript harness, so there is
# nothing left to exercise elsewhere.
if ! command -v osascript >/dev/null 2>&1; then
    echo "SKIP: test-session-name-encoding (no osascript — macOS only)"
    exit 0
fi

TMPDIR_ROOT=$(mktemp -d)
# shellcheck disable=SC2329  # invoked via trap
cleanup() {
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT

HARNESS="$TMPDIR_ROOT/assemble.applescript"
awk '/^cat > "\$APPLESCRIPT" << .APPLESCRIPT_END.$/{f=1;next} /^APPLESCRIPT_END$/{f=0} f' \
    "$SCRIPT_DIR/open-iterm-agent.sh" \
    | awk '/^    tell application "iTerm"$/{skip=1} skip && /^end run$/{skip=0} !skip' \
    > "$HARNESS"

if ! grep -q '^end run$' "$HARNESS"; then
    echo -e "${RED}Could not extract the AppleScript from open-iterm-agent.sh${RESET}" >&2
    exit 1
fi

# Pull the session name out of a `tmux ... -s 'NAME'` or `-t 'NAME'` command line.
session_from() {
    sed -E "s/.*$1 '([^']*)'.*/\1/" <<< "$2"
}

assert_sessions() {
    local test_name="$1" expected_agent="$2" expected_companion="$3"

    local out agent_line companion_line actual_agent actual_companion
    out=$(osascript "$HARNESS" \
        QA-1 /tmp/wt "$expected_agent" '' testrepo '' sock 'gitui' true /bin/zsh claude '' ' --continue' claude /tmp/state.json true '' "$expected_companion")
    agent_line=$(sed -n '1p' <<< "$out")
    companion_line=$(sed -n '2p' <<< "$out")
    actual_agent=$(session_from '-s' "$agent_line")
    actual_companion=$(session_from '-s' "$companion_line")

    if [[ "$actual_agent" == "$expected_agent" && "$actual_companion" == "$expected_companion" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    agent     expected: \"$expected_agent\"  actual: \"$actual_agent\""
        echo "    companion expected: \"$expected_companion\"  actual: \"$actual_companion\""
        FAIL=$((FAIL + 1))
    fi
}

echo -e "\n${BOLD}Test: the launcher attaches to the session names it is given${RESET}"

assert_sessions "names idow gives a beads child issue" "agent-testrepo-bd-a3f8e9_1" "companion-testrepo-bd-a3f8e9_1"
assert_sessions "a companion name that is not the agent's with another prefix" "agent-testrepo-STA-1" "hand-named_companion"
assert_sessions "names in no Pappardelle spelling" "hand.named_agent" "other-companion"

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
