#!/bin/bash

# Test: post_workspace_init command execution from .pappardelle.yml
#
# Exercises the expand_var + run_command logic extracted from idow,
# verifying template variable expansion, continue_on_error, background
# execution, and profile-specific post_workspace_init commands.
#
# Requires: yq
#
# Usage: ./test-workspace-init.sh

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

pass() {
    echo -e "  ${GREEN}PASS${RESET} $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "  ${RED}FAIL${RESET} $1"
    if [[ -n "${2:-}" ]]; then
        echo "    $2"
    fi
    FAIL=$((FAIL + 1))
}

assert_file_exists() {
    if [[ -f "$2" ]]; then
        pass "$1"
    else
        fail "$1" "Expected file: $2"
    fi
}

assert_file_content() {
    local actual
    actual=$(cat "$2" 2>/dev/null)
    if [[ "$actual" == "$3" ]]; then
        pass "$1"
    else
        fail "$1" "Expected: '$3', got: '$actual'"
    fi
}

assert_file_not_exists() {
    if [[ ! -f "$2" ]]; then
        pass "$1"
    else
        fail "$1" "Expected file NOT to exist: $2"
    fi
}

# ---------------------------------------------------------------------------
# Extracted from idow: expand_var and run_command
# These are the exact functions that idow uses to run post_workspace_init.
# ---------------------------------------------------------------------------

# Template expansion (mirrors idow's expand_var)
expand_var() {
    local template="$1"
    local result="$template"
    result="${result//\$\{WORKTREE_PATH\}/$WORKTREE_PATH}"
    result="${result//\$\{ISSUE_KEY\}/$ISSUE_KEY}"
    result="${result//\$\{ISSUE_NUMBER\}/$ISSUE_NUMBER}"
    result="${result//\$\{REPO_ROOT\}/$REPO_ROOT}"
    result="${result//\$\{REPO_NAME\}/$REPO_NAME}"
    echo "$result"
}

# Command execution (mirrors idow's run_command)
run_command() {
    local CMD_NAME="$1" CMD_RUN="$2" CMD_CONTINUE="$3" CMD_BG="$4"
    if [[ -z "$CMD_RUN" ]]; then return; fi
    if [[ "$CMD_BG" == "true" ]]; then
        eval "$CMD_RUN" &
    elif [[ "$CMD_CONTINUE" == "true" ]]; then
        eval "$CMD_RUN" >/dev/null 2>&1 || true
    else
        if ! eval "$CMD_RUN" >/dev/null 2>&1; then
            echo "COMMAND_FAILED:$CMD_NAME"
            return 1
        fi
    fi
}

