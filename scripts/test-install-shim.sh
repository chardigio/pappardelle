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
# Runs `bun install --frozen-lockfile` + `bun run build` in this checkout (LOCAL_MODE).
# CI runs it in this repo's shell-tests job and in the monorepo's pappardelle
# workflow, which globs scripts/test-*.sh and executes every match. Nothing
# outside the sandboxed HOME and this repo's dist/ is touched.
#
# Usage: ./scripts/test-install-shim.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

test_tmpdir SANDBOX
SANDBOX_HOME="$SANDBOX/home"
mkdir -p "$SANDBOX_HOME"

EXPECTED_VERSION="$(bun -p "require('$REPO_DIR/package.json').version")"

echo "Running install.sh with sandboxed HOME..."
INSTALL_LOG="$SANDBOX/install.log"
if ! HOME="$SANDBOX_HOME" bash "$REPO_DIR/install.sh" > "$INSTALL_LOG" 2>&1; then
    INSTALL_TAIL=("last 20 lines of its log:")
    while IFS= read -r line; do INSTALL_TAIL+=("$line"); done < <(tail -20 "$INSTALL_LOG")
    fail "install.sh succeeds" "${INSTALL_TAIL[@]}"
    summarize
fi

SHIM="$SANDBOX_HOME/.local/bin/pappardelle"
SNAPSHOT="$SANDBOX_HOME/.pappardelle/local"

section "Snapshot install"

assert_eq "shim was created" "yes" "$([[ -f "$SHIM" && -x "$SHIM" ]] && echo yes || echo no)"
assert_eq "shim runs the snapshot's executable" "EXECUTABLE=\"$SNAPSHOT/dist/pappardelle\"" \
    "$(grep '^EXECUTABLE=' "$SHIM")"
assert_eq "idow links into the snapshot" "$SNAPSHOT/scripts/idow" \
    "$(readlink "$SANDBOX_HOME/.local/bin/idow")"
assert_eq "snapshot's dist holds the executable and its source map" "pappardelle pappardelle.map" \
    "$(cd "$SNAPSHOT/dist" && echo *)"
assert_eq "install links nothing to this checkout" "" \
    "$(grep -rlF "$REPO_DIR" "$SANDBOX_HOME" --exclude-dir=logs --exclude=commit-sha 2>/dev/null || true)"

section "Runtime: nothing on PATH"

# Invoked via /bin/bash: with PATH this bare even the shebang's `env bash`
# lookup would fail before the shim ran.
OUT="$(PATH="$SANDBOX/empty-bin" /bin/bash "$SHIM" --version 2>&1)" && STATUS=0 || STATUS=$?
assert_eq "shim runs the executable with no Bun or Node on PATH" "0" "$STATUS"
assert_eq "the executable resolves its package version" "$EXPECTED_VERSION" "$OUT"

summarize
