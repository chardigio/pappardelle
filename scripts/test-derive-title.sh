#!/bin/bash

# Test: derive-title.sh, which idow uses to title an issue created from a
# description
#
# Usage: ./test-derive-title.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DERIVE="$SCRIPT_DIR/derive-title.sh"
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

echo -e "${BOLD}derive-title.sh${RESET}"

assert_eq "short prompt is the title as is" \
    "Add dark mode to settings" \
    "$("$DERIVE" "Add dark mode to settings")"

assert_eq "newlines, tabs, CRs and repeated spaces collapse to one line" \
    "Fix the rail sort and keep focus" \
    "$("$DERIVE" $'  Fix the   rail\t\tsort\r\nand keep focus  ')"

assert_eq "a prompt that looks like an echo option is kept" \
    "-n" \
    "$("$DERIVE" "-n")"

EIGHTY=$(printf 'a%.0s' {1..80})
assert_eq "80-char prompt is kept whole" \
    "$EIGHTY" \
    "$("$DERIVE" "$EIGHTY")"

assert_eq "81-char prompt is cut to 77 chars plus an ellipsis" \
    "${EIGHTY:0:77}..." \
    "$("$DERIVE" "${EIGHTY}b")"

assert_eq "a cut that lands after a space drops the space" \
    "${EIGHTY:0:76}..." \
    "$("$DERIVE" "${EIGHTY:0:76} tail of the prompt")"

for blank in "" "   " $'\n\t'; do
    if "$DERIVE" "$blank" >/dev/null 2>&1; then
        assert_eq "blank prompt $(printf '%q' "$blank") fails" "exit 1" "exit 0"
    else
        assert_eq "blank prompt $(printf '%q' "$blank") fails" "exit 1" "exit 1"
    fi
done

echo ""
echo -e "${BOLD}Results:${RESET} ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ $FAIL -eq 0 ]]
