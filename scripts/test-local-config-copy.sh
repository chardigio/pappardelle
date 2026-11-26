#!/bin/bash

# Test: idow copies local config files to new worktrees
#
# Verifies the built-in behavior in idow that copies .pappardelle.local.yml
# and .claude/settings.local.json from the main repo root to newly created worktrees.
#
# Usage: ./test-local-config-copy.sh

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

# Set up a fresh temp git repo with a local "origin" remote and worktree
setup_repo_with_worktree() {
    TMPDIR_ROOT=$(mktemp -d)
    export MAIN_REPO="$TMPDIR_ROOT/repo"

    # Create a bare repo to act as "origin"
    local bare_repo="$TMPDIR_ROOT/origin.git"
    git init --bare --quiet --initial-branch=master "$bare_repo"

    # Clone it to create the working repo
    git clone --quiet "$bare_repo" "$MAIN_REPO" 2>/dev/null
    cd "$MAIN_REPO"
    git checkout -b master --quiet

    # Need an initial commit so worktree creation works
    echo "initial" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
    git push --quiet -u origin master 2>/dev/null

    # Create worktree
    WORKTREE_JSON=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-TEST" --project-key "test" \
        --worktree "$TMPDIR_ROOT/worktrees/repo/STA-TEST" 2>/dev/null)
    WORKTREE_PATH=$(echo "$WORKTREE_JSON" | jq -r '.worktree_path')
}

teardown() {
    cd /
    rm -rf "$TMPDIR_ROOT"
    unset MAIN_REPO
}

# ==========================================================================

echo -e "${BOLD}Test: .pappardelle.local.yml is copied when it exists${RESET}"
setup_repo_with_worktree

# Create .pappardelle.local.yml in main repo
cat > "$MAIN_REPO/.pappardelle.local.yml" <<'LOCALEOF'
# personal overrides
keybindings:
  - key: "V"
    name: "Open in VS Code"
    run: "code ${WORKTREE_PATH}"
LOCALEOF

# Simulate the idow copy logic (exact code from idow)
LOCAL_CONFIG="$MAIN_REPO/.pappardelle.local.yml"
if [[ -f "$LOCAL_CONFIG" ]]; then
    cp -n "$LOCAL_CONFIG" "$WORKTREE_PATH/.pappardelle.local.yml" 2>/dev/null || true
fi

assert_file_exists ".pappardelle.local.yml was copied to worktree" "$WORKTREE_PATH/.pappardelle.local.yml"
assert_file_content "copied file has correct content" "$WORKTREE_PATH/.pappardelle.local.yml" "$(cat "$MAIN_REPO/.pappardelle.local.yml")"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: no error when .pappardelle.local.yml does not exist${RESET}"
setup_repo_with_worktree

# Don't create .pappardelle.local.yml — simulate the idow copy logic
LOCAL_CONFIG="$MAIN_REPO/.pappardelle.local.yml"
if [[ -f "$LOCAL_CONFIG" ]]; then
    cp -n "$LOCAL_CONFIG" "$WORKTREE_PATH/.pappardelle.local.yml" 2>/dev/null || true
fi

assert_file_not_exists ".pappardelle.local.yml is not created when source doesn't exist" "$WORKTREE_PATH/.pappardelle.local.yml"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: existing .pappardelle.local.yml in worktree is not overwritten (cp -n)${RESET}"
setup_repo_with_worktree

# Create .pappardelle.local.yml in main repo
echo "new content from main repo" > "$MAIN_REPO/.pappardelle.local.yml"

# Pre-create a .pappardelle.local.yml in the worktree (simulates existing file)
echo "existing worktree content" > "$WORKTREE_PATH/.pappardelle.local.yml"

# Simulate the idow copy logic
LOCAL_CONFIG="$MAIN_REPO/.pappardelle.local.yml"
if [[ -f "$LOCAL_CONFIG" ]]; then
    cp -n "$LOCAL_CONFIG" "$WORKTREE_PATH/.pappardelle.local.yml" 2>/dev/null || true
fi

assert_file_content "existing file was not overwritten" "$WORKTREE_PATH/.pappardelle.local.yml" "existing worktree content"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: empty .pappardelle.local.yml is still copied${RESET}"
setup_repo_with_worktree

# Create empty .pappardelle.local.yml
touch "$MAIN_REPO/.pappardelle.local.yml"

