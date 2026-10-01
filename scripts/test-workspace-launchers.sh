#!/bin/bash

# Test: the three workspace launchers emit identical command lines
#
# open-iterm-claude.sh, open-ghostty-claude.sh and open-default-terminal-claude.sh
# each assemble the same Claude and companion pane command lines. The two
# AppleScript launchers build theirs inside osascript, out of reach of a shared
# bash helper, and the default-terminal launcher has no AppleScript at all, so
# the assembly exists three times. For identical inputs all three must emit
# identical bytes.
#
# The AppleScript pair assemble inside osascript, so --print-command runs the
# real thing rather than a bash-side reimplementation. osascript is macOS-only,
# so this suite is not in CI; test-terminal-launcher.sh covers the portable half.
#
# Usage: ./test-workspace-launchers.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

assert_eq() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"

    if [[ "$actual" == "$expected" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected: \"$expected\""
        echo "    Actual:   \"$actual\""
        FAIL=$((FAIL + 1))
    fi
}

if ! command -v osascript >/dev/null 2>&1; then
    echo "SKIP (no osascript — macOS only)"
    exit 0
fi

# Reassigned by the session-name tests below; every helper reads it live.
KEY="QA-1"
base_args() { printf '%s\n' --worktree /tmp/wt --issue-key "$KEY" --repo-name testrepo; }

iterm() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-iterm-claude.sh" "${a[@]}" "$@" 2>/dev/null; }
ghostty() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-ghostty-claude.sh" "${a[@]}" "$@" 2>/dev/null; }
default_term() { local a; IFS=$'\n' read -r -d '' -a a < <(base_args; printf '\0'); "$SCRIPT_DIR/open-default-terminal-claude.sh" "${a[@]}" "$@" 2>/dev/null; }

# Every flag permutation test-claude-model-effort.sh pins for the iTerm script,
# so drift in any one of them is caught here too.
FLAG_CASES=(
    ""
    "--skip-permissions"
    "--model opus"
    "--effort max"
    "--model sonnet --effort high"
    "--skip-permissions --model opus --effort high"
    "--model bedrock/anthropic.claude-v2"
    "--model claude-opus-5[1m]"
)

echo -e "${BOLD}Test: launch flags are byte-identical${RESET}"
for flags in "${FLAG_CASES[@]}"; do
    read -r -a flag_args <<< "$flags"
    assert_eq "flags [${flags:-none}]" \
        "$(iterm --prompt "" "${flag_args[@]}" --print-launch-flags)" \
        "$(ghostty --prompt "" "${flag_args[@]}" --print-launch-flags)"
    assert_eq "flags [${flags:-none}] (default)" \
        "$(iterm --prompt "" "${flag_args[@]}" --print-launch-flags)" \
        "$(default_term --prompt "" "${flag_args[@]}" --print-launch-flags)"
done

echo -e "\n${BOLD}Test: assembled command lines are byte-identical${RESET}"
for flags in "${FLAG_CASES[@]}"; do
    read -r -a flag_args <<< "$flags"
    assert_eq "command [${flags:-none}]" \
        "$(iterm --prompt "/idow QA-1" "${flag_args[@]}" --print-command)" \
        "$(ghostty --prompt "/idow QA-1" "${flag_args[@]}" --print-command)"
    assert_eq "command [${flags:-none}] (default)" \
        "$(iterm --prompt "/idow QA-1" "${flag_args[@]}" --print-command)" \
        "$(default_term --prompt "/idow QA-1" "${flag_args[@]}" --print-command)"
done

# Session names encode '.' as '_' and '_' as '__' (see start-claude-session.sh).
# QA-1 has neither, so a launcher that skipped the encoding would still pass
# every assertion above while attaching `o` to a session nothing else uses.
echo -e "\n${BOLD}Test: session-key encoding is identical across launchers${RESET}"
for key in "bd-a1b2.1" "my_svc-a1b2" "a_b-c.1.2" "STA-123"; do
    KEY="$key"
    assert_eq "key [$key] ghostty" \
        "$(iterm --prompt "" --print-command)" \
        "$(ghostty --prompt "" --print-command)"
    assert_eq "key [$key] default" \
        "$(iterm --prompt "" --print-command)" \
        "$(default_term --prompt "" --print-command)"
done
KEY="QA-1"

# The prompt branch and the companion command are the other two inputs that
# change the assembled bytes.
assert_eq "empty prompt (resume mode)" \
    "$(iterm --prompt "" --print-command)" \
    "$(ghostty --prompt "" --print-command)"
assert_eq "empty prompt (resume mode) (default)" \
    "$(iterm --prompt "" --print-command)" \
    "$(default_term --prompt "" --print-command)"
assert_eq "custom companion command" \
    "$(iterm --prompt "" --companion-command "lazygit" --print-command)" \
    "$(ghostty --prompt "" --companion-command "lazygit" --print-command)"
assert_eq "custom companion command (default)" \
    "$(iterm --prompt "" --companion-command "lazygit" --print-command)" \
    "$(default_term --prompt "" --companion-command "lazygit" --print-command)"
assert_eq "empty companion command (plain shell)" \
    "$(iterm --prompt "" --companion-command "" --print-command)" \
    "$(ghostty --prompt "" --companion-command "" --print-command)"
assert_eq "empty companion command (plain shell) (default)" \
    "$(iterm --prompt "" --companion-command "" --print-command)" \
    "$(default_term --prompt "" --companion-command "" --print-command)"
assert_eq "companion command containing a single quote" \
    "$(iterm --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)" \
    "$(ghostty --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)"
assert_eq "companion command containing a single quote (default)" \
    "$(iterm --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)" \
    "$(default_term --prompt "" --companion-command "DESTDIR='/tmp' make" --print-command)"

# --window-id only steers which Ghostty window receives the tab; it must not
# leak into the shell the panes run.
assert_eq "--window-id does not change the assembled bytes" \
    "$(ghostty --prompt "" --print-command)" \
    "$(ghostty --prompt "" --window-id tab-group-abc123 --print-command)"

echo -e "\n${BOLD}Test: companion pane does not replay into a live session${RESET}"
# idow step 7 usually created the companion session already. new-session -A
# attaches to it instead of starting the companion command a second time, and
# nothing is typed into the pane, so a running gitui is left alone on reopen.
for launcher in iterm ghostty; do
    COMPANION_LINE=$("$launcher" --prompt "" --print-command | tail -1)
    case "$COMPANION_LINE" in
        *"new-session -A -s 'companion-testrepo-QA-1'"*)
            assert_eq "$launcher: companion session is attached when it exists" "ok" "ok" ;;
        *)
            assert_eq "$launcher: companion session is attached when it exists" \
                "new-session -A -s 'companion-testrepo-QA-1'" "$COMPANION_LINE" ;;
    esac
    assert_eq "$launcher: nothing is typed into the companion pane" "0" \
        "$(grep -c 'send-keys' <<< "$COMPANION_LINE" || true)"

    # The generated line crosses into a real shell, so it has to parse there.
    if printf '%s\n' "$COMPANION_LINE" | bash -n /dev/stdin 2>/dev/null; then
        assert_eq "$launcher: companion line is valid shell" "ok" "ok"
    else
        assert_eq "$launcher: companion line is valid shell" "parses" "$COMPANION_LINE"
    fi
