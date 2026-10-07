#!/bin/bash

# Test: the agent and companion tmux session names carry the same encoded key
#
# start-agent-session.sh creates both sessions from an encoded key ('_' -> '__',
# then '.' -> '_') so beads IDs survive tmux's target grammar. open-iterm-agent.sh
# has to attach to those exact names. It used to rebuild the companion name from
# the raw issue key, which diverged for every key carrying a '_' or a '.' —
# silently, because `new-session -d -s` just creates whatever name it is handed,
# orphaning the companion session that already existed.
#
# Contrary to a natural assumption, tmux does not normalize '.' in a session
# name: `new-session -s 'bd-a3f8e9.1'` reports back 'bd-a3f8e9.1' (verified on
# tmux 3.7b), so beads child issues diverged too.
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

# The encoding under test, mirroring start-agent-session.sh.
encode_key() {
    local key="${1//_/__}"
    printf '%s' "${key//./_}"
}

# Pull the session name out of a `tmux ... -s 'NAME'` or `-t 'NAME'` command line.
session_from() {
    sed -E "s/.*$1 '([^']*)'.*/\1/" <<< "$2"
}

assert_sessions() {
    local test_name="$1"
    local issue_key="$2"
    local repo_name="testrepo"

    local session_key expected_agent expected_companion
    session_key=$(encode_key "$issue_key")
    expected_agent="agent-${repo_name}-${session_key}"
    expected_companion="companion-${repo_name}-${session_key}"

    local out agent_line companion_line actual_agent actual_companion
    out=$(osascript "$HARNESS" \
        "$issue_key" /tmp/wt "$expected_agent" '' "$repo_name" '' sock 'gitui' true /bin/zsh claude '' ' --continue')
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

echo -e "\n${BOLD}Test: agent and companion sessions share the encoded key${RESET}"

assert_sessions "beads prefix carrying an underscore" "my_svc-a1b2"
assert_sessions "beads child issue" "bd-a3f8e9.1"
assert_sessions "beads child issue, three segments" "a_b-c.1.2"
assert_sessions "beads prefix carrying hyphens" "seatgeek-ticket-management-cli-bqm"
assert_sessions "Linear key is unchanged by the encoding" "STA-123"
assert_sessions "Jira key carrying digits" "A1B-234"

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
