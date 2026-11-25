#!/bin/bash

# Test: install.sh installs a snapshot whose shim runs the compiled executable
#
# What this exercises, against the REAL install.sh (sandboxed HOME):
# - the shim, idow and the installed skill scripts run from a snapshot in
#   ~/.pappardelle/local, so a later build in this checkout doesn't go live
#   (pappardelle-c3k5)
# - the snapshot's dist holds the executable and its source map, nothing else
# - the shim runs the executable with no Bun, nor anything else, on PATH
#
# Runs `bun install --frozen-lockfile` + `bun run build` in this checkout (LOCAL_MODE). Also
# runs in CI: the monorepo's pappardelle workflow globs scripts/test-*.sh and
# executes every match. Sandbox-safe there and locally — nothing outside the
# sandboxed HOME and this repo's dist/ is touched.
#
# Usage: ./test-install-shim.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

cleanup() {
    if [[ -n "${SANDBOX:-}" && -d "$SANDBOX" ]]; then
        rm -rf "$SANDBOX"
    fi
}
trap cleanup EXIT

assert_eq() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"

    if [[ "$actual" == "$expected" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected: \"$expected\""
        echo "    Actual:   \"$actual\""
        FAIL=$((FAIL + 1))
    fi
}

SANDBOX=$(mktemp -d)
SANDBOX_HOME="$SANDBOX/home"
mkdir -p "$SANDBOX_HOME"

EXPECTED_VERSION="$(bun -p "require('$REPO_DIR/package.json').version")"

echo -e "${BOLD}Running install.sh with sandboxed HOME...${RESET}"
INSTALL_LOG="$SANDBOX/install.log"
if ! HOME="$SANDBOX_HOME" bash "$REPO_DIR/install.sh" > "$INSTALL_LOG" 2>&1; then
    echo -e "${RED}install.sh failed — last 20 lines:${RESET}"
    tail -20 "$INSTALL_LOG"
    exit 1
fi

SHIM="$SANDBOX_HOME/.local/bin/pappardelle"
SNAPSHOT="$SANDBOX_HOME/.pappardelle/local"

echo ""
echo -e "${BOLD}Snapshot install${RESET}"

assert_eq "shim was created" "yes" "$([[ -f "$SHIM" && -x "$SHIM" ]] && echo yes || echo no)"
assert_eq "shim runs the snapshot's executable" "EXECUTABLE=\"$SNAPSHOT/dist/pappardelle\"" \
    "$(grep '^EXECUTABLE=' "$SHIM")"
assert_eq "idow links into the snapshot" "$SNAPSHOT/scripts/idow" \
    "$(readlink "$SANDBOX_HOME/.local/bin/idow")"
assert_eq "snapshot's dist holds the executable and its source map" "pappardelle pappardelle.map" \
    "$(cd "$SNAPSHOT/dist" && echo *)"
assert_eq "install links nothing to this checkout" "" \
    "$(grep -rlF "$REPO_DIR" "$SANDBOX_HOME" --exclude-dir=logs --exclude=commit-sha 2>/dev/null || true)"

echo ""
echo -e "${BOLD}Runtime: nothing on PATH${RESET}"

# Invoked via /bin/bash: with PATH this bare even the shebang's `env bash`
# lookup would fail before the shim ran.
OUT="$(PATH="$SANDBOX/empty-bin" /bin/bash "$SHIM" --version 2>&1)" && STATUS=0 || STATUS=$?
assert_eq "shim runs the executable with no Bun or Node on PATH" "0" "$STATUS"
assert_eq "the executable resolves its package version" "$EXPECTED_VERSION" "$OUT"

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ "$FAIL" -eq 0 ]]
