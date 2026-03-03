#!/bin/bash

# create-worktree.sh - Create a git worktree for an issue
#
# Usage: create-worktree.sh --issue-key <STA-XXX> --project-key <project-key>
#
# Creates a git worktree at ~/.worktrees/<repo-name>/<issue-key>
# from the repository root.
#
# Post-creation setup (file copying, env overrides, dependency installation)
# is handled by `post_worktree_init` commands in .pappardelle.yml, executed by idow.
#
# Outputs: JSON with worktree_path and issue_key
# Exit code: 0 on success, 1 on failure

set -e

# Configuration (overridable via env vars for testing)
MAIN_REPO="${MAIN_REPO:-${PAPPARDELLE_PROJECT_ROOT:-$(git rev-parse --show-toplevel)}}"
WORKTREES_ROOT="${WORKTREES_ROOT:-$HOME/.worktrees}"

# Parse arguments
ISSUE_KEY=""
PROJECT_KEY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue-key)
            ISSUE_KEY="$2"
            shift 2
            ;;
        --project-key)
            PROJECT_KEY="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: create-worktree.sh --issue-key <STA-XXX> --project-key <project-key>"
            echo ""
            echo "Creates a git worktree at ~/.worktrees/<repo-name>/<issue-key>"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE_KEY" ]]; then
    echo "Error: --issue-key is required" >&2
    exit 1
fi

if [[ -z "$PROJECT_KEY" ]]; then
    echo "Error: --project-key is required" >&2
    exit 1
fi

# Build worktree path using repository name (not project key)
REPO_NAME=$(basename "$MAIN_REPO")
WORKTREE_PATH="$WORKTREES_ROOT/$REPO_NAME/$ISSUE_KEY"

# Create parent directory if needed
mkdir -p "$(dirname "$WORKTREE_PATH")"

log() {
    echo "[create-worktree] $*" >&2
}

# Remove stale .git/index.lock left behind by crashed git processes.
# Must run before any git operations (stash, fetch, checkout, pull).
# Uses git rev-parse to resolve the correct .git directory, which works
# both in normal repos (.git is a directory) and worktrees (.git is a file).
remove_stale_index_lock() {
    local git_common_dir
    git_common_dir=$(git -C "$MAIN_REPO" rev-parse --git-common-dir 2>/dev/null) || return
    local lock_file="$git_common_dir/index.lock"
    if [[ -f "$lock_file" ]]; then
        # Only skip removal if a git process is actively holding the lock.
        # Plain `lsof FILE` matches ANY process (including macOS Spotlight/mds),
        # causing false positives. Filter to git commands only.
        if command -v lsof >/dev/null 2>&1 && lsof "$lock_file" 2>/dev/null | awk 'NR>1{print $1}' | grep -qi '^git'; then
            log "WARNING: index.lock is held by a running git process, skipping removal"
            return
        fi
        log "Removing stale index.lock at $lock_file..."
        rm -f "$lock_file"
    fi
}

# Check if there are uncommitted changes in the main repo
has_uncommitted_changes() {
    cd "$MAIN_REPO"
    # Check for staged or unstaged changes (untracked files don't block checkout/pull)
    ! git diff --quiet --exit-code 2>/dev/null || \
    ! git diff --quiet --cached --exit-code 2>/dev/null
}

# Create worktree if it doesn't exist
if [[ ! -d "$WORKTREE_PATH" ]]; then
    log "Creating worktree at $WORKTREE_PATH"
    cd "$MAIN_REPO"

    # Clean up any stale index.lock before running git operations
    remove_stale_index_lock

    # Stash uncommitted changes if present to avoid checkout/pull failures
    if has_uncommitted_changes; then
        log "Stashing uncommitted changes in main repo (use 'git stash pop' to restore)..."
        if ! git stash push -m "auto-stash for worktree creation ($ISSUE_KEY)" --quiet >&2 2>&1; then
            echo "Error: git stash failed" >&2
            exit 1
        fi
    fi

    # Detect default branch (main or master)
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
    if [[ -z "$DEFAULT_BRANCH" ]]; then
        # Fallback: check which branch exists on remote
        if git show-ref --verify --quiet refs/remotes/origin/main 2>/dev/null; then
            DEFAULT_BRANCH="main"
        else
            DEFAULT_BRANCH="master"
        fi
    fi

    # Pull latest default branch from origin to ensure we branch from up-to-date code
    log "Pulling latest $DEFAULT_BRANCH..."
    git fetch origin "$DEFAULT_BRANCH" --quiet >&2 2>&1
    git checkout "$DEFAULT_BRANCH" --quiet >&2 2>&1
    git pull origin "$DEFAULT_BRANCH" --quiet >&2 2>&1

    # Create worktree — reuse existing branch or create a new one
    if git show-ref --verify --quiet "refs/heads/$ISSUE_KEY"; then
        log "Branch $ISSUE_KEY already exists, reusing it"
        git worktree add "$WORKTREE_PATH" "$ISSUE_KEY" >&2 2>&1
    else
        log "Preparing worktree (new branch '$ISSUE_KEY')"
        git worktree add "$WORKTREE_PATH" -b "$ISSUE_KEY" "origin/$DEFAULT_BRANCH" >&2 2>&1
    fi
    log "Worktree created with branch $ISSUE_KEY"
else
    log "Worktree already exists at $WORKTREE_PATH"
fi

# Output JSON
echo "{\"worktree_path\":\"$WORKTREE_PATH\",\"issue_key\":\"$ISSUE_KEY\"}"