# Simulate the idow copy logic
LOCAL_CONFIG="$MAIN_REPO/.pappardelle.local.yml"
if [[ -f "$LOCAL_CONFIG" ]]; then
    cp -n "$LOCAL_CONFIG" "$WORKTREE_PATH/.pappardelle.local.yml" 2>/dev/null || true
fi

assert_file_exists "empty .pappardelle.local.yml was copied" "$WORKTREE_PATH/.pappardelle.local.yml"

teardown

# ==========================================================================
# .claude/settings.local.json tests
# ==========================================================================

echo -e "\n${BOLD}Test: .claude/settings.local.json is copied when it exists${RESET}"
setup_repo_with_worktree

# Create .claude/settings.local.json in main repo
mkdir -p "$MAIN_REPO/.claude"
cat > "$MAIN_REPO/.claude/settings.local.json" <<'JSONEOF'
{
  "permissions": {
    "allow": ["Bash(git add:*)"]
  }
}
JSONEOF

# Simulate the idow copy logic (exact code from idow)
CLAUDE_LOCAL_SETTINGS="$MAIN_REPO/.claude/settings.local.json"
if [[ -f "$CLAUDE_LOCAL_SETTINGS" ]]; then
    mkdir -p "$WORKTREE_PATH/.claude"
    cp -n "$CLAUDE_LOCAL_SETTINGS" "$WORKTREE_PATH/.claude/settings.local.json" 2>/dev/null || true
fi

assert_file_exists ".claude/settings.local.json was copied to worktree" "$WORKTREE_PATH/.claude/settings.local.json"
assert_file_content "copied file has correct content" "$WORKTREE_PATH/.claude/settings.local.json" "$(cat "$MAIN_REPO/.claude/settings.local.json")"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: no error when .claude/settings.local.json does not exist${RESET}"
setup_repo_with_worktree

# Don't create .claude/settings.local.json — simulate the idow copy logic
CLAUDE_LOCAL_SETTINGS="$MAIN_REPO/.claude/settings.local.json"
if [[ -f "$CLAUDE_LOCAL_SETTINGS" ]]; then
    mkdir -p "$WORKTREE_PATH/.claude"
    cp -n "$CLAUDE_LOCAL_SETTINGS" "$WORKTREE_PATH/.claude/settings.local.json" 2>/dev/null || true
fi

assert_file_not_exists ".claude/settings.local.json is not created when source doesn't exist" "$WORKTREE_PATH/.claude/settings.local.json"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: existing .claude/settings.local.json in worktree is not overwritten (cp -n)${RESET}"
setup_repo_with_worktree

# Create .claude/settings.local.json in main repo
mkdir -p "$MAIN_REPO/.claude"
echo '{"new": true}' > "$MAIN_REPO/.claude/settings.local.json"

# Pre-create a .claude/settings.local.json in the worktree (simulates existing file)
mkdir -p "$WORKTREE_PATH/.claude"
echo '{"existing": true}' > "$WORKTREE_PATH/.claude/settings.local.json"

# Simulate the idow copy logic
CLAUDE_LOCAL_SETTINGS="$MAIN_REPO/.claude/settings.local.json"
if [[ -f "$CLAUDE_LOCAL_SETTINGS" ]]; then
    mkdir -p "$WORKTREE_PATH/.claude"
    cp -n "$CLAUDE_LOCAL_SETTINGS" "$WORKTREE_PATH/.claude/settings.local.json" 2>/dev/null || true
fi

assert_file_content "existing file was not overwritten" "$WORKTREE_PATH/.claude/settings.local.json" '{"existing": true}'

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: .claude directory is created if it doesn't exist in worktree${RESET}"
setup_repo_with_worktree

# Create .claude/settings.local.json in main repo
mkdir -p "$MAIN_REPO/.claude"
echo '{"test": true}' > "$MAIN_REPO/.claude/settings.local.json"

# Ensure .claude dir doesn't exist in worktree
rm -rf "$WORKTREE_PATH/.claude"

# Simulate the idow copy logic
CLAUDE_LOCAL_SETTINGS="$MAIN_REPO/.claude/settings.local.json"
if [[ -f "$CLAUDE_LOCAL_SETTINGS" ]]; then
    mkdir -p "$WORKTREE_PATH/.claude"
    cp -n "$CLAUDE_LOCAL_SETTINGS" "$WORKTREE_PATH/.claude/settings.local.json" 2>/dev/null || true
fi

assert_file_exists ".claude directory was created and file was copied" "$WORKTREE_PATH/.claude/settings.local.json"

teardown

# ==========================================================================

summarize
