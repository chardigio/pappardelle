#!/bin/bash

# Test: create-worktree.sh outputs valid JSON and never mutates the main repo.
#
# `git worktree add <path> -b <branch> origin/<default>` does not require the
# main repo to be on the default branch or to have a clean working tree.
# These tests pin that property: after worktree creation the main repo's
# HEAD, branch, working tree, and stash list must be identical to before.
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

assert_eq() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"

    if [[ "$expected" == "$actual" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected: $expected"
        echo "    Got:      $actual"
        FAIL=$((FAIL + 1))
    fi
}

# Snapshot the main repo's state so we can prove it wasn't mutated.
snapshot_main_repo() {
    cd "$MAIN_REPO"
    SNAPSHOT_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
    SNAPSHOT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
    SNAPSHOT_DIFF=$(git diff 2>/dev/null)
    SNAPSHOT_DIFF_CACHED=$(git diff --cached 2>/dev/null)
    SNAPSHOT_STATUS=$(git status --porcelain 2>/dev/null)
    SNAPSHOT_STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
}

# Verify the main repo matches the prior snapshot — create-worktree.sh
# must not checkout, pull, or stash.
assert_main_repo_unchanged() {
    local prefix="$1"
    cd "$MAIN_REPO"

    assert_eq "$prefix: HEAD unchanged" "$SNAPSHOT_HEAD" "$(git rev-parse HEAD 2>/dev/null || echo "")"
    assert_eq "$prefix: branch unchanged" "$SNAPSHOT_BRANCH" "$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"
    assert_eq "$prefix: unstaged diff unchanged" "$SNAPSHOT_DIFF" "$(git diff 2>/dev/null)"
    assert_eq "$prefix: staged diff unchanged" "$SNAPSHOT_DIFF_CACHED" "$(git diff --cached 2>/dev/null)"
    assert_eq "$prefix: status unchanged" "$SNAPSHOT_STATUS" "$(git status --porcelain 2>/dev/null)"
    assert_eq "$prefix: stash count unchanged" "$SNAPSHOT_STASH_COUNT" "$(git stash list 2>/dev/null | wc -l | tr -d ' ')"
}

assert_no_auto_stash() {
    local test_name="$1"
    cd "$MAIN_REPO"
    local count
    count=$(git stash list 2>/dev/null | grep -c "auto-stash for worktree creation" || true)
    if [[ "$count" -eq 0 ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Found $count auto-stash entries — main repo should never be stashed"
        FAIL=$((FAIL + 1))
    fi
}

# Set up a fresh temp git repo with a local "origin" remote
setup_repo() {
    TMPDIR_ROOT=$(mktemp -d)
    export MAIN_REPO="$TMPDIR_ROOT/repo"
    export WORKTREES_ROOT="$TMPDIR_ROOT/worktrees"

    local bare_repo="$TMPDIR_ROOT/origin.git"
    git init --bare --quiet --initial-branch=master "$bare_repo"

    git clone --quiet "$bare_repo" "$MAIN_REPO" 2>/dev/null
    cd "$MAIN_REPO"
    git checkout -b master --quiet

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

echo -e "${BOLD}Test: create-worktree with clean repo (main repo untouched)${RESET}"
setup_repo

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-100" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-100"
assert_main_repo_unchanged "clean repo"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with uncommitted changes (no auto-stash, no checkout)${RESET}"
setup_repo

# Dirty the working tree — old behavior would stash this and switch to master.
echo "dirty" > "$MAIN_REPO/README.md"

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-200" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON despite dirty repo" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-200"
assert_no_auto_stash "no auto-stash entry was created"
assert_main_repo_unchanged "dirty repo"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with staged changes (staging preserved)${RESET}"
setup_repo

echo "staged content" > "$MAIN_REPO/newfile.txt"
cd "$MAIN_REPO" && git add newfile.txt

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-300" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON despite staged changes" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_no_auto_stash "staged changes were not auto-stashed"
assert_main_repo_unchanged "staged changes"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: main repo on a feature branch is preserved (not switched to master)${RESET}"
setup_repo

# Previously create-worktree.sh would silently `git checkout master`,
# dragging the user off their feature branch.
cd "$MAIN_REPO"
git checkout -b feature/preexisting --quiet
echo "feature work" > feature.txt
git add feature.txt
git commit -m "feature work" --quiet

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-350" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_main_repo_unchanged "feature branch"

# Explicit check: still on feature/preexisting, never moved to master.
cd "$MAIN_REPO"
ACTUAL_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
assert_eq "main repo is still on feature/preexisting" "feature/preexisting" "$ACTUAL_BRANCH"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: dirty local + divergent remote (no implicit pull, no conflict)${RESET}"
setup_repo

cd "$MAIN_REPO"
echo "original" > conflict.txt
git add conflict.txt
git commit -m "add conflict.txt" --quiet
git push --quiet origin master 2>/dev/null

# Diverge the remote via a second clone.
second_clone="$TMPDIR_ROOT/second-clone"
git clone --quiet "$TMPDIR_ROOT/origin.git" "$second_clone" 2>/dev/null
cd "$second_clone"
echo "remote change" > conflict.txt
git add conflict.txt
git commit -m "remote change" --quiet
git push --quiet origin master 2>/dev/null

# Dirty the local working tree on the same file the remote diverged on.
cd "$MAIN_REPO"
echo "local change" > conflict.txt

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-400" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON" "$OUTPUT"
assert_single_line "stdout is a single line" "$OUTPUT"
assert_json_field "issue_key is correct" "$OUTPUT" "issue_key" "STA-400"
assert_no_auto_stash "no auto-stash created on conflicting state"
assert_main_repo_unchanged "dirty + divergent remote"

# The new worktree should reflect the latest origin/master, not the stale
# main-repo HEAD — proves we still fetch origin even though we don't pull.
WORKTREE_PATH="$WORKTREES_ROOT/repo/STA-400"
ACTUAL_CONTENT=$(cat "$WORKTREE_PATH/conflict.txt")
assert_eq "worktree branches from latest origin/master" "remote change" "$ACTUAL_CONTENT"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with multiple dirty files (all preserved untouched)${RESET}"
setup_repo

for i in $(seq 1 5); do
    echo "file $i" > "$MAIN_REPO/file$i.txt"
    cd "$MAIN_REPO" && git add "file$i.txt"
done
git commit -m "add files" --quiet
for i in $(seq 1 5); do
    echo "modified $i" > "$MAIN_REPO/file$i.txt"
done

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-500" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON with many dirty files" "$OUTPUT"
assert_single_line "stdout is a single line with many dirty files" "$OUTPUT"
assert_no_auto_stash "no auto-stash with many dirty files"
assert_main_repo_unchanged "many dirty files"

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with main-based repo (not master)${RESET}"

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

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "CHEX-100" --project-key "test" 2>/dev/null)

assert_valid_json "stdout is valid JSON (main-based repo)" "$OUTPUT"
assert_single_line "stdout is a single line (main-based repo)" "$OUTPUT"
assert_json_field "issue_key is correct (main-based repo)" "$OUTPUT" "issue_key" "CHEX-100"
assert_main_repo_unchanged "main-based repo"

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

cd "$MAIN_REPO"
git branch "STA-600" master --quiet
if git show-ref --verify --quiet "refs/heads/STA-600"; then
    echo -e "  ${GREEN}PASS${RESET} precondition: branch STA-600 exists"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} precondition: branch STA-600 exists"
    FAIL=$((FAIL + 1))
fi

snapshot_main_repo
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-600" --project-key "test" 2>/dev/null)
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
assert_json_field "issue_key is correct (existing branch)" "$OUTPUT" "issue_key" "STA-600"
assert_main_repo_unchanged "existing branch"

EXPECTED_PATH="$WORKTREES_ROOT/repo/STA-600"
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

echo -e "\n${BOLD}Test: create-worktree with stale index.lock (dirty repo)${RESET}"
setup_repo

# Stale index.lock + dirty working tree. The lock must be cleared before
# the fetch, even though we no longer stash.
touch "$MAIN_REPO/.git/index.lock"
echo "dirty" > "$MAIN_REPO/README.md"

OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-700" --project-key "test" 2>/dev/null)
EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${RESET} succeeds despite stale index.lock"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} succeeds despite stale index.lock (got exit $EXIT_CODE)"
    FAIL=$((FAIL + 1))
fi

assert_valid_json "stdout is valid JSON (stale index.lock)" "$OUTPUT"
assert_json_field "issue_key is correct (stale index.lock)" "$OUTPUT" "issue_key" "STA-700"

if [[ ! -f "$MAIN_REPO/.git/index.lock" ]]; then
    echo -e "  ${GREEN}PASS${RESET} stale index.lock was removed"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} stale index.lock was removed"
    FAIL=$((FAIL + 1))
fi

teardown_repo

# ==========================================================================

echo -e "\n${BOLD}Test: create-worktree with stale index.lock and CLEAN repo${RESET}"
setup_repo

# Stale index.lock on a clean repo — the lock would still block git fetch
# unless the lock-removal step runs first.
touch "$MAIN_REPO/.git/index.lock"

EXIT_CODE=0
OUTPUT=$("$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-800" --project-key "test" 2>/dev/null) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "  ${GREEN}PASS${RESET} succeeds despite stale index.lock on clean repo"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} succeeds despite stale index.lock on clean repo (got exit $EXIT_CODE)"
    FAIL=$((FAIL + 1))
