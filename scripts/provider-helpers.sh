#!/bin/bash

# provider-helpers.sh - Shared functions for provider-agnostic issue tracking and VCS
#
# Source this file in the idow script to get provider dispatch functions.
# Reads provider config from .pappardelle.yml using yq.
#
# Requires: yq, jq, and the relevant CLI tools (linctl/acli, gh/glab)

# Get the issue tracker provider from .pappardelle.yml
# Returns: "linear" (default), "jira", or "beads"
get_issue_tracker_provider() {
    local config_path="$1"
    local provider
    provider=$(yq -r '.issue_tracker.provider // "linear"' "$config_path" 2>/dev/null)
    echo "$provider"
}

# The main repository root, resolved through worktrees. Every bd invocation runs
# here so each worktree reads and writes the one canonical beads database
# instead of whatever copy its branch happens to carry.
beads_repo_root() {
    local common_dir
    common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
        git rev-parse --show-toplevel 2>/dev/null
        return
    }
    dirname "$common_dir"
}

run_bd() {
    (cd "$(beads_repo_root)" && BD_JSON_ENVELOPE=1 bd "$@")
}

# Every beads ID prefix this repo can mint keys under, one per line, lowercased.
# Sources are the database's own issue-prefix, the global team_prefix, each
# profile's team_prefix override, and each profile's tracker_projects (which
# name beads prefixes the way they name Linear/Jira projects for the other
# trackers).
#
# The database's issue-prefix is the one bd actually mints IDs under and need
# not match team_prefix: a repo migrating off Linear keeps the old team prefix
# while beads names issues after the repo directory.
#
# Mirrors getBeadsPrefixes in source/config.ts and get_beads_prefixes in
# hooks/tracker_config.py; all three have to agree or the same input is a key in
# one place and prose in another.
#
# $2 overrides the .beads/config.yaml path; exposed for tests, which must not
# pick up the prefix of whatever repo they happen to run in.
beads_id_prefixes() {
    local config_path="$1" beads_config="${2-}"
    [[ -n "$beads_config" ]] || beads_config="$(beads_repo_root)/.beads/config.yaml"
    {
        [[ -f "$beads_config" ]] &&
            yq -r '.["issue-prefix"] | select(. != null and . != "")' \
                "$beads_config" 2>/dev/null
        yq -r '[.team_prefix, .profiles[].team_prefix, .profiles[].tracker_projects[]]
               | .[] | select(. != null and . != "")' \
            "$config_path" 2>/dev/null
    } | tr '[:upper:]' '[:lower:]' | sort -u
}

# Whether $1 is a beads issue ID belonging to a prefix configured in $2.
#
# A beads suffix is a content hash, so it can be pure letters, and nothing about
# the shape of `fix-crash` distinguishes it from an ID. Without anchoring to the
# configured prefixes, every hyphenated description would be routed as an
# existing issue and die on the bd lookup instead of creating one.
is_beads_issue_key() {
    local input="$1" config_path="$2" beads_config="${3-}" prefix input_prefix

    [[ "$input" =~ ^[a-zA-Z0-9_]+(-[a-zA-Z0-9_]+)+(\.[0-9]+){0,3}$ ]] || return 1

    # Split on the LAST hyphen: a beads prefix may contain hyphens of its own,
    # since it defaults to the repo directory name.
    input_prefix="${input%%.*}"
    input_prefix="${input_prefix%-*}"
    input_prefix=$(echo "$input_prefix" | tr '[:upper:]' '[:lower:]')

    while IFS= read -r prefix; do
        [[ -n "$prefix" ]] || continue
        [[ "$prefix" == "$input_prefix" ]] && return 0
    done < <(beads_id_prefixes "$config_path" "$beads_config")

    return 1
}

