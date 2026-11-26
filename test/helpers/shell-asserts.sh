# shellcheck shell=bash
# The tally, assertions and summary every scripts/test-*.sh shares. Sourced, so
# it sets no shell options: test-schedule-systemd.sh runs under set -u, the rest
# under set -e. macOS runs these scripts with its /bin/bash 3.2.

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0

pass() {
	printf '  %bPASS%b %s\n' "$GREEN" "$RESET" "$1"
	PASS=$((PASS + 1))
}

# fail <name> [detail...]
fail() {
	local name=$1 detail
	shift
	printf '  %bFAIL%b %s\n' "$RED" "$RESET" "$name"
	for detail; do
		printf '    %s\n' "$detail"
	done
	FAIL=$((FAIL + 1))
}

assert_eq() {
	if [[ "$3" == "$2" ]]; then
		pass "$1"
	else
		fail "$1" "Expected: \"$2\"" "Actual:   \"$3\""
	fi
}

assert_file_exists() {
	if [[ -f "$2" ]]; then
		pass "$1"
	else
		fail "$1" "Expected file to exist: $2"
	fi
}

assert_file_not_exists() {
	if [[ ! -f "$2" ]]; then
		pass "$1"
	else
		fail "$1" "Expected file to NOT exist: $2"
	fi
}

assert_file_content() {
	assert_eq "$1" "$3" "$(cat "$2" 2>/dev/null)"
}

summarize() {
	local total=$((PASS + FAIL))
	echo ""
	if [[ "$FAIL" -eq 0 ]]; then
		printf '%b%bAll %s tests passed%b\n' "$GREEN" "$BOLD" "$total" "$RESET"
		exit 0
	fi
	printf '%b%b%s of %s tests failed%b\n' "$RED" "$BOLD" "$FAIL" "$total" "$RESET"
	exit 1
}
