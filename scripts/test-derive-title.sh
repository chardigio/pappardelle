#!/bin/bash

# Test: derive-title.sh, which idow uses to title an issue created from a
# description
#
# Usage: ./test-derive-title.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
DERIVE="$SCRIPT_DIR/derive-title.sh"

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
    "$DERIVE" "$blank" >/dev/null 2>&1 && rc=0 || rc=$?
    assert_eq "blank prompt $(printf '%q' "$blank") exits 1" "1" "$rc"
done

summarize