# Run post_workspace_init commands from a config file (mirrors idow logic)
run_post_init_from_config() {
    local config_path="$1"
    local profile="${2:-}"
    local failed_cmd=""

    # Global post_workspace_init
    local POST_INIT_KEY="post_workspace_init"
    local POST_INIT_COUNT
    POST_INIT_COUNT=$(yq -r '.post_workspace_init | length // 0' "$config_path" 2>/dev/null)
    if [[ "$POST_INIT_COUNT" -eq 0 ]]; then
        POST_INIT_KEY="post_worktree_init"
        POST_INIT_COUNT=$(yq -r '.post_worktree_init | length // 0' "$config_path" 2>/dev/null)
    fi
    if [[ "$POST_INIT_COUNT" -gt 0 ]]; then
        for (( i=0; i<POST_INIT_COUNT; i++ )); do
            local CMD_NAME CMD_RUN_TMPL CMD_CONTINUE CMD_BG CMD_RUN
            CMD_NAME=$(yq -r ".$POST_INIT_KEY[$i].name // \"$POST_INIT_KEY[$i]\"" "$config_path")
            CMD_RUN_TMPL=$(yq -r ".$POST_INIT_KEY[$i].run // \"\"" "$config_path")
            CMD_CONTINUE=$(yq -r ".$POST_INIT_KEY[$i].continue_on_error // false" "$config_path")
            CMD_BG=$(yq -r ".$POST_INIT_KEY[$i].background // false" "$config_path")
            CMD_RUN=$(expand_var "$CMD_RUN_TMPL")
            if ! run_command "$CMD_NAME" "$CMD_RUN" "$CMD_CONTINUE" "$CMD_BG"; then
                failed_cmd="$CMD_NAME"
                break
            fi
        done
    fi

    # Profile-specific post_workspace_init
    if [[ -n "$profile" && -z "$failed_cmd" ]]; then
        local PROFILE_POST_INIT_KEY="post_workspace_init"
        local PROFILE_POST_INIT_COUNT
        PROFILE_POST_INIT_COUNT=$(yq -r ".profiles.$profile.post_workspace_init | length // 0" "$config_path" 2>/dev/null)
        if [[ "$PROFILE_POST_INIT_COUNT" -eq 0 ]]; then
            PROFILE_POST_INIT_KEY="post_worktree_init"
            PROFILE_POST_INIT_COUNT=$(yq -r ".profiles.$profile.post_worktree_init | length // 0" "$config_path" 2>/dev/null)
        fi
        if [[ "$PROFILE_POST_INIT_COUNT" -gt 0 ]]; then
            for (( i=0; i<PROFILE_POST_INIT_COUNT; i++ )); do
                local CMD_NAME CMD_RUN_TMPL CMD_CONTINUE CMD_BG CMD_RUN
                CMD_NAME=$(yq -r ".profiles.$profile.$PROFILE_POST_INIT_KEY[$i].name // \"profile_post_init[$i]\"" "$config_path")
                CMD_RUN_TMPL=$(yq -r ".profiles.$profile.$PROFILE_POST_INIT_KEY[$i].run // \"\"" "$config_path")
                CMD_CONTINUE=$(yq -r ".profiles.$profile.$PROFILE_POST_INIT_KEY[$i].continue_on_error // false" "$config_path")
                CMD_BG=$(yq -r ".profiles.$profile.$PROFILE_POST_INIT_KEY[$i].background // false" "$config_path")
                CMD_RUN=$(expand_var "$CMD_RUN_TMPL")
                if ! run_command "$CMD_NAME" "$CMD_RUN" "$CMD_CONTINUE" "$CMD_BG"; then
                    failed_cmd="$CMD_NAME"
                    break
                fi
            done
        fi
    fi

    if [[ -n "$failed_cmd" ]]; then
        return 1
    fi
}

# Set up a temp directory simulating a workspace
setup_workspace() {
    TMPDIR_ROOT=$(mktemp -d)
    WORKTREE_PATH="$TMPDIR_ROOT/worktree"
    REPO_ROOT="$TMPDIR_ROOT/repo"
    REPO_NAME="test-repo"
    ISSUE_KEY="STA-123"
    ISSUE_NUMBER="123"
    CONFIG_PATH="$TMPDIR_ROOT/config.yml"

    mkdir -p "$WORKTREE_PATH" "$REPO_ROOT"
}

teardown() {
    cd /
    rm -rf "$TMPDIR_ROOT"
}

# ==========================================================================

echo -e "${BOLD}Test: basic post_workspace_init command execution${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Create marker"
    run: "echo init-ran > ${WORKTREE_PATH}/marker.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_exists "marker file created by post_workspace_init" "$WORKTREE_PATH/marker.txt"
