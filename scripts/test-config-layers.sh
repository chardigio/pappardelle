#!/bin/bash

# Test: idow reads the merged home -> project -> local config
#
# idow used to layer only the Claude settings (through resolve-agent-config.sh)
# and read everything else — profiles, team_prefix, providers, apps, links,
# hooks, companion_command — from the project .pappardelle.yml alone, so a home
# config never reached the launch path. It now merges the three layers once
# (merge_config_layers in provider-helpers.sh) and points CONFIG_PATH at the
# result. This pins the merge semantics (must match deepMerge() in
# source/config.ts: maps merge key by key, arrays replace; aliases resolve per
# file; a layer whose top level isn't a map is invalid) and guards the idow
# wiring.
#
# Usage: ./test-config-layers.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"

cleanup() {
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT

# shellcheck source=provider-helpers.sh
source "$SCRIPT_DIR/provider-helpers.sh"

# layer_file <home|project|local>
layer_file() {
    case "$1" in
        home) echo "$TMPDIR_ROOT/home/.pappardelle.yml" ;;
        project) echo "$TMPDIR_ROOT/.pappardelle.yml" ;;
        local) echo "$TMPDIR_ROOT/.pappardelle.local.yml" ;;
    esac
}

# setup_configs <project_yaml> [local_yaml] [home_yaml]
setup_configs() {
    TMPDIR_ROOT=$(mktemp -d)
    mkdir -p "$TMPDIR_ROOT/home"
    printf '%s\n' "$1" > "$(layer_file project)"
    if [[ -n "${2:-}" ]]; then
        printf '%s\n' "$2" > "$(layer_file local)"
    fi
    if [[ -n "${3:-}" ]]; then
        printf '%s\n' "$3" > "$(layer_file home)"
    fi
}

merged() {
    merge_config_layers "$(layer_file home)" "$(layer_file project)" "$(layer_file local)"
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
    "$(merge_config_layers "/nonexistent/home.yml" "$(layer_file project)" "" | yq -r '.team_prefix')"
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

# A claude list is a schema error for the TUI's validator to report, so the
# rename must leave it alone rather than fail the merge.
setup_configs "version: 1
claude: [opus]
profiles:
  api:
    claude: [sonnet]"
merged > "$TMPDIR_ROOT/merged.yml" 2>&1 || true
assert_eq "top-level claude list passes through" "opus" "$(yq -r '.claude[0]' "$TMPDIR_ROOT/merged.yml" 2>&1)"
assert_eq "profile claude list passes through" "sonnet" "$(yq -r '.profiles.api.claude[0]' "$TMPDIR_ROOT/merged.yml" 2>&1)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: a layer with no YAML document adds nothing to the merge${RESET}"
# An empty file holds zero documents.
for kind in empty whitespace-only comments-only; do
    case "$kind" in
        empty) local_text="" ;;
        whitespace-only) local_text=$'\n  \n' ;;
        comments-only) local_text=$'# only a comment\n  # and another' ;;
    esac
    setup_configs "version: 1
team_prefix: KEEP
profiles:
  api:
    display_name: API"
    printf '%s' "$local_text" > "$(layer_file local)"
    assert_eq "$kind local layer keeps team_prefix" "KEEP" "$(merged | yq -r '.team_prefix')"
    assert_eq "$kind local layer keeps profiles" "api" "$(merged | yq -r '.profiles | keys | .[]')"
    cleanup; unset TMPDIR_ROOT
done

setup_configs "version: 1
team_prefix: PROJECT" "team_prefix: LOCAL"
: > "$(layer_file home)"
assert_eq "zero-byte home layer: local still beats project" "LOCAL" "$(merged | yq -r '.team_prefix')"
cleanup; unset TMPDIR_ROOT

setup_configs "version: 1
claude:
  initialization_command: /project"
: > "$(layer_file local)"
assert_eq "empty layer beside a deprecated init command spelling" "/project" "$(merged | yq -r '.initialization_command')"
cleanup; unset TMPDIR_ROOT

setup_configs "version: 1
defaults: &defaults
  display_name: Shared
profiles:
  api:
    <<: *defaults
    team_prefix: API"
: > "$(layer_file local)"
assert_eq "empty layer beside a YAML merge key" "Shared/API" "$(merged | yq -r '.profiles.api.display_name + "/" + .profiles.api.team_prefix')"
cleanup; unset TMPDIR_ROOT

