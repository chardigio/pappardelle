#!/bin/bash

# Test: tracker_projects[0] auto-assignment in create_issue (STA-959)
#
# Verifies the bash side of "auto-assign Linear project on issue creation
# based on profile" — `provider-helpers.sh` reads `tracker_projects[0]` for
# the resolved profile and passes the resolved UUID to create-linear-issue.sh.
#
# What this exercises:
# - get_profile_default_project_name (yq lookup)
# - resolve_linear_project_uuid       (jq filter against linctl JSON fixture)
# - off-by-default behavior when tracker_projects is missing/empty
#
# linctl is NOT called here — resolve_linear_project_uuid is split so the
# pure jq filter is testable against fixture JSON. The shell-out to linctl
# is exercised only by the integration test.
#
# Usage: ./test-default-project.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-helpers.sh"

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

setup_config() {
    TMPDIR_ROOT=$(mktemp -d)
    cat > "$TMPDIR_ROOT/.pappardelle.yml" <<'EOF'
version: 1
team_prefix: STA
default_profile: pappardelle
profiles:
  pappardelle:
    display_name: Pappardelle
    keywords: [pappardelle]
    tracker_projects:
      - "Pappardelle Quality"
  king-bee:
    display_name: King Bee
    keywords: [bee]
    tracker_projects:
      - "The Hive Quality"
      - "Wordle"
  no-projects:
    display_name: No Projects
    keywords: [none]
  empty-projects:
    display_name: Empty Projects
    keywords: [empty]
    tracker_projects: []
EOF
}

# JSON fixture mirroring `linctl project list --json --include-completed`.
# Captured shape: array of {id, name, ...} — the `resolve_linear_project_uuid`
# jq filter only reads `id` and `name`.
PROJECTS_JSON='[
  {"id":"4e6ef808-9576-4082-8dfd-a1d352a2817e","name":"Pappardelle Quality"},
  {"id":"abc-the-hive","name":"The Hive Quality"},
  {"id":"abc-wordle","name":"Wordle"},
  {"id":"abc-stardust","name":"Stardust Jams Quality"}
]'

# Substitute the test's fixture JSON for the linctl call. The function under
# test reads from `linctl project list ...`, so we shadow `linctl` for the
# duration of these tests.
linctl() {
    if [[ "$1" == "project" && "$2" == "list" ]]; then
        echo "$PROJECTS_JSON"
        return 0
    fi
    command linctl "$@"
}
export -f linctl

# ==========================================================================

echo -e "${BOLD}Test: get_profile_default_project_name reads tracker_projects[0]${RESET}"
setup_config
result=$(get_profile_default_project_name "pappardelle" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "single-entry profile" "Pappardelle Quality" "$result"

result=$(get_profile_default_project_name "king-bee" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "two-entry profile takes [0]" "The Hive Quality" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: get_profile_default_project_name returns empty for off-by-default cases${RESET}"
result=$(get_profile_default_project_name "no-projects" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile without tracker_projects" "" "$result"

result=$(get_profile_default_project_name "empty-projects" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "profile with empty tracker_projects array" "" "$result"

result=$(get_profile_default_project_name "" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "missing profile arg" "" "$result"

result=$(get_profile_default_project_name "ghost" "$TMPDIR_ROOT/.pappardelle.yml")
assert_eq "unknown profile name" "" "$result"

cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: resolve_linear_project_uuid finds exact match${RESET}"
result=$(resolve_linear_project_uuid "Pappardelle Quality" 2>/dev/null)
assert_eq "exact name → UUID" "4e6ef808-9576-4082-8dfd-a1d352a2817e" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: resolve_linear_project_uuid is case-insensitive${RESET}"
result=$(resolve_linear_project_uuid "PAPPARDELLE QUALITY" 2>/dev/null)
assert_eq "uppercase input matches" "4e6ef808-9576-4082-8dfd-a1d352a2817e" "$result"

result=$(resolve_linear_project_uuid "the hive quality" 2>/dev/null)
assert_eq "lowercase input matches" "abc-the-hive" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: resolve_linear_project_uuid warns + returns empty on no match${RESET}"
warn_output=$(resolve_linear_project_uuid "Project That Does Not Exist" 2>&1 1>/dev/null)
result=$(resolve_linear_project_uuid "Project That Does Not Exist" 2>/dev/null)
assert_eq "no match → empty stdout" "" "$result"
case "$warn_output" in
    *"not found"*) echo -e "  ${GREEN}PASS${RESET} no match → warning on stderr"; PASS=$((PASS + 1)) ;;
    *) echo -e "  ${RED}FAIL${RESET} no match → warning on stderr"
       echo "    Expected stderr to contain: \"not found\""
       echo "    Actual stderr: \"$warn_output\""
       FAIL=$((FAIL + 1)) ;;
esac

# ==========================================================================

echo -e "\n${BOLD}Test: resolve_linear_project_uuid short-circuits on empty name${RESET}"
result=$(resolve_linear_project_uuid "" 2>/dev/null)
assert_eq "empty name → empty UUID, no linctl call" "" "$result"

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
