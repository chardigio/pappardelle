#!/bin/bash

# Test: install.sh pins the preflight-verified bun into the shim (STA-1682)
#
# The bug: install.sh verified `bun >= 18` in the interactive shell (nvm
# loaded, modern bun), but wrote a shim that resolved `bun` from PATH at
# runtime — a non-interactive environment where nvm never loads — silently
# binding to a stale system bun (e.g. /usr/local/bin/bun Bun 1.3).
#
# What this exercises, against the REAL install.sh (sandboxed HOME):
# - the produced shim contains the absolute path of the bun that ran install
# - the shim ignores a stale Bun 1.3 bun planted first on PATH (the exact repro
#   from the issue) and still runs the CLI under the pinned bun
# - when the pinned binary vanishes, the shim falls back to PATH but fails
#   loud + actionable on a below-floor bun instead of half-working
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
# Setup: sandboxed HOME + a stale Bun 1.3 bun planted for PATH resolution
# ============================================================================

SANDBOX=$(mktemp -d)
SANDBOX_HOME="$SANDBOX/home"
STALE_BIN="$SANDBOX/stale-bin"
mkdir -p "$SANDBOX_HOME" "$STALE_BIN"

# The trap from the issue: a Bun 1.3 bun that a non-interactive PATH would find.
# If the CLI ever actually runs under it, it exits 86 so we notice.
cat > "$STALE_BIN/bun" <<'EOF'
#!/bin/bash
case "$1" in
    -p) echo 16 ;;
    --version) echo 1.3.0 ;;
    *)
        echo "STALE BUN RAN THE CLI — this is the STA-1682 bug" >&2
        exit 86
        ;;
esac
EOF
chmod +x "$STALE_BIN/bun"

EXPECTED_BUN_BIN="$(bun -p 'process.execPath')"
EXPECTED_VERSION="$(bun -p "require('$REPO_DIR/package.json').version")"

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
assert_contains "shim pins the bun that ran the installer" \
    "PINNED_BUN=\"$EXPECTED_BUN_BIN\"" "$(cat "$SHIM")"
assert_eq "shim has no unpinned 'exec bun'" "no" \
    "$(grep -q 'exec bun ' "$SHIM" && echo yes || echo no)"

echo ""
echo -e "${BOLD}Runtime: stale Bun 1.3 bun first on PATH (the issue's repro)${RESET}"

# Non-interactive PATH where `bun` resolves to the stale Bun 1.3 stub. On master
# this ran the CLI under Bun 1.3; with the pin it must use the verified bun.
STALE_OUT="$(PATH="$STALE_BIN:$PATH" "$SHIM" --version 2>&1)" && STALE_STATUS=0 || STALE_STATUS=$?
assert_eq "shim exits 0 despite stale bun on PATH" "0" "$STALE_STATUS"
assert_eq "shim ran the compiled CLI" "$EXPECTED_VERSION" "$STALE_OUT"

echo ""
echo -e "${BOLD}Runtime: pinned bun vanished, stale bun on PATH${RESET}"

BROKEN_SHIM="$SANDBOX/pappardelle-broken-pin"
sed "s|PINNED_BUN=\"$EXPECTED_BUN_BIN\"|PINNED_BUN=\"$SANDBOX/uninstalled/bun\"|" \
    "$SHIM" > "$BROKEN_SHIM"
chmod +x "$BROKEN_SHIM"

NATIVE_OUT="$(PATH="$SANDBOX/empty-bin" /bin/bash "$BROKEN_SHIM" --version 2>&1)" && NATIVE_STATUS=0 || NATIVE_STATUS=$?
assert_eq "compiled release runs without the pinned Bun or any runtime on PATH" "0" "$NATIVE_STATUS"
assert_eq "compiled release resolves its package version" "$EXPECTED_VERSION" "$NATIVE_OUT"
# Exercise the JavaScript fallback independently, without moving the real build.
sed "s|^NATIVE_BINARY=.*|NATIVE_BINARY=\"$SANDBOX/no-native\"|" "$BROKEN_SHIM" > "$SANDBOX/fallback-shim"
BROKEN_SHIM="$SANDBOX/fallback-shim"
chmod +x "$BROKEN_SHIM"

GUARD_OUT="$(PATH="$STALE_BIN:$PATH" "$BROKEN_SHIM" --version 2>&1)" && GUARD_STATUS=0 || GUARD_STATUS=$?
assert_eq "shim refuses to run under the stale fallback bun" "1" "$GUARD_STATUS"
assert_contains "failure names the stale version" "1.3.0" "$GUARD_OUT"
assert_contains "failure is actionable (points at reinstall)" "install.sh" "$GUARD_OUT"
assert_eq "the CLI never executed under Bun 1.3" "no" \
    "$([[ "$GUARD_OUT" == *"STALE BUN RAN THE CLI"* ]] && echo yes || echo no)"

echo ""
echo -e "${BOLD}Runtime: pinned bun vanished, no bun on PATH at all${RESET}"

# Invoked via /bin/bash: with PATH this bare even the shebang's `env bash`
# lookup would fail before our logic ran — we're testing the shim, not env.
NOBUN_OUT="$(PATH="$SANDBOX/empty-bin" /bin/bash "$BROKEN_SHIM" --version 2>&1)" && NOBUN_STATUS=0 || NOBUN_STATUS=$?
assert_eq "shim exits 1 with no bun anywhere" "1" "$NOBUN_STATUS"
assert_contains "failure names the vanished pin" "$SANDBOX/uninstalled/bun" "$NOBUN_OUT"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}"
[[ "$FAIL" -eq 0 ]]