assert_file_content "marker file has correct content" "$WORKTREE_PATH/marker.txt" "init-ran"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: template variable expansion${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Write vars"
    run: "echo -n '${ISSUE_KEY}|${ISSUE_NUMBER}|${REPO_NAME}' > ${WORKTREE_PATH}/vars.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_content "all template vars expanded" "$WORKTREE_PATH/vars.txt" "STA-123|123|test-repo"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: WORKTREE_PATH and REPO_ROOT expansion${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Write paths"
    run: "echo -n '${WORKTREE_PATH}|${REPO_ROOT}' > ${WORKTREE_PATH}/paths.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_content "path vars expanded" "$WORKTREE_PATH/paths.txt" "$WORKTREE_PATH|$REPO_ROOT"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: multiple commands run sequentially${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Step 1"
    run: "echo step1 > ${WORKTREE_PATH}/seq.txt"
  - name: "Step 2"
    run: "echo step2 >> ${WORKTREE_PATH}/seq.txt"
  - name: "Step 3"
    run: "echo step3 >> ${WORKTREE_PATH}/seq.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
EXPECTED="step1
step2
step3"
assert_file_content "all 3 steps ran in order" "$WORKTREE_PATH/seq.txt" "$EXPECTED"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: continue_on_error skips past failure${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Soft fail"
    run: "false"
    continue_on_error: true
  - name: "After soft fail"
    run: "echo survived > ${WORKTREE_PATH}/survived.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_exists "command after soft fail ran" "$WORKTREE_PATH/survived.txt"
assert_file_content "survived file has correct content" "$WORKTREE_PATH/survived.txt" "survived"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: hard failure stops execution${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Will succeed"
    run: "echo ok > ${WORKTREE_PATH}/ok.txt"
  - name: "Hard fail"
    run: "false"
  - name: "Never runs"
    run: "echo bad > ${WORKTREE_PATH}/bad.txt"
EOF

run_post_init_from_config "$CONFIG_PATH" || true
assert_file_exists "first command ran" "$WORKTREE_PATH/ok.txt"
assert_file_not_exists "third command did not run" "$WORKTREE_PATH/bad.txt"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: profile-specific post_workspace_init${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles:
  ios:
    display_name: "iOS"
    match_title: "iOS"
    post_workspace_init:
      - name: "Profile init"
        run: "echo profile-ran > ${WORKTREE_PATH}/profile.txt"
EOF

run_post_init_from_config "$CONFIG_PATH" "ios"
assert_file_exists "profile init command ran" "$WORKTREE_PATH/profile.txt"
assert_file_content "profile marker has correct content" "$WORKTREE_PATH/profile.txt" "profile-ran"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: global + profile commands both run${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles:
  backend:
    display_name: "Backend"
    match_title: "backend"
    post_workspace_init:
      - name: "Profile step"
        run: "echo profile >> ${WORKTREE_PATH}/both.txt"
post_workspace_init:
  - name: "Global step"
    run: "echo global > ${WORKTREE_PATH}/both.txt"
EOF

run_post_init_from_config "$CONFIG_PATH" "backend"
EXPECTED="global
profile"
assert_file_content "global ran first, then profile" "$WORKTREE_PATH/both.txt" "$EXPECTED"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: legacy post_worktree_init fallback${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_worktree_init:
  - name: "Legacy init"
    run: "echo legacy > ${WORKTREE_PATH}/legacy.txt"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_exists "legacy post_worktree_init ran" "$WORKTREE_PATH/legacy.txt"
assert_file_content "legacy marker has correct content" "$WORKTREE_PATH/legacy.txt" "legacy"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: background command execution${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Background task"
    run: "echo bg > ${WORKTREE_PATH}/bg.txt"
    background: true
EOF

run_post_init_from_config "$CONFIG_PATH"
# Wait briefly for background process to complete
wait 2>/dev/null || true
sleep 0.2
assert_file_exists "background command created file" "$WORKTREE_PATH/bg.txt"
assert_file_content "background file has correct content" "$WORKTREE_PATH/bg.txt" "bg"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: empty post_workspace_init is a no-op${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init: []
EOF

run_post_init_from_config "$CONFIG_PATH"
pass "empty post_workspace_init does not error"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: no post_workspace_init key is a no-op${RESET}"
setup_workspace

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
EOF

run_post_init_from_config "$CONFIG_PATH"
pass "missing post_workspace_init key does not error"

teardown

# ==========================================================================

echo -e "\n${BOLD}Test: real-world pattern — copy .env and set PORT${RESET}"
setup_workspace

# Simulate a real .env in the repo root
cat > "$REPO_ROOT/.env" <<'ENVEOF'
PORT=5000
DATABASE_URL=postgres://localhost/dev
ENVEOF

cat > "$CONFIG_PATH" <<'EOF'
version: 1
profiles: {}
post_workspace_init:
  - name: "Copy .env"
    run: "cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true"
  - name: "Set PORT"
    run: "sed -i '' 's/^PORT=.*/PORT=5${ISSUE_NUMBER}/' ${WORKTREE_PATH}/.env 2>/dev/null || sed -i 's/^PORT=.*/PORT=5${ISSUE_NUMBER}/' ${WORKTREE_PATH}/.env"
EOF

run_post_init_from_config "$CONFIG_PATH"
assert_file_exists ".env was copied" "$WORKTREE_PATH/.env"

# Check that PORT was rewritten
PORT_LINE=$(grep '^PORT=' "$WORKTREE_PATH/.env")
if [[ "$PORT_LINE" == "PORT=5123" ]]; then
    pass "PORT set to 5123 (from ISSUE_NUMBER=123)"
else
    fail "PORT set to 5123" "Got: $PORT_LINE"
fi

# Check that other lines were preserved
DB_LINE=$(grep '^DATABASE_URL=' "$WORKTREE_PATH/.env")
if [[ "$DB_LINE" == "DATABASE_URL=postgres://localhost/dev" ]]; then
    pass "DATABASE_URL preserved"
else
    fail "DATABASE_URL preserved" "Got: $DB_LINE"
fi

teardown

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
