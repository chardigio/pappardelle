#!/bin/bash

# Test: Jira issue_type resolution in create_issue / idow
#
# Verifies the resolution chain:
#   profiles.<name>.jira.issue_type → issue_tracker.default_issue_type → "Task"
#
# This mirrors the yq logic embedded in:
#   - scripts/provider-helpers.sh  (global default + flag fallback)
#   - scripts/idow                 (per-profile override read)
#
# Usage: ./test-jira-issue-type.sh

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

# Mirror provider-helpers.sh issue_type resolution.
# Args: <issue_type_arg> <config_path>
resolve_issue_type() {
    local issue_type="$1"
    local config_path="$2"

    if [[ -z "$issue_type" && -n "$config_path" ]]; then
        issue_type=$(yq -r '.issue_tracker.default_issue_type // ""' "$config_path")
    fi
    issue_type="${issue_type:-Task}"
    echo "$issue_type"
}

# Mirror idow's per-profile read.
# Args: <profile_name> <config_path>
read_profile_issue_type() {
    local profile="$1"
    local config_path="$2"
    yq -r ".profiles.$profile.jira.issue_type // \"\"" "$config_path"
}

setup_config() {
    local body="$1"
    TMPDIR_ROOT=$(mktemp -d)
    printf '%s\n' "$body" > "$TMPDIR_ROOT/.pappardelle.yml"
}

# ==========================================================================

echo -e "\n${BOLD}Test: defaults to \"Task\" when no config and no flag${RESET}"
result=$(resolve_issue_type "" "")
assert_eq "default fallback" "Task" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: defaults to \"Task\" when config omits issue_tracker${RESET}"
setup_config "version: 1
team_prefix: ENG
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_issue_type "" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "no issue_tracker block" "Task" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: reads issue_tracker.default_issue_type when set${RESET}"
setup_config "version: 1
team_prefix: ENG
default_profile: api
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
  default_issue_type: Feature
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_issue_type "" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "global default Feature" "Feature" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: explicit --issue-type overrides global default${RESET}"
setup_config "version: 1
team_prefix: ENG
default_profile: api
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
  default_issue_type: Feature
profiles:
  api:
    display_name: API
    keywords: [api]"
result=$(resolve_issue_type "Bug" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "explicit arg wins" "Bug" "$result"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile jira.issue_type read by idow${RESET}"
setup_config "version: 1
team_prefix: ENG
default_profile: data-analytics
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
  default_issue_type: Task
profiles:
  data-analytics:
    display_name: Data Analytics
    keywords: [analytics]
    team_prefix: DA
    jira:
      issue_type: Feature
  api:
    display_name: API
    keywords: [api]"
profile_type=$(read_profile_issue_type "data-analytics" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "per-profile read returns Feature" "Feature" "$profile_type"

# When idow passes the per-profile value as --issue-type, that wins over global default.
result=$(resolve_issue_type "$profile_type" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "per-profile beats global Task" "Feature" "$result"

# Profile without override → idow passes empty → resolver falls back to global default.
profile_type=$(read_profile_issue_type "api" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile without override returns empty" "" "$profile_type"
result=$(resolve_issue_type "$profile_type" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "no per-profile → global Task" "Task" "$result"
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
