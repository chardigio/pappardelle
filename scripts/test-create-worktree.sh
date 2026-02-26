#!/bin/bash

# Test: create-worktree.sh outputs valid JSON and handles uncommitted changes
#
# Verifies that uncommitted changes are stashed (not popped back) during
# worktree creation, keeping master clean after pulling latest.
#
# Usage: ./test-create-worktree.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

# Colors
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

assert_valid_json() {
    local test_name="$1"
    local output="$2"

    if echo "$output" | jq empty 2>/dev/null; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Output was not valid JSON:"
        echo "    ---"
        echo "    $output"
        echo "    ---"
        FAIL=$((FAIL + 1))
    fi
}

assert_json_field() {
    local test_name="$1"
    local output="$2"
    local field="$3"
    local expected="$4"

    local actual
    actual=$(echo "$output" | jq -r ".$field" 2>/dev/null)
    if [[ "$actual" == "$expected" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected .$field = \"$expected\", got \"$actual\""
        FAIL=$((FAIL + 1))
    fi
}

assert_single_line() {
    local test_name="$1"
    local output="$2"

    local line_count
    line_count=$(echo "$output" | wc -l | tr -d ' ')
    if [[ "$line_count" -eq 1 ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected 1 line, got $line_count:"
        echo "    ---"
        echo "    $output"
        echo "    ---"
        FAIL=$((FAIL + 1))
    fi
}

# Set up a fresh temp git repo with a local "origin" remote
setup_repo() {
    TMPDIR_ROOT=$(mktemp -d)
    export MAIN_REPO="$TMPDIR_ROOT/repo"
    export WORKTREES_ROOT="$TMPDIR_ROOT/worktrees"

    # Create a bare repo to act as "origin" (must use master as default branch
    # since create-worktree.sh does `git fetch/pull origin master`)
    local bare_repo="$TMPDIR_ROOT/origin.git"
    git init --bare --quiet --initial-branch=master "$bare_repo"

    # Clone it to create the working repo (gives us a proper origin remote)
    git clone --quiet "$bare_repo" "$MAIN_REPO" 2>/dev/null
    cd "$MAIN_REPO"
    git checkout -b master --quiet

    # Need an initial commit so worktree creation works
    echo "initial" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
    git push --quiet -u origin master 2>/dev/null
}

teardown_repo() {
    cd /
    rm -rf "$TMPDIR_ROOT"
    unset MAIN_REPO WORKTREES_ROOT
}

# ==========================================================================

echo -e "${BOLD}Test: create-worktree with clean repo${RESET}"
setup_repo

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-100" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-100"
assert_json_field "port is derived from issue number" "$OUTPUT" "port" "5100"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with uncommitted changes (stash without pop)${RESET}"
setup_repo

# Create uncommitted changes that will trigger the stash logic
echo "dirty" > "$MAIN_REPO/README.md"

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-200" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON despite stash" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-200"

# Verify changes stayed stashed (master should be clean, stash should exist)
cd "$MAIN_REPO"
STASH_COUNT=$(git stash list | wc -l | tr -d ' ')
if [[ "$STASH_COUNT" -ge 1 ]]; then
    echo -e "  ${GREEN}PASS${RESET} stashed changes remain in stash"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} stashed changes remain in stash"
    echo "    Expected stash to have entries, but it was empty"
    FAIL=$((FAIL + 1))
fi

if git diff --quiet --exit-code 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} master is clean after worktree creation"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} master is clean after worktree creation"
    echo "    Expected clean working tree, but found uncommitted changes"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with staged changes${RESET}"
setup_repo

# Stage a change (triggers has_uncommitted_changes via git diff --cached)
echo "staged content" > "$MAIN_REPO/newfile.txt"
cd "$MAIN_REPO" && git add newfile.txt

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-300" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON despite staged changes" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with conflicting remote changes (stash preserved)${RESET}"
setup_repo

# Push a file to origin, then create a LOCAL change AND a conflicting REMOTE
# change. The stash should be preserved (not popped) so no conflict occurs.
cd "$MAIN_REPO"
echo "original" > conflict.txt
git add conflict.txt
git commit -m "add conflict.txt" --quiet
git push --quiet origin master 2>/dev/null

# Simulate a remote change by pushing from a second clone
second_clone="$TMPDIR_ROOT/second-clone"
git clone --quiet "$TMPDIR_ROOT/origin.git" "$second_clone" 2>/dev/null
cd "$second_clone"
echo "remote change" > conflict.txt
git add conflict.txt
git commit -m "remote change" --quiet
git push --quiet origin master 2>/dev/null

# Make a local change to the same file
cd "$MAIN_REPO"
echo "local change" > conflict.txt

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-350" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-350"

# Master should be clean (stash not popped, so no conflict)
cd "$MAIN_REPO"
if git diff --quiet --exit-code 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} master is clean (no conflicting stash pop)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} master is clean (no conflicting stash pop)"
    echo "    Expected clean working tree after stash was preserved"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with multiple dirty files${RESET}"
