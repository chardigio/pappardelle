# shellcheck shell=bash
# The tally, assertions and summary every scripts/test-*.sh shares. Sourced, so
# it sets no shell options: some callers run under set -u, the rest under set -e.
# macOS runs these scripts with its /bin/bash 3.2.

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() {
	printf '  %bPASS%b %s\n' "$GREEN" "$RESET" "$1"
	PASS=$((PASS + 1))
}

fail() {
	local name=$1 detail
	shift
	printf '  %bFAIL%b %s\n' "$RED" "$RESET" "$name"
	for detail; do
		printf '    %s\n' "$detail"
	done
	FAIL=$((FAIL + 1))
}

skip() {
	printf '  SKIP %s\n' "$1"
	SKIP=$((SKIP + 1))
}

section() {
	printf '\n%bTest: %s%b\n' "$BOLD" "$1" "$RESET"
}

assert_eq() {
	if [[ "$3" == "$2" ]]; then
		pass "$1"
	else
		fail "$1" "Expected: \"$2\"" "Actual:   \"$3\""
	fi
}

assert_contains() {
	if [[ "$3" == *"$2"* ]]; then
		pass "$1"
	else
		fail "$1" "Expected to contain: \"$2\"" "Actual:              \"$3\""
	fi
}

assert_not_contains() {
	if [[ "$3" != *"$2"* ]]; then
		pass "$1"
	else
		fail "$1" "Expected not to contain: \"$2\"" "Actual:                  \"$3\""
	fi
}

assert_file_not_exists() {
	if [[ ! -f "$2" ]]; then
		pass "$1"
	else
		fail "$1" "Expected file to NOT exist: $2"
	fi
}

summarize() {
	local total=$((PASS + FAIL)) skipped=''
	[[ "$SKIP" -eq 0 ]] || skipped=", $SKIP skipped"
	echo ""
	if [[ "$FAIL" -eq 0 ]]; then
		printf '%b%bAll %s tests passed%s%b\n' "$GREEN" "$BOLD" "$total" "$skipped" "$RESET"
		exit 0
	fi
	printf '%b%b%s of %s tests failed%s%b\n' "$RED" "$BOLD" "$FAIL" "$total" "$skipped" "$RESET"
	exit 1
}
