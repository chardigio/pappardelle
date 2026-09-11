#!/bin/bash

# Test: idow reads the merged home -> project -> local config
#
# idow used to layer only the Claude settings (through resolve-claude-config.sh)
# and read everything else — profiles, team_prefix, providers, apps, links,
# hooks, companion_command — from the project .pappardelle.yml alone, so a home
# config never reached the launch path. It now merges the three layers once
# (merge_config_layers in provider-helpers.sh) and points CONFIG_PATH at the
# result. This pins the merge semantics (must match deepMerge() in
# source/config.ts: maps merge key by key, arrays replace) and guards the idow
# wiring.
#
# Usage: ./test-config-layers.sh

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

# shellcheck source=provider-helpers.sh
source "$SCRIPT_DIR/provider-helpers.sh"

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

merged() {
    merge_config_layers "$TMPDIR_ROOT/home/.pappardelle.yml" "$TMPDIR_ROOT/.pappardelle.yml" "$TMPDIR_ROOT/.pappardelle.local.yml"
}

# ==========================================================================

echo -e "\n${BOLD}Test: project-only config passes through unchanged${RESET}"
setup_configs "version: 1
team_prefix: STA
profiles:
  api:
    display_name: API"
assert_eq "team_prefix" "STA" "$(merged | yq -r '.team_prefix')"
assert_eq "profile list" "api" "$(merged | yq -r '.profiles | keys | .[]')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: home-only settings reach a project that never mentions them${RESET}"
setup_configs "version: 1
profiles:
  api:
    display_name: API" "" "version: 1
team_prefix: RXAI
default_profile: rex-ai
companion_command: hunk diff --watch
issue_tracker:
  provider: jira
vcs_host:
  provider: gitlab
  host: gitlab.example.com
profiles:
  rex-ai:
    display_name: REx AI
    keywords: [rex]
    links:
      - url: \"\${ISSUE_URL}\"
        title: Jira"
assert_eq "team_prefix from home" "RXAI" "$(merged | yq -r '.team_prefix')"
assert_eq "default_profile from home" "rex-ai" "$(merged | yq -r '.default_profile')"
assert_eq "home profile joins the project's" "api rex-ai" "$(merged | yq -r '.profiles | keys | sort | join(" ")')"
assert_eq "home profile keywords survive" "rex" "$(merged | yq -r '.profiles.rex-ai.keywords[0]')"
assert_eq "home profile links survive" "Jira" "$(merged | yq -r '.profiles.rex-ai.links[0].title')"
assert_eq "provider from home" "jira" "$(get_issue_tracker_provider <(merged))"
assert_eq "gitlab host from home" "gitlab.example.com" "$(get_gitlab_host <(merged))"
assert_eq "companion_command from home" "hunk diff --watch" "$(merged | yq -r '.companion_command')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: project beats home, local beats both, key by key${RESET}"
setup_configs "version: 1
team_prefix: PROJ
profiles:
  api:
    display_name: API
    claude:
      initialization_command: /do" "team_prefix: LOCAL
profiles:
  api:
    claude:
      model: opus" "version: 1
team_prefix: HOME
companion_command: hunk diff --watch
profiles:
  api:
    display_name: Home API
    emoji: X
    claude:
      effort: high"
assert_eq "scalar: local wins" "LOCAL" "$(merged | yq -r '.team_prefix')"
assert_eq "profile scalar: project beats home" "API" "$(merged | yq -r '.profiles.api.display_name')"
assert_eq "profile key only in home survives" "X" "$(merged | yq -r '.profiles.api.emoji')"
assert_eq "nested map merges across all three layers" "/do high opus" \
    "$(merged | yq -r '.profiles.api.claude | [.initialization_command, .effort, .model] | join(" ")')"
assert_eq "home-only top-level key survives" "hunk diff --watch" "$(merged | yq -r '.companion_command')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: arrays replace, they do not append (matches deepMerge in config.ts)${RESET}"
setup_configs "version: 1
profiles:
  api:
    keywords: [project-kw]" "" "version: 1
profiles:
  api:
    keywords: [home-kw-1, home-kw-2]"
assert_eq "project array replaces home array" "project-kw" "$(merged | yq -r '.profiles.api.keywords | join(",")')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: missing home and local files are skipped, not errors${RESET}"
setup_configs "version: 1
team_prefix: ONLY"
assert_eq "no home, no local" "ONLY" "$(merged | yq -r '.team_prefix')"
assert_eq "nonexistent explicit path is skipped" "ONLY" \
    "$(merge_config_layers "/nonexistent/home.yml" "$TMPDIR_ROOT/.pappardelle.yml" "" | yq -r '.team_prefix')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: idow wiring${RESET}"
IDOW="$SCRIPT_DIR/idow"
assert_eq "idow merges the layers into CONFIG_PATH" "1" "$(grep -c 'CONFIG_PATH="\$MERGED_CONFIG_PATH"' "$IDOW" || true)"
assert_eq "merge runs before the first provider read" "yes" \
    "$(awk '/CONFIG_PATH="\$MERGED_CONFIG_PATH"/{m=NR} /get_issue_tracker_provider "\$CONFIG_PATH"/{r=NR} END{print (m && r && m<r) ? "yes" : "no"}' "$IDOW")"
assert_eq "no yq read bypasses the merge via PROJECT_CONFIG_PATH" "0" "$(grep -c 'yq .*PROJECT_CONFIG_PATH' "$IDOW" || true)"
assert_eq "resolver calls take the project layer and merge themselves" "0" \
    "$(grep 'resolve-claude-config\.sh"' "$IDOW" | grep -vc -- '--config "$PROJECT_CONFIG_PATH"' || true)"

# ==========================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ $FAIL -eq 0 ]]
