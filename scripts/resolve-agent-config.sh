#!/bin/bash

# resolve-agent-config.sh - Resolve the agent profile and claude config values with layered override support
#
# Usage: resolve-agent-config.sh --config <path> [--local-config <path>] [--home-config <path>] [--profile <name>]
#
# Layers (lowest → highest priority):
#   1. Home config    (~/.pappardelle/.pappardelle.yml) — personal defaults across all repos
#   2. Project config (.pappardelle.yml)                — repo-level settings
#   3. Local config   (.pappardelle.local.yml)          — personal overrides (gitignored)
#
# Uses yq deep merge so ANY field in the claude section (or any future section)
# is automatically resolved without per-field override logic.
#
# --profile <name> additionally resolves the agent_profile reference and the
# deprecated claude.model / claude.effort fallback profile-first:
# profiles.<name>.<field> beats the top-level <field>. An explicit empty
# string at the profile level is preserved, which is how a profile opts out of
# an inherited value — same empty-string-is-meaningful convention
# companion_command uses.
#
# init_cmd and skip_permissions stay top-level-only here even when --profile is
# given: idow layers the per-profile initialization_command itself (and has
# since before this script was profile-aware), so resolving it here too would
# change which layer wins. The deprecated claude.initialization_command is
# renamed to initialization_command in each layer before the merge (see
# merge_config_layers), so a more specific layer wins whichever spelling it
# uses; init_cmd_deprecated is true when any layer still uses the old
# spelling, so idow can warn. Mirrored by getAgentModel()/getAgentEffort()/
# getAgentProfile() in source/config.ts and pinned by
# scripts/test-claude-model-effort.sh.
#
# The agent_profile reference (profiles.<name>.agent_profile // .agent_profile
# // "claude") is flattened to its name and resolved definition: agent_profile,
# agent_command, agent_args, agent_resume_args, agent_is_claude. The built-in
# claude agent profile (command "claude", resume "--resume {session_id}") backs
# the name "claude" unless agent_profiles.claude shadows it. agent_is_claude honors an explicit is_claude field, else
# basename-of-first-token == "claude" — same predicate as getAgentProfile().
# agent_resume_args comes back with {session_id} unfilled; idow fills it from
# the space-state file.
#
# model and effort are the agent profile's own values, else (claude agent
# profiles only) the deprecated claude.model / claude.effort. They are rendered
# into agent_launch_flags through the agent profile's model_args / effort_args,
# or the built-in templates for claude (--model {model}, --effort {effort}) and
# codex (-m {model}, -c model_reasoning_effort={effort}), quoting values the way
# renderAgentLaunchFlags() does so TUI and idow launch lines match.
# claude_launch_deprecated lists the deprecated top-level keys any raw layer
# still sets, so idow can warn.
#
# companion_command is resolved here too, profile-first over the merged layers,
# so a top-level value in the home config reaches every repo. The built-in
# default applies only when no layer defines the key at any level; an explicit
# "" (plain shell) is preserved. Mirrors getCompanionCommand() in source/config.ts.
#
# Output: JSON object with resolved values:
#   {"init_cmd": "...", "init_cmd_deprecated": "true|false",
#    "skip_permissions": "true|false", "model": "...", "effort": "...",
#    "companion_command": "...",
#    "agent_profile": "...", "agent_command": "...", "agent_args": "...",
#    "agent_resume_args": "...", "agent_is_claude": "true|false",
#    "agent_launch_flags": "...", "claude_launch_deprecated": "..."}

set -eo pipefail

CONFIG_PATH=""
LOCAL_CONFIG_PATH=""
HOME_CONFIG_PATH=""
PROFILE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --config)
            CONFIG_PATH="$2"
            shift 2
            ;;
        --local-config)
            LOCAL_CONFIG_PATH="$2"
            shift 2
            ;;
        --home-config)
            HOME_CONFIG_PATH="$2"
            shift 2
            ;;
        --profile)
            PROFILE="$2"
            shift 2
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$CONFIG_PATH" ]]; then
    echo "Error: --config is required" >&2
    exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "Error: Config file not found: $CONFIG_PATH" >&2
    exit 1
fi

# shellcheck source=SCRIPTDIR/provider-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/provider-helpers.sh"

LAYERS=()
for layer in "$HOME_CONFIG_PATH" "$CONFIG_PATH" "$LOCAL_CONFIG_PATH"; do
    [[ -n "$layer" && -f "$layer" ]] && LAYERS+=("$layer")
