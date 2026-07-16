#!/bin/bash

# Test: install.sh pins the preflight-verified node into the shim (STA-1682)
#
# The bug: install.sh verified `node >= 18` in the interactive shell (nvm
# loaded, modern node), but wrote a shim that resolved `node` from PATH at
# runtime — a non-interactive environment where nvm never loads — silently
# binding to a stale system node (e.g. /usr/local/bin/node v16).
#
# What this exercises, against the REAL install.sh (sandboxed HOME):
# - the produced shim contains the absolute path of the node that ran install
# - the shim ignores a stale v16 node planted first on PATH (the exact repro
#   from the issue) and still runs the CLI under the pinned node
# - when the pinned binary vanishes, the shim falls back to PATH but fails
#   loud + actionable on a below-floor node instead of half-working
#
# Runs `npm install` + `npm run build` in this checkout (LOCAL_MODE). Also
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

assert_contains() {
    local test_name="$1"
    local needle="$2"
    local haystack="$3"

    if [[ "$haystack" == *"$needle"* ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected to contain: \"$needle\""
        echo "    Actual: \"$haystack\""
        FAIL=$((FAIL + 1))
    fi
}

# ============================================================================
# Setup: sandboxed HOME + a stale v16 node planted for PATH resolution
# ============================================================================

SANDBOX=$(mktemp -d)
SANDBOX_HOME="$SANDBOX/home"
STALE_BIN="$SANDBOX/stale-bin"
mkdir -p "$SANDBOX_HOME" "$STALE_BIN"

# The trap from the issue: a v16 node that a non-interactive PATH would find.
# If the CLI ever actually runs under it, it exits 86 so we notice.
cat > "$STALE_BIN/node" <<'EOF'
#!/bin/bash
case "$1" in
    -p) echo 16 ;;
    --version) echo v16.13.0 ;;
    *)
        echo "STALE NODE RAN THE CLI — this is the STA-1682 bug" >&2
        exit 86
        ;;
esac
EOF
chmod +x "$STALE_BIN/node"

EXPECTED_NODE_BIN="$(node -p 'process.execPath')"
EXPECTED_VERSION="$(node -p "require('$REPO_DIR/package.json').version")"

echo -e "${BOLD}Running install.sh with sandboxed HOME...${RESET}"
INSTALL_LOG="$SANDBOX/install.log"
if ! HOME="$SANDBOX_HOME" bash "$REPO_DIR/install.sh" > "$INSTALL_LOG" 2>&1; then
    echo -e "${RED}install.sh failed — last 20 lines:${RESET}"
    tail -20 "$INSTALL_LOG"
    exit 1
fi

SHIM="$SANDBOX_HOME/.local/bin/pappardelle"

# ============================================================================
# Tests
# ============================================================================

echo ""
echo -e "${BOLD}Shim contents${RESET}"

assert_eq "shim was created" "yes" "$([[ -f "$SHIM" && -x "$SHIM" ]] && echo yes || echo no)"
assert_contains "shim pins the node that ran the installer" \
    "PINNED_NODE=\"$EXPECTED_NODE_BIN\"" "$(cat "$SHIM")"
assert_eq "shim has no unpinned 'exec node'" "no" \
    "$(grep -q 'exec node ' "$SHIM" && echo yes || echo no)"

echo ""
echo -e "${BOLD}Runtime: stale v16 node first on PATH (the issue's repro)${RESET}"

# Non-interactive PATH where `node` resolves to the stale v16 stub. On master
# this ran the CLI under v16; with the pin it must use the verified node.
STALE_OUT="$(PATH="$STALE_BIN:$PATH" "$SHIM" --version 2>&1)" && STALE_STATUS=0 || STALE_STATUS=$?
assert_eq "shim exits 0 despite stale node on PATH" "0" "$STALE_STATUS"
assert_eq "shim ran the real CLI under the pinned node" "$EXPECTED_VERSION" "$STALE_OUT"

echo ""
echo -e "${BOLD}Runtime: pinned node vanished, stale node on PATH${RESET}"

BROKEN_SHIM="$SANDBOX/pappardelle-broken-pin"
sed "s|PINNED_NODE=\"$EXPECTED_NODE_BIN\"|PINNED_NODE=\"$SANDBOX/uninstalled/node\"|" \
    "$SHIM" > "$BROKEN_SHIM"
chmod +x "$BROKEN_SHIM"

GUARD_OUT="$(PATH="$STALE_BIN:$PATH" "$BROKEN_SHIM" --version 2>&1)" && GUARD_STATUS=0 || GUARD_STATUS=$?
assert_eq "shim refuses to run under the stale fallback node" "1" "$GUARD_STATUS"
assert_contains "failure names the stale version" "v16.13.0" "$GUARD_OUT"
assert_contains "failure is actionable (points at reinstall)" "install.sh" "$GUARD_OUT"
assert_eq "the CLI never executed under v16" "no" \
    "$([[ "$GUARD_OUT" == *"STALE NODE RAN THE CLI"* ]] && echo yes || echo no)"

echo ""
echo -e "${BOLD}Runtime: pinned node vanished, no node on PATH at all${RESET}"

# Invoked via /bin/bash: with PATH this bare even the shebang's `env bash`
# lookup would fail before our logic ran — we're testing the shim, not env.
NONODE_OUT="$(PATH="$SANDBOX/empty-bin" /bin/bash "$BROKEN_SHIM" --version 2>&1)" && NONODE_STATUS=0 || NONODE_STATUS=$?
assert_eq "shim exits 1 with no node anywhere" "1" "$NONODE_STATUS"
assert_contains "failure names the vanished pin" "$SANDBOX/uninstalled/node" "$NONODE_OUT"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ "$FAIL" -eq 0 ]]
