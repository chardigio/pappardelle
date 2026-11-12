#!/usr/bin/env bash
# Sourced by scripts that record workspace state. They ask the pappardelle
# binary to do it, so the state files and the database have one writer.

_STATE_CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# pappardelle_state <verb> [args...]
# Looks for the binary the way start-agent-session.sh finds the status
# monitor, then falls back to the sources for a checkout with no build.
pappardelle_state() {
    local bun="${PAPPARDELLE_BUN:-$(command -v bun || true)}"
    if [[ -x "${PAPPARDELLE_EXECUTABLE:-}" ]]; then
        "$PAPPARDELLE_EXECUTABLE" --internal-state "$@"
    elif [[ -x "$_STATE_CLI_DIR/../dist/pappardelle" ]]; then
        "$_STATE_CLI_DIR/../dist/pappardelle" --internal-state "$@"
    elif [[ -x "$bun" && -f "$_STATE_CLI_DIR/../dist/state-cli.js" ]]; then
        "$bun" --no-env-file --config=/dev/null "$_STATE_CLI_DIR/../dist/state-cli.js" "$@"
    elif [[ -x "$bun" && -f "$_STATE_CLI_DIR/../source/state-cli.ts" ]]; then
        "$bun" --no-env-file --config=/dev/null "$_STATE_CLI_DIR/../source/state-cli.ts" "$@"
    else
        echo "pappardelle: no binary or Bun found to record workspace state" >&2
        return 127
    fi
}
