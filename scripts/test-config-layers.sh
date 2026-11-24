#!/bin/bash

# Test: idow reads the merged home -> project -> local config
#
# idow used to layer only the Claude settings (through resolve-agent-config.sh)
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
      dangerously_skip_permissions: true" "team_prefix: LOCAL
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
assert_eq "nested map merges across all three layers" "true high opus" \
    "$(merged | yq -r '.profiles.api.claude | [.dangerously_skip_permissions, .effort, .model] | join(" ")')"
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

echo -e "\n${BOLD}Test: layer precedence beats init command spelling${RESET}"
# A project still on the deprecated claude.initialization_command must override
# a home config that has migrated; each layer is renamed before the merge.
setup_configs "version: 1
claude:
  initialization_command: /project
profiles:
  api:
    claude:
      initialization_command: /project-api" "" "version: 1
initialization_command: /home
profiles:
  api:
    initialization_command: /home-api"
assert_eq "top level: project's old spelling beats home's new one" "/project" "$(merged | yq -r '.initialization_command')"
assert_eq "profile: project's old spelling beats home's new one" "/project-api" "$(merged | yq -r '.profiles.api.initialization_command')"
assert_eq "old spelling is gone after the rename" "null" "$(merged | yq -r '.claude.initialization_command')"
cleanup; unset TMPDIR_ROOT

setup_configs "version: 1
initialization_command: /new
claude:
  initialization_command: /old"
assert_eq "a layer with both spellings keeps the new one" "/new" "$(merged | yq -r '.initialization_command')"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: a layer with no YAML document adds nothing to the merge${RESET}"
# An empty file is zero documents, and yq's `*` over per-file selects used to
# make the whole merge empty when any layer had none.
declare -A EMPTY_LAYERS=(
    [empty]=""
    [whitespace-only]=$'\n  \n'
    [comments-only]=$'# only a comment\n  # and another'
)
for kind in empty whitespace-only comments-only; do
    setup_configs "version: 1
team_prefix: KEEP
profiles:
  api:
    display_name: API"
    printf '%s' "${EMPTY_LAYERS[$kind]}" > "$TMPDIR_ROOT/.pappardelle.local.yml"
    assert_eq "$kind local layer keeps team_prefix" "KEEP" "$(merged | yq -r '.team_prefix')"
    assert_eq "$kind local layer keeps profiles" "api" "$(merged | yq -r '.profiles | keys | .[]')"
    cleanup; unset TMPDIR_ROOT
done

setup_configs "version: 1
team_prefix: PROJECT" "team_prefix: LOCAL"
: > "$TMPDIR_ROOT/home/.pappardelle.yml"
assert_eq "zero-byte home layer: local still beats project" "LOCAL" "$(merged | yq -r '.team_prefix')"
cleanup; unset TMPDIR_ROOT

setup_configs ""
: > "$TMPDIR_ROOT/.pappardelle.yml"
: > "$TMPDIR_ROOT/.pappardelle.local.yml"
: > "$TMPDIR_ROOT/home/.pappardelle.yml"
assert_eq "every layer empty merges to an empty map" "{}" "$(merged)"
cleanup; unset TMPDIR_ROOT

echo -e "\n${BOLD}Test: resolve-agent-config.sh keeps the project config beside an empty local file${RESET}"
setup_configs "version: 1
workspace_aware_agents: true
initialization_command: /init-workspace
agent_profile: codex
agent_profiles:
  codex:
    command: codex"
: > "$TMPDIR_ROOT/.pappardelle.local.yml"
RESOLVED=$("$SCRIPT_DIR/resolve-agent-config.sh" \
    --config "$TMPDIR_ROOT/.pappardelle.yml" \
    --local-config "$TMPDIR_ROOT/.pappardelle.local.yml")
assert_eq "agent_command" "codex" "$(jq -r '.agent_command' <<<"$RESOLVED")"
assert_eq "init_cmd" "/init-workspace" "$(jq -r '.init_cmd' <<<"$RESOLVED")"
assert_eq "workspace_aware" "true" "$(jq -r '.workspace_aware' <<<"$RESOLVED")"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: idow wiring${RESET}"
IDOW="$SCRIPT_DIR/idow"
assert_eq "idow merges the layers into CONFIG_PATH" "1" "$(grep -c 'CONFIG_PATH="\$MERGED_CONFIG_PATH"' "$IDOW" || true)"
assert_eq "merge runs before the first provider read" "yes" \
    "$(awk '/CONFIG_PATH="\$MERGED_CONFIG_PATH"/{m=NR} /get_issue_tracker_provider "\$CONFIG_PATH"/{r=NR} END{print (m && r && m<r) ? "yes" : "no"}' "$IDOW")"
assert_eq "no yq read bypasses the merge via PROJECT_CONFIG_PATH" "0" "$(grep -c 'yq .*PROJECT_CONFIG_PATH' "$IDOW" || true)"
assert_eq "resolver calls take the project layer" "0" \
    "$(grep 'resolve-agent-config\.sh"' "$IDOW" | grep -vc -- '--config "$PROJECT_CONFIG_PATH"' || true)"
assert_eq "resolver calls reuse the merged snapshot" "0" \
    "$(grep 'resolve-agent-config\.sh"' "$IDOW" | grep -vc -- '--merged "$CONFIG_PATH"' || true)"
assert_eq "terminal resolver reuses the merged snapshot" "0" \
    "$(grep 'resolve-terminal-app\.sh"' "$IDOW" | grep -vc -- '--config "$CONFIG_PATH"' || true)"

# The merge is subtle enough (yq eval-all ireduce, single-file
# shortcut, missing-layer skipping) that a second copy drifts silently, which is
# how idow and the TUI stopped agreeing on the effective config before.
assert_eq "no resolver re-implements the merge" "" \
    "$(grep -l 'ireduce' "$SCRIPT_DIR"/resolve-*.sh 2>/dev/null || true)"

# ==========================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ $FAIL -eq 0 ]]