# Reduce any bd JSON payload to a single issue object. Handles the envelope
# ({schema_version, data}) and the fact that bd show returns a one-element array
# rather than the bare object its schema doc describes.
beads_first_issue() {
    jq -r 'if type == "object" and has("data") then .data else . end
           | if type == "array" then (.[0] // {}) else . end'
}

# Get the VCS host provider from .pappardelle.yml
# Returns: "github" (default) or "gitlab"
get_vcs_host_provider() {
    local config_path="$1"
    local provider
    provider=$(yq -r '.vcs_host.provider // "github"' "$config_path" 2>/dev/null)
    echo "$provider"
}

# Get the Jira base URL from .pappardelle.yml
# Returns: base URL string or empty
get_jira_base_url() {
    local config_path="$1"
    yq -r '.issue_tracker.base_url // ""' "$config_path" 2>/dev/null
}

# Get the GitLab host from .pappardelle.yml
# Returns: host string or empty (defaults to gitlab.com)
get_gitlab_host() {
    local config_path="$1"
    yq -r '.vcs_host.host // ""' "$config_path" 2>/dev/null
}

# Fetch issue JSON from the configured tracker
# Args: $1=issue_key, $2=config_path
# Outputs: JSON to stdout
fetch_issue_json() {
    local issue_key="$1"
    local config_path="$2"
    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            linctl issue get "$issue_key" --json 2>/dev/null
            ;;
        jira)
            # --fields '*all' matches the TS provider: acli's default view
            # field set (assignee, description, issuetype, status, summary)
            # omits `project`, which profile matching needs (STA-1649).
            acli jira workitem view "$issue_key" --fields '*all' --json 2>/dev/null
            ;;
        beads)
            # --id= rather than a positional: beads IDs can start with a run of
            # characters the flag parser would otherwise claim.
            run_bd show --id="$issue_key" --json 2>/dev/null | beads_first_issue
            ;;
        *)
            echo "Error: Unknown issue tracker provider: $provider" >&2
            return 1
            ;;
    esac
}

# The jq expression that reads $2 out of $1's issue JSON. One table rather than
# a provider case inside each extractor: every tracker shapes the same handful
# of fields differently, so a new tracker is one block here instead of an arm in
# four functions that have to be kept in step.
#
# Empty output means the field has no meaning for that provider.
issue_field_jq() {
    case "$1:$2" in
        linear:title|beads:title)             echo '.title // empty' ;;
        jira:title)                           echo '.fields.summary // empty' ;;
        linear:description|beads:description) echo '.description // ""' ;;
        jira:description)                     echo '.fields.description // ""' ;;
        # Beads issues are local; there is no page to link to. idow already
        # skips the ISSUE_URL template var when it's empty.
        linear:url)                           echo '.url // ""' ;;
        beads:url)                            echo '""' ;;
        # Linear projects have only a name; Jira issues carry a display name AND
        # a project key ("Pappardelle Testing" / "KAN"), and a profile's
        # tracker_projects may list either (STA-1649). Beads has no project
        # field, so the ID prefix stands in for one.
        linear:project)                       echo '.project.name // empty' ;;
        jira:project)                         echo '(.fields.project.name // empty), (.fields.project.key // empty)' ;;
        beads:project)                        echo '(.id // "") | split(".")[0] | split("-") | if length > 1 then .[0:-1] | join("-") else empty end' ;;
    esac
}

# Read one field out of tracker JSON, in the configured provider's shape.
# Args: $1=json, $2=config_path, $3=field
extract_issue_field() {
    local json="$1" config_path="$2" field="$3"
    local expression
    expression=$(issue_field_jq "$(get_issue_tracker_provider "$config_path")" "$field")
    [[ -n "$expression" ]] || return 0
    echo "$json" | jq -r "$expression"
}

# Args: $1=json, $2=config_path
extract_issue_title() {
    extract_issue_field "$1" "$2" title
}

# Args: $1=json, $2=config_path
extract_issue_description() {
    extract_issue_field "$1" "$2" description
}