done

# Both spellings of the init command in one file is ambiguous; the per-layer
# rename below would silently keep the new one. Same error as
# initializationCommandConflictErrors() in source/config.ts, which idow never
# runs.
# Each check is a {prefix, conflict} row filtered by select(): yq still emits a
# string literal piped after an empty select(), so the message must be built
# from the surviving row. `eval` (not eval-all) keeps filename per file.
# shellcheck disable=SC2016 # $f is yq, not shell
INIT_CMD_CONFLICTS=$(yq eval '
    filename as $f |
    (
        [{"p": "", "c": (.initialization_command != null and .claude.initialization_command != null)}] +
        ((.profiles // {}) | to_entries | map({
            "p": "profiles." + .key + ".",
            "c": (.value.initialization_command != null and .value.claude.initialization_command != null)
        }))
    ) | .[] | select(.c) | .f = $f |
    .f + ": " + .p + "initialization_command and " + .p + "claude.initialization_command cannot both be specified (use initialization_command)"
' "${LAYERS[@]}")
if [[ -n "$INIT_CMD_CONFLICTS" ]]; then
    printf 'Error: %s\n' "$INIT_CMD_CONFLICTS" >&2
    exit 1
fi

RESOLVED=$(merge_config_layers "$HOME_CONFIG_PATH" "$CONFIG_PATH" "$LOCAL_CONFIG_PATH")

