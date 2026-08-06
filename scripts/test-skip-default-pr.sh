#!/bin/bash

# Test: skip_default_pr resolution in idow (STE-1)
#
# Verifies the resolution chain idow implements at step 6:
#   profiles.<name>.skip_default_pr → skip_default_pr → false
#
# This mirrors getSkipDefaultPr() in source/config.ts. The two resolvers run
# in different languages (bash/yq vs TS) and must agree, so we pin the bash
# side here. Key behavior: an explicit `false` on a profile overrides a
# top-level `true` — which is why the read is two-step instead of a yq //
# chain (// treats false itself as falsy and would fall through).
#
# Usage: ./test-skip-default-pr.sh

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

# Mirror idow's skip_default_pr resolution exactly (keep in sync with idow).
# Args: <profile_name> <config_path>
resolve_skip_default_pr() {
    local profile="$1"
    local config_path="$2"
    local value
    value=$(yq -r ".profiles.$profile.skip_default_pr" "$config_path" 2>/dev/null)
    if [[ -z "$value" || "$value" == "null" ]]; then
        value=$(yq -r ".skip_default_pr" "$config_path" 2>/dev/null)
    fi
    [[ "$value" == "true" ]] && echo "true" || echo "false"
}

setup_config() {
    local body="$1"
    TMPDIR_ROOT=$(mktemp -d)
    printf '%s\n' "$body" > "$TMPDIR_ROOT/.pappardelle.yml"
}

# ==========================================================================

echo -e "\n${BOLD}Test: defaults to false when neither profile nor top-level set${RESET}"
setup_config "version: 1
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_skip_default_pr "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "default → false" "false" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: top-level skip_default_pr applies when profile has none${RESET}"
setup_config "version: 1
default_profile: api
skip_default_pr: true
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_skip_default_pr "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "top-level true" "true" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile skip_default_pr beats top-level${RESET}"
setup_config "version: 1
default_profile: backend
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    skip_default_pr: true
  frontend:
    display_name: Frontend
    keywords: [frontend]"
result=$(resolve_skip_default_pr "backend" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile true wins" "true" "$result"
# A profile without its own value falls back to the (absent) top-level → false.
result=$(resolve_skip_default_pr "frontend" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile without value → false" "false" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: explicit profile false overrides a top-level true${RESET}"
setup_config "version: 1
default_profile: api
skip_default_pr: true
profiles:
  api:
    display_name: API
    keywords: [api]
    skip_default_pr: false"
result=$(resolve_skip_default_pr "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile false wins over top-level true" "false" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: unknown profile falls back to top-level${RESET}"
setup_config "version: 1
default_profile: api
skip_default_pr: true
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_skip_default_pr "nonexistent" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "unknown profile → top-level true" "true" "$result"
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