# Extract the issue's canonical web URL from tracker JSON.
# Linear's own `.url` is preferred over reconstructing one, so the slug matches
# the actual workspace (it was previously hardcoded to "stardust-labs", breaking
# issues in any other Linear workspace).
# Args: $1=json, $2=config_path, $3=issue_key (only used by Jira)
extract_issue_url() {
    local json="$1" config_path="$2" issue_key="$3"

    # Jira alone has no URL in its payload to read, so it is the one field that
    # cannot come from the jq table.
    if [[ "$(get_issue_tracker_provider "$config_path")" == "jira" ]]; then
        echo "$(get_jira_base_url "$config_path")/browse/$issue_key"
        return 0
    fi

    extract_issue_field "$json" "$config_path" url
}

# Extract the issue's tracker-project identifiers for profile matching.
# Emits one candidate per line, most-specific display value first. Empty output
# when the issue has no project.
# Args: $1=json, $2=config_path
extract_issue_project_candidates() {
    extract_issue_field "$1" "$2" project
}

# Resolve a profile from tracker-project candidates (newline-separated, as
# emitted by extract_issue_project_candidates). Candidates are tried in
# order; for each, the first profile whose tracker_projects contains it
# (case-insensitive) wins. Empty stdout when nothing matches.
# Args: $1=candidates, $2=config_path
match_profile_by_tracker_project() {
    local candidates="$1"
    local config_path="$2"
    local candidate profile

    while IFS= read -r candidate; do
        [[ -z "$candidate" ]] && continue
        export TRACKER_PROJECT_CANDIDATE="$candidate"
        profile=$(yq -r '
            .profiles | to_entries[] |
            select(.value.tracker_projects != null) |
            select([.value.tracker_projects[] | downcase] | any_c(. == (env(TRACKER_PROJECT_CANDIDATE) | downcase))) |
            .key' "$config_path" 2>/dev/null | head -1)
        if [[ -n "$profile" ]]; then
            echo "$profile"
            return 0
        fi
    done <<< "$candidates"
}

# Check for existing PR/MR on current branch
#
# This is the *only* PR-aware step in provisioning. Pappardelle used to open a
# zero-diff placeholder PR here so ${PR_URL} always resolved; that pushed an
# empty commit to origin on every new workspace and left the branch diverged
# from its own remote. The agent now opens the PR at its first real commit, so
# a brand-new workspace legitimately has no PR and callers must treat the empty
# string as normal (see `if_set: PR_URL` link gating). Reprovisioning an issue
# that already has a PR still resolves it through here. See STA-1866.
#
# Args: $1=config_path
# Outputs: PR/MR URL to stdout, or empty if none found
check_existing_pr() {
    local config_path="$1"
    local provider
    provider=$(get_vcs_host_provider "$config_path")

    case "$provider" in
        github)
            # Keep stderr OUT of the captured value and allowlist the URL shape.
            # The old blocklist ("no pull requests" / "Could not") let every
            # other gh failure through as if it were a PR URL — e.g. "none of
            # the git remotes ... point to a known GitHub host" landed straight
            # in ${PR_URL} and got handed to `open`. Since STA-1866 this is the
            # only PR-resolution path, so a non-URL must resolve to empty.
            local pr_output
            pr_output=$(gh pr view --json url -q ".url" 2>/dev/null) || return 0
            if [[ "$pr_output" =~ ^https?://[^[:space:]]+$ ]]; then
                echo "$pr_output"
            fi
            ;;
        gitlab)
            local branch
            branch=$(git branch --show-current)
            local gitlab_host
            gitlab_host=$(get_gitlab_host "$config_path")
            if [[ -n "$gitlab_host" ]]; then
                export GITLAB_HOST="$gitlab_host"
            fi
            local mr_url
            mr_url=$(glab mr view -F json 2>/dev/null | jq -r '.web_url // empty' 2>/dev/null) || true
            if [[ -n "$mr_url" ]]; then
                echo "$mr_url"
            fi
            ;;
    esac
}

# Create an issue in the configured tracker
# Args: --title <title> --prompt <prompt> --config <config_path> [--team <team>] [--issue-type <type>] [--profile <name>]
# Outputs: JSON with issue_key and issue_url
create_issue() {
    local title="" prompt="" config_path="" team="" issue_type="" profile=""

    while [[ $# -gt 0 ]]; do
        case $1 in
            --title) title="$2"; shift 2 ;;
            --prompt) prompt="$2"; shift 2 ;;
            --config) config_path="$2"; shift 2 ;;
            --team) team="$2"; shift 2 ;;
            --issue-type) issue_type="$2"; shift 2 ;;
            --profile) profile="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    # Read team prefix from config if not explicitly passed
    if [[ -z "$team" && -n "$config_path" ]]; then
        team=$(yq -r '.team_prefix // "STA"' "$config_path" | tr '[:lower:]' '[:upper:]')
    fi
    team="${team:-STA}"

    # Resolve Jira issue type: explicit arg → global default in config → "Task"
    if [[ -z "$issue_type" && -n "$config_path" ]]; then
        issue_type=$(yq -r '.issue_tracker.default_issue_type // ""' "$config_path")
    fi
    issue_type="${issue_type:-Task}"

    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            # Delegate to existing script
            local script_dir
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            local create_args=(--title "$title" --prompt "$prompt" --team "$team")

            # STA-959: assign the new issue to the matched profile's default
            # project (`tracker_projects[0]`). Off-by-default — when no profile
            # is passed or the profile has no tracker_projects, this block is a
            # no-op and the issue is created unassigned (pre-STA-959 behavior).
            local project_name project_uuid
            project_name=$(get_profile_default_project_name "$profile" "$config_path")
            if [[ -n "$project_name" ]]; then
                project_uuid=$(resolve_linear_project_uuid "$project_name")
                if [[ -n "$project_uuid" ]]; then
                    create_args+=(--project-uuid "$project_uuid")
                fi
            fi

            "$script_dir/create-linear-issue.sh" "${create_args[@]}"
            ;;
        jira)
            local quoted_prompt
            quoted_prompt=$(echo "$prompt" | sed 's/^/> /')
            local description="👨‍🍳🍝 More details coming soon...