setup_repo

# Create several dirty files to make stash pop more verbose
for i in $(seq 1 5); do
    echo "file $i" > "$MAIN_REPO/file$i.txt"
    cd "$MAIN_REPO" && git add "file$i.txt"
done
git commit -m "add files" --quiet
for i in $(seq 1 5); do
    echo "modified $i" > "$MAIN_REPO/file$i.txt"
done

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-400" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON with many dirty files" "$OUTPUT"
assert_single_line "stdout is a single line with many dirty files" "$OUTPUT"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with main-based repo (not master)${RESET}"

# Set up a repo that uses 'main' instead of 'master'
TMPDIR_ROOT=$(mktemp -d)
export MAIN_REPO="$TMPDIR_ROOT/repo"
export WORKTREES_ROOT="$TMPDIR_ROOT/worktrees"

bare_repo="$TMPDIR_ROOT/origin.git"
git init --bare --quiet --initial-branch=main "$bare_repo"
git clone --quiet "$bare_repo" "$MAIN_REPO" 2>/dev/null
cd "$MAIN_REPO"
git checkout -b main --quiet
echo "initial" > README.md
git add README.md
git commit -m "initial commit" --quiet
git push --quiet -u origin main 2>/dev/null

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "CHEX-100" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON (main-based repo)" "$OUTPUT"
assert_single_line "stdout is a single line (main-based repo)" "$OUTPUT"
assert_json_field "issue_key is correct (main-based repo)" "$OUTPUT" "issue_key" "CHEX-100"

# Verify worktree was created
EXPECTED_PATH="$WORKTREES_ROOT/repo/CHEX-100"
if [[ -d "$EXPECTED_PATH" ]]; then
    echo -e "  ${GREEN}PASS${RESET} worktree directory exists"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} worktree directory exists"
    echo "    Expected: $EXPECTED_PATH"
    FAIL=$((FAIL + 1))
fi

cd /
rm -rf "$TMPDIR_ROOT"
unset MAIN_REPO WORKTREES_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree when branch already exists (no worktree dir)${RESET}"
setup_repo

# Create a branch, then delete the worktree dir but leave the branch behind.
# This simulates a previous worktree that was cleaned up incompletely.
cd "$MAIN_REPO"
git branch "STA-500" master --quiet
# Verify the branch exists
if git show-ref --verify --quiet "refs/heads/STA-500"; then
    echo -e "  ${GREEN}PASS${RESET} precondition: branch STA-500 exists"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} precondition: branch STA-500 exists"
    FAIL=$((FAIL + 1))
fi

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-500" --project-key "test" 2>/dev/null)
EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${RESET} exits 0 when branch already exists"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} exits 0 when branch already exists (got exit $EXIT_CODE)"
    FAIL=$((FAIL + 1))
fi

assert_valid_json "stdout is valid JSON (existing branch)" "$OUTPUT"
assert_single_line "stdout is a single line (existing branch)" "$OUTPUT"
assert_json_field "issue_key is correct (existing branch)" "$OUTPUT" "issue_key" "STA-500"

