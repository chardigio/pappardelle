#!/bin/bash

# provider-helpers.sh - Shared functions for provider-agnostic issue tracking and VCS
#
# Source this file in the idow script to get provider dispatch functions.
# Reads provider config from .pappardelle.yml using yq.
#
# Requires: yq, jq, and the relevant CLI tools (linctl/acli, gh/glab)

# Get the issue tracker provider from .pappardelle.yml
# Returns: "linear" (default) or "jira"
get_issue_tracker_provider() {
    local config_path="$1"
    local provider
    provider=$(yq -r '.issue_tracker.provider // "linear"' "$config_path" 2>/dev/null)
    echo "$provider"
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
            acli jira workitem view "$issue_key" --json 2>/dev/null
            ;;
        *)
            echo "Error: Unknown issue tracker provider: $provider" >&2
            return 1
            ;;
    esac
}

# Extract issue title from tracker JSON
# Args: $1=json, $2=config_path
extract_issue_title() {
    local json="$1"
    local config_path="$2"
    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            echo "$json" | jq -r '.title // empty'
            ;;
        jira)
            echo "$json" | jq -r '.fields.summary // empty'
            ;;
    esac
}

# Extract issue description from tracker JSON
# Args: $1=json, $2=config_path
extract_issue_description() {
    local json="$1"
    local config_path="$2"
    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            echo "$json" | jq -r '.description // ""'
            ;;
        jira)
            echo "$json" | jq -r '.fields.description // ""'
            ;;
    esac
}

# Build the web URL for an issue
# Args: $1=issue_key, $2=config_path
build_issue_url() {
    local issue_key="$1"
    local config_path="$2"
    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            echo "https://linear.app/stardust-labs/issue/$issue_key"
            ;;
        jira)
            local base_url
            base_url=$(get_jira_base_url "$config_path")
            echo "${base_url}/browse/$issue_key"
            ;;
    esac
}

# Check for existing PR/MR on current branch
# Args: $1=config_path
# Outputs: PR/MR URL to stdout, or empty if none found
check_existing_pr() {
    local config_path="$1"
    local provider
    provider=$(get_vcs_host_provider "$config_path")

    case "$provider" in
        github)
            local pr_output
            pr_output=$(gh pr view --json url -q ".url" 2>&1) || true
            if [[ -n "$pr_output" && "$pr_output" != *"no pull requests"* && "$pr_output" != *"Could not"* ]]; then
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
    esac
}

# Create a PR/MR in the configured VCS host
# Args: --issue-key <key> --title <title> --worktree <path> --config <config_path> [--label <label>] [--prompt <prompt>]
# Outputs: JSON with pr_url/mr_url
create_pr() {
    local issue_key="" title="" worktree="" config_path="" label="" prompt=""

    while [[ $# -gt 0 ]]; do
        case $1 in
            --issue-key) issue_key="$2"; shift 2 ;;
            --title) title="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --config) config_path="$2"; shift 2 ;;
            --label) label="$2"; shift 2 ;;
            --prompt) prompt="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local provider
    provider=$(get_vcs_host_provider "$config_path")

    case "$provider" in
        github)
            # Delegate to existing script
            local script_dir
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            local args=(--issue-key "$issue_key" --title "$title" --worktree "$worktree")
            [[ -n "$label" ]] && args+=(--label "$label")
            [[ -n "$prompt" ]] && args+=(--prompt "$prompt")
            "$script_dir/create-github-pr.sh" "${args[@]}"
            ;;
        gitlab)
            cd "$worktree" || return 1
            local branch
            branch=$(git branch --show-current)

            local gitlab_host
            gitlab_host=$(get_gitlab_host "$config_path")
            if [[ -n "$gitlab_host" ]]; then
                export GITLAB_HOST="$gitlab_host"
            fi

            # Create empty commit for MR creation
            git commit --allow-empty -m "[$issue_key] Placeholder commit for MR creation" >&2 2>&1
            git push -u origin "$branch" >&2 2>&1 || {
                echo "Error: Failed to push branch to origin" >&2
                return 1
            }

            local mr_title="[$issue_key] $title"
            local quoted_prompt
            quoted_prompt=$(echo "$prompt" | sed 's/^/> /')
            local mr_body="👨‍🍳🍝 More details coming soon...

---

_Original prompt:_

$quoted_prompt

---
Generated with [Claude Code](https://claude.com/claude-code)"

            local mr_args=(glab mr create --title "$mr_title" --description "$mr_body" --source-branch "$branch")
            [[ -n "$label" ]] && mr_args+=(--label "$label")

            local mr_output
            mr_output=$("${mr_args[@]}" 2>&1)
            local mr_exit_code=$?

            if [[ $mr_exit_code -ne 0 ]]; then
                echo "Error: Failed to create MR: $mr_output" >&2
                return 1
            fi

            # Reset placeholder commit locally
            git reset HEAD~1 >&2 2>&1

            local mr_url
            mr_url=$(echo "$mr_output" | grep -oE 'https://[^ ]+merge_requests/[0-9]+' | head -1)
            local mr_number
            mr_number=$(echo "$mr_url" | grep -oE '[0-9]+$')

            echo "{\"pr_url\":\"$mr_url\",\"pr_number\":\"$mr_number\",\"branch\":\"$branch\"}"
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