---

_Original prompt:_

$quoted_prompt"
            # Convert markdown description to ADF JSON via the converter script
            local script_dir
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            local hooks_dir="$script_dir/../hooks"
            local adf_tmp
            adf_tmp=$(mktemp /tmp/pappardelle-desc-XXXXXX.json)
            if ! python3 "$hooks_dir/markdown_to_adf.py" "$description" > "$adf_tmp"; then
                echo "Error: Failed to convert description to ADF format" >&2
                rm -f "$adf_tmp"
                return 1
            fi

            local output
            output=$(acli jira workitem create --project "$team" --type "$issue_type" --summary "$title" --description-file "$adf_tmp" 2>&1)
            local exit_code=$?
            rm -f "$adf_tmp"
            if [[ $exit_code -ne 0 ]]; then
                echo "Error: Failed to create Jira issue: $output" >&2
                return 1
            fi
            # Parse issue key from acli output
            local issue_key
            issue_key=$(echo "$output" | grep -oE '[A-Z][A-Z0-9]*-[0-9]+' | head -1)
            if [[ -z "$issue_key" ]]; then
                echo "Error: Could not extract issue key from output: $output" >&2
                return 1
            fi
            local base_url
            base_url=$(get_jira_base_url "$config_path")
            local issue_url="${base_url}/browse/$issue_key"
            echo "{\"issue_key\":\"$issue_key\",\"issue_url\":\"$issue_url\"}"
            ;;
        beads)
            local quoted_prompt
            quoted_prompt=$(echo "$prompt" | sed 's/^/> /')
            local description="👨‍🍳🍝 More details coming soon...

---

_Original prompt:_

