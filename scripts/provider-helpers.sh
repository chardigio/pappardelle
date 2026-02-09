#!/bin/bash

# provider-helpers.sh - Shared functions for provider-agnostic issue tracking and VCS
#
# Source this file in dow/idow scripts to get provider dispatch functions.
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
            mr_url=$(glab mr view --json web_url -q ".web_url" 2>&1) || true
            if [[ -n "$mr_url" && "$mr_url" != *"no open merge request"* ]]; then
                echo "$mr_url"
            fi
            ;;
    esac
}

# Create an issue in the configured tracker
# Args: --title <title> --prompt <prompt> --config <config_path> [--team <team>]
# Outputs: JSON with issue_key and issue_url
create_issue() {
    local title="" prompt="" config_path="" team="STA"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --title) title="$2"; shift 2 ;;
            --prompt) prompt="$2"; shift 2 ;;
            --config) config_path="$2"; shift 2 ;;
            --team) team="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    local provider
    provider=$(get_issue_tracker_provider "$config_path")

    case "$provider" in
        linear)
            # Delegate to existing script
            local script_dir
            script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            "$script_dir/create-linear-issue.sh" --title "$title" --prompt "$prompt"
            ;;
        jira)
            local quoted_prompt
            quoted_prompt=$(echo "$prompt" | sed 's/^/> /')
            local description="More details coming soon.

---

_Original prompt:_

$quoted_prompt"
            local output
            output=$(acli jira workitem create --project "$team" --type Task --summary "$title" --description "$description" 2>&1)
            local exit_code=$?
            if [[ $exit_code -ne 0 ]]; then
                echo "Error: Failed to create Jira issue: $output" >&2
                return 1
            fi
            # Parse issue key from acli output
            local issue_key
            issue_key=$(echo "$output" | grep -oE '[A-Z]+-[0-9]+' | head -1)
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
            local mr_body="## Summary
Work in progress - more details coming soon.

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