setup_configs ""
: > "$(layer_file project)"
: > "$(layer_file local)"
: > "$(layer_file home)"
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
: > "$(layer_file local)"
RESOLVED=$("$SCRIPT_DIR/resolve-agent-config.sh" \
    --config "$(layer_file project)" \
    --local-config "$(layer_file local)")
assert_eq "agent_command" "codex" "$(jq -r '.agent_command' <<<"$RESOLVED")"
assert_eq "init_cmd" "/init-workspace" "$(jq -r '.init_cmd' <<<"$RESOLVED")"
assert_eq "workspace_aware" "true" "$(jq -r '.workspace_aware' <<<"$RESOLVED")"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: a layer whose top level is a scalar or a list fails, naming the file${RESET}"
for kind in scalar list; do
    case "$kind" in
        scalar) bad_text="just a string" ;;
        list) bad_text=$'- a\n- b' ;;
    esac
    for layer in home project local; do
        setup_configs "version: 1
team_prefix: PROJECT" "team_prefix: LOCAL" "version: 1
team_prefix: HOME"
        bad_file=$(layer_file "$layer")
        printf '%s\n' "$bad_text" > "$bad_file"
        status=0
        stderr=$(merged 2>&1 >/dev/null) || status=$?
        assert_eq "$kind $layer layer fails" "failed" "$([[ $status -ne 0 ]] && echo failed || echo "exit 0")"
        assert_eq "$kind $layer layer error names the file" "$bad_file: the top level must be a map" \
            "$(grep -o "$bad_file: the top level must be a map" <<<"$stderr" || echo "$stderr")"
        cleanup; unset TMPDIR_ROOT
    done
done

# ==========================================================================

echo -e "\n${BOLD}Test: a ---, null or ~ layer adds nothing to the merge${RESET}"
for doc in --- null "~"; do
    for layer in home project local; do
        setup_configs "version: 1
team_prefix: PROJECT" "team_prefix: LOCAL" "version: 1
team_prefix: HOME
companion_command: hunk"
        case "$layer" in
            home) expected="LOCAL/none" ;;
            project) expected="LOCAL/hunk" ;;
            local) expected="PROJECT/hunk" ;;
        esac
        printf '%s\n' "$doc" > "$(layer_file "$layer")"
        assert_eq "$doc $layer layer" "$expected" "$(merged | yq -r '.team_prefix + "/" + (.companion_command // "none")')"
        cleanup; unset TMPDIR_ROOT
    done
done

# ==========================================================================

echo -e "\n${BOLD}Test: an alias resolves even when a higher layer overrides its anchor${RESET}"
setup_configs "version: 1
a: &x {k: 1}
b: *x" "a: {k: 2}"
merged > "$TMPDIR_ROOT/merged.yml" || true
assert_eq "the alias keeps the anchor's own value" "1" "$(yq -r '.b.k' "$TMPDIR_ROOT/merged.yml" 2>&1)"
assert_eq "the higher layer's value wins" "2" "$(yq -r '.a.k' "$TMPDIR_ROOT/merged.yml" 2>&1)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: an alias, a merge key and the deprecated init spelling across three layers${RESET}"
setup_configs "version: 1
base: &base
  team_prefix: BASE
  display_name: Base
profiles:
  api:
    <<: *base
    display_name: API" "command: &cmd /local-old
claude:
  initialization_command: *cmd" "version: 1
initialization_command: /home-new
profiles:
  api:
    emoji: X"
assert_eq "merge key keys and the profile's own key" "BASE/API" \
    "$(merged | yq -r '.profiles.api.team_prefix + "/" + .profiles.api.display_name')"
assert_eq "home profile key survives" "X" "$(merged | yq -r '.profiles.api.emoji')"
assert_eq "local's aliased old spelling beats home's new one" "/local-old" "$(merged | yq -r '.initialization_command')"
assert_eq "no alias or merge key is left" "0" "$(merged | grep -cE '[*&]|<<' || true)"
cleanup; unset TMPDIR_ROOT

assert_eq "no layer files merge to an empty map without reading stdin" "{}" \
    "$(merge_config_layers "" "/nonexistent/project.yml" "" </dev/null)"

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

# The merge is subtle enough (yq eval-all ireduce, per-layer explode and
# rename, missing-layer skipping) that a second copy drifts silently, which is
# how idow and the TUI stopped agreeing on the effective config before.
assert_eq "no resolver re-implements the merge" "" \
    "$(grep -lE 'ireduce|fileIndex' "$SCRIPT_DIR"/resolve-*.sh 2>/dev/null || true)"

# ==========================================================================

summarize
