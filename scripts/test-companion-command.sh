#!/bin/bash

# Test: companion_command resolution in resolve-claude-config.sh (STA-1464)
#
# Exercises the REAL resolver across config layers and profile levels:
#   home config → project config → local config, then profile → top-level → default.
#
# This mirrors getCompanionCommand() in source/config.ts. The two resolvers run
# in different languages (bash/yq vs TS) and must agree, so we pin the bash side
# here. Key behaviors: per-profile override beats top-level; an explicit empty
# string is preserved (means "plain shell"); a missing key falls through; a
# home-config default reaches a repo whose own config never mentions the key.
#
# Usage: ./test-companion-command.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

# Run the real resolver for a profile against whatever setup_configs() last wrote.
resolve_companion_command() {
    "$SCRIPT_DIR/resolve-claude-config.sh" \
        --config "$TMPDIR_ROOT/.pappardelle.yml" \
        --local-config "$TMPDIR_ROOT/.pappardelle.local.yml" \
        --home-config "$TMPDIR_ROOT/home/.pappardelle.yml" \
        --profile "$1" | jq -r '.companion_command'
}

# setup_configs <project_yaml> [local_yaml] [home_yaml]
setup_configs() {
    TMPDIR_ROOT=$(mktemp -d)
    mkdir -p "$TMPDIR_ROOT/home"
    printf '%s\n' "$1" > "$TMPDIR_ROOT/.pappardelle.yml"
    if [[ -n "${2:-}" ]]; then
        printf '%s\n' "$2" > "$TMPDIR_ROOT/.pappardelle.local.yml"
    fi
    if [[ -n "${3:-}" ]]; then
        printf '%s\n' "$3" > "$TMPDIR_ROOT/home/.pappardelle.yml"
    fi
}

API_PROFILE="profiles:
  api:
    display_name: API
    keywords: [api]"

# ==========================================================================

echo -e "\n${BOLD}Test: defaults to gitui when no layer sets it${RESET}"
setup_configs "version: 1
default_profile: api
$API_PROFILE"
assert_eq "default → gitui" "GIT_OPTIONAL_LOCKS=0 gitui" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: top-level companion_command applies when profile has none${RESET}"
setup_configs "version: 1
default_profile: api
companion_command: lazygit
$API_PROFILE"
assert_eq "top-level lazygit" "lazygit" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile companion_command beats top-level${RESET}"
setup_configs "version: 1
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
assert_eq "profile override wins" "make run" "$(resolve_companion_command backend)"
assert_eq "profile without override → top-level" "gitui" "$(resolve_companion_command frontend)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: explicit empty string is preserved (plain shell)${RESET}"
setup_configs "version: 1
default_profile: api
companion_command: \"\"
$API_PROFILE"
assert_eq "empty top-level stays empty" "" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile empty string overrides a non-empty top-level${RESET}"
setup_configs "version: 1
default_profile: docs
companion_command: gitui
profiles:
  docs:
    display_name: Docs
    keywords: [docs]
    companion_command: \"\""
assert_eq "profile empty wins over top-level" "" "$(resolve_companion_command docs)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: home-config top-level reaches a project that never mentions it${RESET}"
setup_configs "version: 1
default_profile: api
$API_PROFILE" "" "version: 1
companion_command: hunk diff --watch"
assert_eq "home top-level → project profile" "hunk diff --watch" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: project top-level beats home top-level${RESET}"
setup_configs "version: 1
default_profile: api
companion_command: tig
$API_PROFILE" "" "version: 1
companion_command: hunk diff --watch"
assert_eq "project top-level wins" "tig" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: home-config per-profile override applies to a project-declared profile${RESET}"
setup_configs "version: 1
default_profile: api
companion_command: tig
$API_PROFILE" "" "version: 1
profiles:
  api:
    companion_command: make run"
assert_eq "home profile override beats project top-level" "make run" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: local config beats project and home${RESET}"
setup_configs "version: 1
default_profile: api
companion_command: tig
$API_PROFILE" "companion_command: \"\"" "version: 1
companion_command: hunk diff --watch"
assert_eq "local empty string wins over both" "" "$(resolve_companion_command api)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: idow reads companion_command from the layered resolver, not the project file${RESET}"
IDOW_RAW_LOOKUPS=$(grep -c 'companion_command // .companion_command' "$SCRIPT_DIR/idow" || true)
assert_eq "no single-file yq lookup left in idow" "0" "$IDOW_RAW_LOOKUPS"
IDOW_RESOLVER_LOOKUPS=$(grep -c "jq -r '.companion_command'" "$SCRIPT_DIR/idow" || true)
assert_eq "idow takes companion_command from resolver JSON" "1" "$IDOW_RESOLVER_LOOKUPS"

# ==========================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ $FAIL -eq 0 ]]
