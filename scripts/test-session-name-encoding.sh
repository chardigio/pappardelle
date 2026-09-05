#!/bin/bash

# Test: the claude and companion tmux session names carry the same encoded key
#
# start-claude-session.sh creates both sessions from an encoded key ('_' -> '__',
# then '.' -> '_') so beads IDs survive tmux's target grammar. open-iterm-claude.sh
# has to attach to those exact names. It used to rebuild the companion name from
# the raw issue key, which diverged for every key carrying a '_' or a '.' —
# silently, because `new-session -d -s` just creates whatever name it is handed,
# orphaning the companion session that already existed.
#
# Contrary to a natural assumption, tmux does not normalize '.' in a session
# name: `new-session -s 'bd-a3f8e9.1'` reports back 'bd-a3f8e9.1' (verified on
# tmux 3.7b), so beads child issues diverged too.
#
# The command lines are assembled inside open-iterm-claude.sh's AppleScript, so
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
    "$SCRIPT_DIR/open-iterm-claude.sh" \
    | awk '/^    tell application "iTerm"$/{skip=1} skip && /^end run$/{skip=0} !skip' \
    > "$HARNESS"

if ! grep -q '^end run$' "$HARNESS"; then
    echo -e "${RED}Could not extract the AppleScript from open-iterm-claude.sh${RESET}" >&2
    exit 1
fi

# The encoding under test, mirroring start-claude-session.sh.
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

    local session_key expected_claude expected_companion
    session_key=$(encode_key "$issue_key")
    expected_claude="claude-${repo_name}-${session_key}"
    expected_companion="companion-${repo_name}-${session_key}"

    local out claude_line companion_line actual_claude actual_companion
    out=$(osascript "$HARNESS" \
        "$issue_key" /tmp/wt "$expected_claude" '' "$repo_name" '' sock 'gitui' true)
    claude_line=$(sed -n '1p' <<< "$out")
    companion_line=$(sed -n '2p' <<< "$out")
    actual_claude=$(session_from '-s' "$claude_line")
    actual_companion=$(session_from '-s' "$companion_line")

    if [[ "$actual_claude" == "$expected_claude" && "$actual_companion" == "$expected_companion" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    claude    expected: \"$expected_claude\"  actual: \"$actual_claude\""
        echo "    companion expected: \"$expected_companion\"  actual: \"$actual_companion\""
        FAIL=$((FAIL + 1))
    fi
}

# The companion pane sends its command to one session and attaches to another;
# a name that only half-matches would still orphan the real session.
assert_companion_self_consistent() {
    local test_name="$1"
    local issue_key="$2"

    local session_key out companion_line created sent attached
    session_key=$(encode_key "$issue_key")
    out=$(osascript "$HARNESS" \
        "$issue_key" /tmp/wt "claude-testrepo-${session_key}" '' testrepo '' sock 'gitui' true)
    companion_line=$(sed -n '2p' <<< "$out")
    created=$(session_from '-s' "$companion_line")
    sent=$(sed -E "s/.*send-keys -t '([^']*)'.*/\1/" <<< "$companion_line")
    attached=$(sed -E "s/.*attach -t '([^']*)'.*/\1/" <<< "$companion_line")

    if [[ "$created" == "$sent" && "$sent" == "$attached" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    created: \"$created\"  sent: \"$sent\"  attached: \"$attached\""
        FAIL=$((FAIL + 1))
    fi
}

echo -e "\n${BOLD}Test: claude and companion sessions share the encoded key${RESET}"

assert_sessions "beads prefix carrying an underscore" "my_svc-a1b2"
assert_sessions "beads child issue" "bd-a3f8e9.1"
assert_sessions "beads child issue, three segments" "a_b-c.1.2"
assert_sessions "beads prefix carrying hyphens" "seatgeek-ticket-management-cli-bqm"
assert_sessions "Linear key is unchanged by the encoding" "STA-123"
assert_sessions "Jira key carrying digits" "A1B-234"

echo -e "\n${BOLD}Test: the companion line targets one session throughout${RESET}"

assert_companion_self_consistent "underscore key" "my_svc-a1b2"
assert_companion_self_consistent "child issue" "bd-a3f8e9.1"

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