$quoted_prompt"
            # --body-file rather than -d: the prompt is arbitrary user prose and
            # can outgrow a comfortable argv entry.
            local desc_tmp
            desc_tmp=$(mktemp /tmp/pappardelle-beads-desc-XXXXXX)
            printf '%s' "$description" > "$desc_tmp"

            # The beads issue type shares issue_tracker.default_issue_type with
            # Jira, but beads spells its types lowercase and rejects "Task".
            local beads_type
            beads_type=$(echo "$issue_type" | tr '[:upper:]' '[:lower:]')

            local err_tmp out_tmp issue_key bd_rc
            err_tmp=$(mktemp /tmp/pappardelle-beads-err-XXXXXX)
            out_tmp=$(mktemp /tmp/pappardelle-beads-out-XXXXXX)
            # No project assignment: a beads issue's prefix comes from the
            # database it lands in, not from anything the caller can choose.
            run_bd create "$title" --type "$beads_type" --body-file "$desc_tmp" --json \
                >"$out_tmp" 2>"$err_tmp" && bd_rc=0 || bd_rc=$?
            rm -f "$desc_tmp"
            issue_key=$(beads_first_issue <"$out_tmp" 2>/dev/null | jq -r '.id // empty' 2>/dev/null)

            if [[ "$bd_rc" -ne 0 || -z "$issue_key" ]]; then
                # Report rc and raw stdout alongside stderr: bd can fail with a
                # silent stdout, and a bare "Failed to create" hides whether the
                # issue was actually committed.
                echo "Error: Failed to create beads issue (bd exit $bd_rc)" >&2
                echo "  stderr: $(tr '\n' ' ' <"$err_tmp")" >&2
                echo "  stdout: $(tr '\n' ' ' <"$out_tmp")" >&2
                rm -f "$err_tmp" "$out_tmp"
                return 1
            fi
            rm -f "$err_tmp" "$out_tmp"
            echo "{\"issue_key\":\"$issue_key\",\"issue_url\":\"\"}"
            ;;
    esac
}


# Get the VCS label for a profile (checks vcs.label then github.label)
# Args: $1=profile_name, $2=config_path
get_profile_vcs_label() {
    local profile="$1"
    local config_path="$2"
    local vcs_label
    vcs_label=$(yq -r ".profiles.$profile.vcs.label // .profiles.$profile.github.label // empty" "$config_path" 2>/dev/null)
    echo "$vcs_label"
}

# Get the first tracker_projects entry for a profile (the "default project" for
# new issues created under that profile). Returns the empty string if the
# profile has no tracker_projects, or no profile name was supplied.
# Args: $1=profile_name, $2=config_path
get_profile_default_project_name() {
    local profile="$1"
    local config_path="$2"
    [[ -z "$profile" || -z "$config_path" ]] && { echo ""; return 0; }
    local name
    name=$(yq -r ".profiles.$profile.tracker_projects[0] // \"\"" "$config_path" 2>/dev/null)
    # yq emits "null" (literal string) when the key is missing in some versions.
    [[ "$name" == "null" ]] && name=""
    echo "$name"
}

# Resolve a Linear project name to its UUID via `linctl project list --json`.
# Case-insensitive exact match. On no match, logs a warning to stderr and
# returns 0 with empty stdout — callers create the issue without --project,
# matching the pre-STA-959 behavior.
# Args: $1=project_name
# Stdout: project UUID, or empty on no match
resolve_linear_project_uuid() {
    local name="$1"
    [[ -z "$name" ]] && { echo ""; return 0; }
    local projects_json
    projects_json=$(linctl project list --json --include-completed 2>/dev/null) || {
        echo "Warning: \`linctl project list\` failed; creating issue without project assignment" >&2
        echo ""
        return 0
    }
    local uuid
    uuid=$(echo "$projects_json" | jq -r --arg n "$name" '
        .[] | select((.name | ascii_downcase) == ($n | ascii_downcase)) | .id
    ' | head -1)
    if [[ -z "$uuid" ]]; then
        echo "Warning: Linear project \"$name\" not found; creating issue without project assignment" >&2
    fi
    echo "$uuid"
}
