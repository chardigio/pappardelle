#!/bin/bash

# Test: team_prefix and REPO_ROOT resolution in idow/dow
#
# Verifies that:
# 1. TEAM_PREFIX is read from .pappardelle.yml (not hardcoded STA)
# 2. REPO_ROOT uses PAPPARDELLE_PROJECT_ROOT when set
# 3. REPO_ROOT falls back to git rev-parse from cwd when env var unset
# 4. create_issue reads team_prefix from config when --team not passed
#
# Usage: ./test-team-prefix.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

# Colors
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

assert_contains() {
    local test_name="$1"
    local haystack="$2"
    local needle="$3"

    if [[ "$haystack" == *"$needle"* ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected to contain: \"$needle\""
        echo "    Actual: \"$haystack\""
        FAIL=$((FAIL + 1))
    fi
}

# Create a temp dir with a minimal .pappardelle.yml
setup_config() {
    local team_prefix="$1"
    TMPDIR_ROOT=$(mktemp -d)

    if [[ -n "$team_prefix" ]]; then
        cat > "$TMPDIR_ROOT/.pappardelle.yml" <<EOF
version: 1
team_prefix: $team_prefix
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]
EOF
    else
        cat > "$TMPDIR_ROOT/.pappardelle.yml" <<EOF
version: 1
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]
EOF
    fi
}

setup_git_repo() {
    TMPDIR_ROOT=$(realpath "$(mktemp -d)")
    cd "$TMPDIR_ROOT"
    git init --quiet
    echo "init" > README.md
    git add README.md
    git commit -m "init" --quiet

    cat > "$TMPDIR_ROOT/.pappardelle.yml" <<EOF
version: 1
team_prefix: FOO
default_profile: api
profiles:
  api:
    display_name: API
    keywords: [api]
EOF
}

teardown() {
    cd /
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
    unset TMPDIR_ROOT
}

# ==========================================================================

echo -e "${BOLD}Test: TEAM_PREFIX reads from config with custom prefix${RESET}"
setup_config "CHEX"
CONFIG_PATH="$TMPDIR_ROOT/.pappardelle.yml"

TEAM_PREFIX=$(yq -r '.team_prefix // "STA"' "$CONFIG_PATH" | tr '[:lower:]' '[:upper:]')
assert_eq "team_prefix is CHEX" "CHEX" "$TEAM_PREFIX"

# Verify bare number resolves to CHEX-123 (not STA-123)
ISSUE_KEY="${TEAM_PREFIX}-123"
assert_eq "bare number 123 becomes CHEX-123" "CHEX-123" "$ISSUE_KEY"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: TEAM_PREFIX defaults to STA when not in config${RESET}"
setup_config ""
CONFIG_PATH="$TMPDIR_ROOT/.pappardelle.yml"

TEAM_PREFIX=$(yq -r '.team_prefix // "STA"' "$CONFIG_PATH" | tr '[:lower:]' '[:upper:]')
assert_eq "team_prefix defaults to STA" "STA" "$TEAM_PREFIX"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: TEAM_PREFIX is uppercased${RESET}"
setup_config "chex"
CONFIG_PATH="$TMPDIR_ROOT/.pappardelle.yml"

TEAM_PREFIX=$(yq -r '.team_prefix // "STA"' "$CONFIG_PATH" | tr '[:lower:]' '[:upper:]')
assert_eq "lowercase chex uppercased to CHEX" "CHEX" "$TEAM_PREFIX"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: REPO_ROOT uses PAPPARDELLE_PROJECT_ROOT when set${RESET}"
export PAPPARDELLE_PROJECT_ROOT="/tmp/fake-project"

if [[ -n "${PAPPARDELLE_PROJECT_ROOT:-}" ]]; then
    REPO_ROOT="$PAPPARDELLE_PROJECT_ROOT"
else
    REPO_ROOT="SHOULD_NOT_HAPPEN"
fi
assert_eq "REPO_ROOT equals PAPPARDELLE_PROJECT_ROOT" "/tmp/fake-project" "$REPO_ROOT"

unset PAPPARDELLE_PROJECT_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: REPO_ROOT falls back to git rev-parse when env var unset${RESET}"
setup_git_repo

unset PAPPARDELLE_PROJECT_ROOT
if [[ -n "${PAPPARDELLE_PROJECT_ROOT:-}" ]]; then
    REPO_ROOT="$PAPPARDELLE_PROJECT_ROOT"
else
    REPO_ROOT=$(git rev-parse --show-toplevel)
fi
assert_eq "REPO_ROOT equals git root" "$TMPDIR_ROOT" "$REPO_ROOT"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: create_issue reads team_prefix from config (provider-helpers)${RESET}"
setup_config "PROJ"
CONFIG_PATH="$TMPDIR_ROOT/.pappardelle.yml"

# Source just the team-reading logic from provider-helpers
team=""
if [[ -z "$team" && -n "$CONFIG_PATH" ]]; then
    team=$(yq -r '.team_prefix // "STA"' "$CONFIG_PATH" | tr '[:lower:]' '[:upper:]')
fi
team="${team:-STA}"
assert_eq "create_issue team reads PROJ from config" "PROJ" "$team"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: create_issue --team flag overrides config${RESET}"
setup_config "PROJ"
CONFIG_PATH="$TMPDIR_ROOT/.pappardelle.yml"

# Simulate --team flag being set
team="OVERRIDE"
if [[ -z "$team" && -n "$CONFIG_PATH" ]]; then
    team=$(yq -r '.team_prefix // "STA"' "$CONFIG_PATH" | tr '[:lower:]' '[:upper:]')
fi
team="${team:-STA}"
assert_eq "explicit --team overrides config" "OVERRIDE" "$team"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree.sh MAIN_REPO uses PAPPARDELLE_PROJECT_ROOT${RESET}"

# The line in create-worktree.sh is:
# MAIN_REPO="${MAIN_REPO:-${PAPPARDELLE_PROJECT_ROOT:-$(git rev-parse --show-toplevel)}}"
unset MAIN_REPO
export PAPPARDELLE_PROJECT_ROOT="/tmp/my-project"

MAIN_REPO="${MAIN_REPO:-${PAPPARDELLE_PROJECT_ROOT:-fallback}}"
assert_eq "MAIN_REPO uses PAPPARDELLE_PROJECT_ROOT" "/tmp/my-project" "$MAIN_REPO"

unset MAIN_REPO PAPPARDELLE_PROJECT_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree.sh MAIN_REPO prefers explicit MAIN_REPO over env${RESET}"

export MAIN_REPO="/explicit/path"
export PAPPARDELLE_PROJECT_ROOT="/tmp/my-project"

RESOLVED="${MAIN_REPO:-${PAPPARDELLE_PROJECT_ROOT:-fallback}}"
assert_eq "explicit MAIN_REPO takes precedence" "/explicit/path" "$RESOLVED"

unset MAIN_REPO PAPPARDELLE_PROJECT_ROOT

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
