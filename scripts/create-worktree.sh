#!/bin/bash

# create-worktree.sh - Create a git worktree for an issue
#
# Usage: create-worktree.sh --issue-key <STA-XXX> --project-key <project-key>
#
# Creates a git worktree at ~/.worktrees/<project-key>/<issue-key>
# from the stardust-labs main repository.
#
# Also:
#   - Copies .env from main repo if it doesn't exist
#   - Runs uv sync if .venv is missing/broken
#   - Sets up unique port for the worktree
#
# Outputs: JSON with worktree_path
# Exit code: 0 on success, 1 on failure

set -e

# Configuration (overridable via env vars for testing)
MAIN_REPO="${MAIN_REPO:-$HOME/cs/stardust-labs}"
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
            echo "Creates a git worktree at ~/.worktrees/<project-key>/<issue-key>"
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

# Extract issue number for port assignment
ISSUE_NUMBER=$(echo "$ISSUE_KEY" | grep -oE '[0-9]+')

log() {
    echo "[create-worktree] $*" >&2
}

# Check if there are uncommitted changes in the main repo
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

    # Stash uncommitted changes if present to avoid checkout/pull failures
    if has_uncommitted_changes; then
        log "Stashing uncommitted changes in main repo (use 'git stash pop' to restore)..."
        git stash push -m "auto-stash for worktree creation ($ISSUE_KEY)" --quiet >&2 2>&1
    fi

    # Pull latest master from origin to ensure we branch from up-to-date code
    log "Pulling latest master..."
    git fetch origin master --quiet >&2 2>&1
    git checkout master --quiet >&2 2>&1
    git pull origin master --quiet >&2 2>&1

    # Create worktree with new branch (redirect all output to stderr)
    git worktree add "$WORKTREE_PATH" -b "$ISSUE_KEY" origin/master >&2 2>&1
    log "Worktree created with branch $ISSUE_KEY"
else
    log "Worktree already exists at $WORKTREE_PATH"
fi

# Copy .env if it doesn't exist
if [[ ! -f "$WORKTREE_PATH/.env" ]] && [[ -f "$MAIN_REPO/.env" ]]; then
    log "Copying .env from main repo"
    cp "$MAIN_REPO/.env" "$WORKTREE_PATH/.env"
fi

# Set unique port for this worktree (e.g., 5323 for STA-323)
WORKTREE_PORT="5$ISSUE_NUMBER"
if [[ -f "$WORKTREE_PATH/.env" ]]; then
    if grep -q "^PORT=" "$WORKTREE_PATH/.env"; then
        sed -i '' "s/^PORT=.*/PORT=$WORKTREE_PORT/" "$WORKTREE_PATH/.env"
    else
        echo "PORT=$WORKTREE_PORT" >> "$WORKTREE_PATH/.env"
    fi
    log "Set PORT=$WORKTREE_PORT in .env"
fi

# Run uv sync if .venv doesn't exist or is broken
VENV_PYTHON="$WORKTREE_PATH/.venv/bin/python"
if [[ ! -f "$VENV_PYTHON" ]] || [[ ! -s "$VENV_PYTHON" ]] || ! "$VENV_PYTHON" --version >/dev/null 2>&1; then
    log "Running uv sync (venv missing or broken)"
    rm -rf "$WORKTREE_PATH/.venv"
    (cd "$WORKTREE_PATH" && uv sync --quiet >/dev/null 2>&1) || log "Warning: uv sync failed (non-critical)"
else
    log "Venv exists and works, skipping uv sync"
fi

# Output JSON
echo "{\"worktree_path\":\"$WORKTREE_PATH\",\"issue_key\":\"$ISSUE_KEY\",\"port\":\"$WORKTREE_PORT\"}"