# Resolve all fields from one parse; startup calls this for the selected profile.
# Select only the keys read below before the JSON step: yq cannot write values
# such as .inf or a 20-digit integer as JSON, and such a value in an unrelated
# key must not stop idow (which runs with set -e).
#
# The agent_profile reference resolves profile-first; an explicit "" clears an
# inherited name back to claude. yq has no conditionals, so both the referenced
# definition and agent_profiles.claude are selected here and jq picks. pick()
# keeps absent fields absent, so jq's has() can tell an unset resume_args or
# model from an empty one. is_claude is read without `//`, which treats
# `false` as missing. Mirrors getAgentProfile() in source/config.ts.
# shellcheck disable=SC2016 # $selected, $agent_profile_ref, $def and strenv() are yq/jq, not shell
RESOLVED_JSON=$(printf '%s\n' "$RESOLVED" | PROFILE="$PROFILE" yq -o=json '
    (.profiles[strenv(PROFILE)] // {}) as $selected |
    ($selected.agent_profile // .agent_profile // "claude") as $agent_profile_ref |
    ["command", "args", "resume_args", "is_claude", "model", "effort", "model_args", "effort_args"] as $fields |
    {
        "initialization_command": .initialization_command,
        "claude": {
            "dangerously_skip_permissions": .claude.dangerously_skip_permissions,
            "model": .claude.model,
            "effort": .claude.effort
        },
        "companion_command": .companion_command,
        "selected": {
            "claude": {"model": $selected.claude.model, "effort": $selected.claude.effort},
            "companion_command": $selected.companion_command
        },
        "agent_profile_ref": $agent_profile_ref,
        "agent_profile_defs": {
            "ref": ((.agent_profiles[$agent_profile_ref] // {}) | pick($fields)),
            "claude": ((.agent_profiles.claude // {}) | pick($fields))
        }
    }
' | jq '
    def quote_value: if test("^[A-Za-z0-9._-]+$") then . else @sh end;
    def render($template; $placeholder; $value):
        if $value == "" or $template == "" then empty
        else $template | split($placeholder) | join($value | quote_value) end;
    def basename: [splits("\\s+") | select(. != "")][0] | split("/") | last;
    .selected as $selected |
    .claude as $claude |
    (if .agent_profile_ref == "" then "claude" else .agent_profile_ref end) as $agent_profile |
    (if .agent_profile_ref == "" then .agent_profile_defs.claude else .agent_profile_defs.ref end) as $def |
    (($def.command // "") != "") as $defined |
    # Trailing whitespace trimmed like lookupAgentProfile(): a YAML block
    # scalar (args: >) ends in a newline.
    (if $defined then $def else {command: "claude"} end
     | with_entries(if (.value | type) == "string" then .value |= sub("\\s+$"; "") else . end)) as $def_resolved |
    (if ($def_resolved.is_claude | type) == "boolean" then $def_resolved.is_claude
     else ($def_resolved.command | basename) == "claude"
     end) as $is_claude |
    (if $is_claude then {model: "--model {model}", effort: "--effort {effort}"}
     elif ($def_resolved.command | basename) == "codex" then {model: "-m {model}", effort: "-c model_reasoning_effort={effort}"}
     else {} end) as $builtin |
    ([("model", "effort") as $f | {
        key: $f,
        value: {
            value: (if $def_resolved | has($f) then ($def_resolved[$f] // "")
                    elif $is_claude then ($selected.claude[$f] // $claude[$f] // "")
                    else "" end),
            template: (if $def_resolved | has($f + "_args") then ($def_resolved[$f + "_args"] // "")
                       else ($builtin[$f] // "") end),
            template_set: (($def_resolved | has($f + "_args")) or ($builtin | has($f)))
        }
    }] | from_entries) as $launch |
    ([("model", "effort") as $f | $launch[$f] as $l |
        if $l.template_set and ($l.template | contains("{" + $f + "}") | not) then
            "agent_profiles.\($agent_profile).\($f)_args: must contain {\($f)}"
        elif $l.value != "" and ($l.template_set | not) then
            "agent_profiles.\($agent_profile).\($f): \"\($def_resolved.command)\" has no built-in \($f) flag; set \($f)_args"
        else empty end
    ] + [$def_resolved | to_entries[]
        | select((.value | type) == "string" and (.value | test("[\r\n]")))
        | "agent_profiles.\($agent_profile).\(.key): must be a single line"
    ] | join("\n")) as $launch_errors |
    {
        init_cmd: (.initialization_command // ""),
        skip_permissions: (.claude.dangerously_skip_permissions // false),
        model: $launch.model.value,
        effort: $launch.effort.value,
        companion_command: ($selected.companion_command // .companion_command // "GIT_OPTIONAL_LOCKS=0 gitui"),
        agent_profile: $agent_profile,
        agent_command: $def_resolved.command,
        agent_args: ($def_resolved.args // ""),
        agent_resume_args: (if $def_resolved | has("resume_args") then ($def_resolved.resume_args // "")
                            elif $is_claude then "--resume {session_id}" else "" end),
        agent_is_claude: $is_claude,
        agent_launch_flags: ([render($launch.model.template; "{model}"; $launch.model.value),
                              render($launch.effort.template; "{effort}"; $launch.effort.value)] | join(" ")),
        agent_profile_missing: (if $defined or $agent_profile == "claude" then "" else $agent_profile end),
        agent_launch_errors: $launch_errors
    } |
    with_entries(.value |= tostring) |
    .skip_permissions = ((.skip_permissions == "true") | tostring)
')

# The TUI rejects a reference to an undefined agent profile at config load;
# idow never runs that validator, so a typo would otherwise quietly launch
# claude.
AGENT_PROFILE_MISSING=$(jq -r '.agent_profile_missing' <<< "$RESOLVED_JSON")
if [[ -n "$AGENT_PROFILE_MISSING" ]]; then
    echo "Error: agent profile \"$AGENT_PROFILE_MISSING\" not found in agent_profiles" >&2
    exit 1
fi
AGENT_LAUNCH_ERRORS=$(jq -r '.agent_launch_errors' <<< "$RESOLVED_JSON")
if [[ -n "$AGENT_LAUNCH_ERRORS" ]]; then
    printf 'Error: %s\n' "$AGENT_LAUNCH_ERRORS" >&2
    exit 1
fi

# merge_config_layers already renamed the deprecated claude.initialization_command
# per layer; the marker lets idow warn if any raw layer still uses it.
INIT_CMD_DEPRECATED=$(yq ea '[.claude.initialization_command | select(. != null)] | length > 0' "${LAYERS[@]}")
# shellcheck disable=SC2016 # yq expression, not shell
CLAUDE_LAUNCH_DEPRECATED=$(yq ea -o=json -I=0 '[.claude | select(. != null) | (pick(["model", "effort"]) | keys | .[])] | unique | sort | map("claude." + .) | join(" ")' "${LAYERS[@]}")

jq --arg init_cmd_deprecated "$INIT_CMD_DEPRECATED" --argjson claude_launch_deprecated "$CLAUDE_LAUNCH_DEPRECATED" \
    'del(.agent_profile_missing, .agent_launch_errors) | .init_cmd_deprecated = $init_cmd_deprecated | .claude_launch_deprecated = $claude_launch_deprecated' <<< "$RESOLVED_JSON"