fi

assert_valid_json "stdout is valid JSON (index.lock, clean repo)" "$OUTPUT"
assert_json_field "issue_key is correct (index.lock, clean repo)" "$OUTPUT" "issue_key" "STA-800"

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

# In a worktree, .git is a file (not a directory), so naively checking
# "$MAIN_REPO/.git/index.lock" misses the real lock under the common dir.
# The fix uses `git rev-parse --git-common-dir`.
WORKTREE_EXTRA="$TMPDIR_ROOT/worktree-extra"
git -C "$MAIN_REPO" worktree add "$WORKTREE_EXTRA" -b extra-branch master --quiet 2>/dev/null

touch "$MAIN_REPO/.git/index.lock"

if [[ -f "$WORKTREE_EXTRA/.git" && ! -d "$WORKTREE_EXTRA/.git" ]]; then
    echo -e "  ${GREEN}PASS${RESET} precondition: .git in worktree is a file"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} precondition: .git in worktree is a file"
    FAIL=$((FAIL + 1))
fi

# Run create-worktree pointing MAIN_REPO at the worktree. The lock removal
# step runs before any git operation that would observe the lock.
MAIN_REPO="$WORKTREE_EXTRA" "$SCRIPT_DIR/create-worktree.sh" --issue-key "STA-900" --project-key "test" >/dev/null 2>&1 || true

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