done

echo -e "\n${BOLD}Test: idow captures the window after --open is parsed${RESET}"
# idow resolves its config before it parses arguments, so a capture placed with
# the config sees an unset OPEN_WORKSPACE and silently never runs, disabling
# window targeting altogether.
IDOW="$SCRIPT_DIR/idow"
PARSE_LINE=$(grep -n '^OPEN_WORKSPACE=false$' "$IDOW" | head -1 | cut -d: -f1)
CAPTURE_LINE=$(grep -n '^GHOSTTY_WINDOW_ID=""$' "$IDOW" | head -1 | cut -d: -f1)
STEP1_LINE=$(grep -n '^# Step 1: Select profile' "$IDOW" | head -1 | cut -d: -f1)
if [[ -n "$PARSE_LINE" && -n "$CAPTURE_LINE" && -n "$STEP1_LINE" \
      && "$CAPTURE_LINE" -gt "$PARSE_LINE" && "$CAPTURE_LINE" -lt "$STEP1_LINE" ]]; then
    assert_eq "capture sits between --open parsing and the first slow step" "ok" "ok"
else
    assert_eq "capture sits between --open parsing and the first slow step" \
        "parse < capture < step 1" "parse=$PARSE_LINE capture=$CAPTURE_LINE step1=$STEP1_LINE"
fi

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
