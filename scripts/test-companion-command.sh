#!/bin/bash

# Test: companion_command resolution in idow (STA-1464)
#
# Verifies the resolution chain the idow yq one-liner implements:
#   profiles.<name>.companion_command → companion_command → "GIT_OPTIONAL_LOCKS=0 gitui"
#
# This mirrors getCompanionCommand() in source/config.ts. The two resolvers run
# in different languages (bash/yq vs TS) and must agree, so we pin the bash side
# here. Key behaviors: per-profile override beats top-level; an explicit empty
# string is preserved (means "plain shell"); a missing key falls through.
#
# Usage: ./test-companion-command.sh

set -e

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

cleanup() {
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT

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

# Mirror idow's companion_command resolution exactly (keep in sync with idow).
# Args: <profile_name> <config_path>
resolve_companion_command() {
    local profile="$1"
    local config_path="$2"
    yq -r "(.profiles.$profile.companion_command // .companion_command) // \"GIT_OPTIONAL_LOCKS=0 gitui\"" "$config_path"
}

setup_config() {
    local body="$1"
    TMPDIR_ROOT=$(mktemp -d)
    printf '%s\n' "$body" > "$TMPDIR_ROOT/.pappardelle.yml"
}

# ==========================================================================

echo -e "\n${BOLD}Test: defaults to gitui when neither profile nor top-level set${RESET}"
setup_config "version: 1
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_companion_command "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "default → gitui" "GIT_OPTIONAL_LOCKS=0 gitui" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: top-level companion_command applies when profile has none${RESET}"
setup_config "version: 1
default_profile: api
companion_command: lazygit
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_companion_command "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "top-level lazygit" "lazygit" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile companion_command beats top-level${RESET}"
setup_config "version: 1
default_profile: backend
companion_command: gitui
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    companion_command: make run
  frontend:
    display_name: Frontend
    keywords: [frontend]"
result=$(resolve_companion_command "backend" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile override wins" "make run" "$result"
# A profile without its own override falls back to the top-level value.
result=$(resolve_companion_command "frontend" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile without override → top-level" "gitui" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: explicit empty string is preserved (plain shell)${RESET}"
setup_config "version: 1
default_profile: api
companion_command: \"\"
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_companion_command "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "empty top-level stays empty" "" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile empty string overrides a non-empty top-level${RESET}"
setup_config "version: 1
default_profile: docs
companion_command: gitui
profiles:
  docs:
    display_name: Docs
    keywords: [docs]
    companion_command: \"\""
result=$(resolve_companion_command "docs" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile empty wins over top-level" "" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