# Verify worktree was actually created
EXPECTED_PATH="$WORKTREES_ROOT/repo/STA-500"
if [[ -d "$EXPECTED_PATH" ]]; then
    echo -e "  ${GREEN}PASS${RESET} worktree directory exists (existing branch)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} worktree directory exists (existing branch)"
    echo "    Expected: $EXPECTED_PATH"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with stale index.lock${RESET}"
setup_repo

# Simulate a stale index.lock (crashed git process)
touch "$MAIN_REPO/.git/index.lock"

# Create uncommitted changes that trigger stash path
echo "dirty" > "$MAIN_REPO/README.md"

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-600" --project-key "test" 2>/dev/null)
EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${RESET} succeeds despite stale index.lock"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} succeeds despite stale index.lock (got exit $EXIT_CODE)"
    FAIL=$((FAIL + 1))
fi

assert_valid_json "stdout is valid JSON (stale index.lock)" "$OUTPUT"
assert_json_field "issue_key is correct (stale index.lock)" "$OUTPUT" "issue_key" "STA-600"

# Verify the lock file was cleaned up
if [[ ! -f "$MAIN_REPO/.git/index.lock" ]]; then
    echo -e "  ${GREEN}PASS${RESET} stale index.lock was removed"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} stale index.lock was removed"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with stale index.lock and CLEAN repo (no stash path)${RESET}"
setup_repo

# Simulate a stale index.lock but repo is clean — stash path is skipped,
# so the lock blocks git fetch/checkout/pull directly.
touch "$MAIN_REPO/.git/index.lock"

EXIT_CODE=0
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-700" --project-key "test" 2>/dev/null) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${RESET} succeeds despite stale index.lock on clean repo"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} succeeds despite stale index.lock on clean repo (got exit $EXIT_CODE)"
    FAIL=$((FAIL + 1))
fi

assert_valid_json "stdout is valid JSON (index.lock, clean repo)" "$OUTPUT"
assert_json_field "issue_key is correct (index.lock, clean repo)" "$OUTPUT" "issue_key" "STA-700"

# Verify the lock file was cleaned up
if [[ ! -f "$MAIN_REPO/.git/index.lock" ]]; then
    echo -e "  ${GREEN}PASS${RESET} stale index.lock was removed (clean repo)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} stale index.lock was removed (clean repo)"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: index.lock resolved via git-common-dir when MAIN_REPO is a worktree${RESET}"
setup_repo

# Create a worktree from the test repo, then use it as MAIN_REPO.
# In a worktree, .git is a file (not a directory), so the old code path
# "$MAIN_REPO/.git/index.lock" would never find the lock. The fix uses
# git rev-parse --git-common-dir to resolve the actual .git directory.
WORKTREE_EXTRA="$TMPDIR_ROOT/worktree-extra"
git -C "$MAIN_REPO" worktree add "$WORKTREE_EXTRA" -b extra-branch master --quiet 2>/dev/null

# Place a stale index.lock in the actual git common dir
touch "$MAIN_REPO/.git/index.lock"

# Verify precondition: .git in worktree is a file, not a directory
if [[ -f "$WORKTREE_EXTRA/.git" && ! -d "$WORKTREE_EXTRA/.git" ]]; then
    echo -e "  ${GREEN}PASS${RESET} precondition: .git in worktree is a file"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} precondition: .git in worktree is a file"
    FAIL=$((FAIL + 1))
fi

# Run create-worktree with MAIN_REPO pointing to the worktree.
# The script will fail at git checkout (can't checkout a branch that's
# checked out in another worktree), but the lock removal happens BEFORE
# the checkout, so we can still verify it was cleaned up.
MAIN_REPO="$WORKTREE_EXTRA" "$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-800" --project-key "test" 2>/dev/null || true

# Verify the lock file was cleaned up from the actual git common dir
if [[ ! -f "$MAIN_REPO/.git/index.lock" ]]; then
    echo -e "  ${GREEN}PASS${RESET} stale index.lock removed via git-common-dir resolution"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} stale index.lock removed via git-common-dir resolution"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
