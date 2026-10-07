#!/bin/bash

# Test: claude.model / claude.effort resolution in resolve-agent-config.sh (STA-1829)
#
# Exercises the REAL script (not a mirror of its yq expression) across every
# layer/profile permutation:
#   home config → project config → local config, then profile → top-level.
#
# The TS side resolves the same fields via getClaudeModel()/getClaudeEffort()
# in source/config.ts, and source/claude-launch-config.test.ts pins that half.
# The two resolvers run in different languages and must agree, so this file
# pins the bash half — most importantly the empty-string semantics, where a
# profile-level "" means "clear the inherited value" rather than "no opinion".
#
# Usage: ./test-claude-model-effort.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

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

# Run the real resolver. Args: [--profile <name>] — config paths are wired to
# whatever setup_configs() last wrote.
resolve() {
    "$SCRIPT_DIR/resolve-agent-config.sh" \
        --config "$TMPDIR_ROOT/.pappardelle.yml" \
        --local-config "$TMPDIR_ROOT/.pappardelle.local.yml" \
        --home-config "$TMPDIR_ROOT/home/.pappardelle.yml" \
        "$@"
}

field() {
    jq -r ".$1"
}

# setup_configs <project_yaml> [local_yaml] [home_yaml]
setup_configs() {
    TMPDIR_ROOT=$(mktemp -d)
    mkdir -p "$TMPDIR_ROOT/home"
    printf '%s\n' "$1" > "$TMPDIR_ROOT/.pappardelle.yml"
    if [[ -n "${2:-}" ]]; then
        printf '%s\n' "$2" > "$TMPDIR_ROOT/.pappardelle.local.yml"
    fi
    if [[ -n "${3:-}" ]]; then
        printf '%s\n' "$3" > "$TMPDIR_ROOT/home/.pappardelle.yml"
    fi
}

BASE_PROFILES="profiles:
  backend:
    display_name: Backend
    keywords: [backend]
  frontend:
    display_name: Frontend
    keywords: [frontend]"

# ==========================================================================

echo -e "\n${BOLD}Test: off by default — no model/effort anywhere${RESET}"
setup_configs "version: 1
claude:
  initialization_command: /do
  dangerously_skip_permissions: true
$BASE_PROFILES"
OUT=$(resolve)
assert_eq "model is empty" "" "$(echo "$OUT" | field model)"
assert_eq "effort is empty" "" "$(echo "$OUT" | field effort)"
# The pre-existing fields must be untouched by this change.
assert_eq "init_cmd unchanged" "/do" "$(echo "$OUT" | field init_cmd)"
assert_eq "skip_permissions unchanged" "true" "$(echo "$OUT" | field skip_permissions)"
OUT=$(resolve --profile backend)
assert_eq "model is empty (with --profile)" "" "$(echo "$OUT" | field model)"
assert_eq "effort is empty (with --profile)" "" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: top-level model/effort apply with and without --profile${RESET}"
setup_configs "version: 1
claude:
  model: opus
  effort: high
$BASE_PROFILES"
OUT=$(resolve)
assert_eq "no profile → top-level model" "opus" "$(echo "$OUT" | field model)"
assert_eq "no profile → top-level effort" "high" "$(echo "$OUT" | field effort)"
OUT=$(resolve --profile backend)
assert_eq "profile without override → top-level model" "opus" "$(echo "$OUT" | field model)"
assert_eq "profile without override → top-level effort" "high" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: per-profile values beat top-level${RESET}"
setup_configs "version: 1
claude:
  model: opus
  effort: high
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    claude:
      model: sonnet
      effort: medium
  frontend:
    display_name: Frontend
    keywords: [frontend]"
OUT=$(resolve --profile backend)
assert_eq "profile model wins" "sonnet" "$(echo "$OUT" | field model)"
assert_eq "profile effort wins" "medium" "$(echo "$OUT" | field effort)"
OUT=$(resolve --profile frontend)
assert_eq "sibling profile inherits model" "opus" "$(echo "$OUT" | field model)"
assert_eq "sibling profile inherits effort" "high" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: a profile may set one field and inherit the other${RESET}"
setup_configs "version: 1
claude:
  model: opus
  effort: high
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    claude:
      effort: max"
OUT=$(resolve --profile backend)
assert_eq "model inherited" "opus" "$(echo "$OUT" | field model)"
assert_eq "effort overridden" "max" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: explicit empty string at profile level clears the global${RESET}"
setup_configs "version: 1
claude:
  model: opus
  effort: high
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    claude:
      model: \"\"
      effort: \"\""
OUT=$(resolve --profile backend)
assert_eq "profile empty model clears global" "" "$(echo "$OUT" | field model)"
assert_eq "profile empty effort clears global" "" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: unknown profile name falls back to top-level${RESET}"
setup_configs "version: 1
claude:
  model: opus
  effort: high
$BASE_PROFILES"
OUT=$(resolve --profile does_not_exist)
assert_eq "unknown profile → top-level model" "opus" "$(echo "$OUT" | field model)"
assert_eq "unknown profile → top-level effort" "high" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: config with no profiles: block at all${RESET}"
setup_configs "version: 1
claude:
  model: opus
profiles: {}"
OUT=$(resolve --profile backend)
assert_eq "empty profiles map → top-level model" "opus" "$(echo "$OUT" | field model)"
assert_eq "empty profiles map → empty effort" "" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: layered configs — local beats project beats home${RESET}"
setup_configs "version: 1
claude:
  model: sonnet
  effort: medium
$BASE_PROFILES" "version: 1
claude:
  model: fable" "version: 1
claude:
  model: haiku
  effort: low"
OUT=$(resolve)
assert_eq "local config wins for model" "fable" "$(echo "$OUT" | field model)"
assert_eq "project config wins for effort (local silent)" "medium" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: local config can override a profile's model${RESET}"
setup_configs "version: 1
claude:
  model: opus
profiles:
  backend:
    display_name: Backend
    keywords: [backend]
    claude:
      model: sonnet" "version: 1
profiles:
  backend:
    claude:
      model: fable"
OUT=$(resolve --profile backend)
assert_eq "local profile override wins" "fable" "$(echo "$OUT" | field model)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: home config supplies values when project config is silent${RESET}"
setup_configs "version: 1
$BASE_PROFILES" "" "version: 1
claude:
  model: haiku
  effort: low"
OUT=$(resolve --profile backend)
assert_eq "home model applies" "haiku" "$(echo "$OUT" | field model)"
assert_eq "home effort applies" "low" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: home and local both apply when the project config is silent${RESET}"
setup_configs "version: 1
$BASE_PROFILES" "version: 1
claude:
  effort: max" "version: 1
claude:
  model: haiku
  effort: low"
OUT=$(resolve --profile backend)
assert_eq "home model survives — local is silent on it" "haiku" "$(echo "$OUT" | field model)"
assert_eq "local effort beats home effort" "max" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================
# idow is the production caller and can't be run headlessly (needs tmux, a git
# repo, and live providers), so pin its wiring by inspection instead. It shipped
# without --home-config on either call site, which silently dropped the home
# layer for everyone launching a workspace while the TUI's loadConfig() honored
# it — the two resolvers disagreeing is the exact failure this file exists to
# prevent.

echo -e "\n${BOLD}Test: idow passes the home layer to the resolver${RESET}"
# `|| true` on both counts: grep -c exits 1 when it matches nothing, and this
# file runs under `set -e`. Without it the regression case this test exists to
# catch — zero calls carrying --home-config — kills the suite mid-test instead
# of failing it, printing no FAIL line, no summary, and silently skipping every
# test block below.
IDOW_CALLS=$(grep -c 'resolve-agent-config\.sh"' "$SCRIPT_DIR/idow" || true)
IDOW_HOME_CALLS=$(grep 'resolve-agent-config\.sh"' "$SCRIPT_DIR/idow" | grep -c -- '--home-config' || true)
assert_eq "every idow resolver call passes --home-config" "$IDOW_CALLS" "$IDOW_HOME_CALLS"
assert_eq "idow's home path matches getDefaultHomeConfigDir()" \
    'HOME_CONFIG_PATH="$HOME/.pappardelle/.pappardelle.yml"' \
    "$(grep -o 'HOME_CONFIG_PATH="\$HOME/[^"]*"' "$SCRIPT_DIR/idow" | head -1)"

# ==========================================================================

echo -e "\n${BOLD}Test: exotic model ids survive the JSON round-trip${RESET}"
setup_configs "version: 1
claude:
  model: \"claude-opus-5[1m]\"
  effort: xhigh
$BASE_PROFILES"
OUT=$(resolve --profile backend)
assert_eq "bracketed model id intact" "claude-opus-5[1m]" "$(echo "$OUT" | field model)"
assert_eq "xhigh effort intact" "xhigh" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================

echo -e "\n${BOLD}Test: profile names with hyphens resolve correctly${RESET}"
setup_configs "version: 1
claude:
  model: opus
profiles:
  stardust-jams:
    display_name: Stardust Jams
    keywords: [jams]
    claude:
      model: sonnet
      effort: medium"
OUT=$(resolve --profile stardust-jams)
assert_eq "hyphenated profile model" "sonnet" "$(echo "$OUT" | field model)"
assert_eq "hyphenated profile effort" "medium" "$(echo "$OUT" | field effort)"
cleanup; unset TMPDIR_ROOT

# ==========================================================================
# Agent profiles carry their own model/effort, rendered into agent_launch_flags
# through built-in (claude, codex) or configured templates. The deprecated
# claude block only fills in for claude agent profiles.

echo -e "\n${BOLD}Test: agent profile model/effort and their flags${RESET}"
setup_configs "version: 1
claude:
  model: sonnet
  effort: low
agent_profiles:
  codex:
    command: codex
    model: gpt-5.5
    effort: high
  opus:
    command: claude
    model: opus
  aider:
    command: aider
    model: \"x y\"
    model_args: --model={model}
profiles:
  codex:
    display_name: Codex
    agent_profile: codex
  opus:
    display_name: Opus
    agent_profile: opus
  aider:
    display_name: Aider
    agent_profile: aider
  plain:
    display_name: Plain"
OUT=$(resolve --profile codex)
assert_eq "codex gets its own model" "gpt-5.5" "$(echo "$OUT" | field model)"
assert_eq "codex flags use the built-in template" "-m gpt-5.5 -c model_reasoning_effort=high" "$(echo "$OUT" | field agent_launch_flags)"
OUT=$(resolve --profile opus)
assert_eq "claude agent profile model beats the claude block" "opus" "$(echo "$OUT" | field model)"
assert_eq "claude agent profile falls back to the claude block per field" "--model opus --effort low" "$(echo "$OUT" | field agent_launch_flags)"
OUT=$(resolve --profile aider)
assert_eq "configured template, value quoted for the shell" "--model='x y'" "$(echo "$OUT" | field agent_launch_flags)"
OUT=$(resolve --profile plain)
assert_eq "built-in claude still reads the claude block" "--model sonnet --effort low" "$(echo "$OUT" | field agent_launch_flags)"
assert_eq "deprecated top-level keys are reported" "claude.effort claude.model" "$(echo "$OUT" | field claude_launch_deprecated)"
cleanup; unset TMPDIR_ROOT

setup_configs "version: 1
claude:
  model: sonnet
agent_profiles:
  codex:
    command: codex
profiles:
  codex:
    display_name: Codex
    agent_profile: codex"
assert_eq "codex ignores the claude block" "" "$(resolve --profile codex | field agent_launch_flags)"
cleanup; unset TMPDIR_ROOT

setup_configs "version: 1
agent_profiles:
  aider:
    command: aider
    model: x
profiles:
  aider:
    display_name: Aider
    agent_profile: aider"
ERR=$(resolve --profile aider 2>&1 >/dev/null || true)
assert_eq "model without a flag template is an error" \
    'Error: agent_profiles.aider.model: "aider" has no built-in model flag; set model_args' "$ERR"
cleanup; unset TMPDIR_ROOT

# ==========================================================================
# open-iterm-agent.sh builds its own flag string because the command is
# assembled inside AppleScript. Values are printf %q'd here (safe for the inner
# `sh -c` tmux runs) and the whole string is then passed through AppleScript's
# `quoted form of` (safe for the outer shell iTerm types into) — so nothing is
# rejected or dropped, however exotic. Pin both the clean and the hostile case.

echo -e "\n${BOLD}Test: open-iterm-agent.sh launch flags${RESET}"
iterm_flags() {
    "$SCRIPT_DIR/open-iterm-agent.sh" --worktree /tmp --issue-key STA-1 \
        --repo-name testrepo --prompt "" "$@" --print-launch-flags 2>/dev/null
}
assert_eq "no flags configured → empty" "" "$(iterm_flags)"
assert_eq "model + effort" " --model sonnet --effort high" "$(iterm_flags --model sonnet --effort high)"
assert_eq "model only" " --model opus" "$(iterm_flags --model opus)"
assert_eq "effort only" " --effort max" "$(iterm_flags --effort max)"
assert_eq "flag order: dsp → model → effort" \
    " --dangerously-skip-permissions --model opus --effort high" \
    "$(iterm_flags --skip-permissions --model opus --effort high)"
assert_eq "provider-prefixed model id needs no escaping" " --model bedrock/anthropic.claude-v2" \
    "$(iterm_flags --model 'bedrock/anthropic.claude-v2')"
# Glob characters in a model id must reach claude literally, not be expanded.
assert_eq "bracketed model id is escaped for the inner shell" ' --model claude-opus-5\[1m\]' \
    "$(iterm_flags --model 'claude-opus-5[1m]')"
# The value is neutralized by quoting rather than discarded — no silent drop.
assert_eq "shell-hostile value is escaped, not dropped" ' --model ev\"il\;\ rm\ -rf\ /' \
    "$(iterm_flags --model 'ev"il; rm -rf /')"
assert_eq "a space-containing model still leaves a valid effort" ' --model bad\ value --effort high' \
    "$(iterm_flags --model 'bad value' --effort high)"

# ==========================================================================
# The command line open-iterm-agent.sh types is assembled inside AppleScript,
# so assert on the bytes the AppleScript itself returns (--print-command)
# rather than on a bash-side reimplementation of the concatenation. The key
# property: the agent command, flags, and resume args are referenced as
# $AGENT_CMD / $AGENT_FLAGS / $AGENT_RESUME inside the double-quoted tmux
# argument and only ever appear literally inside single-quoted assignments,
# so no config value can break the string apart.
# osascript is macOS-only; skipped elsewhere (CI runs ubuntu). Compiling the
# AppleScript needs iTerm's scripting dictionary, so machines without iTerm
# installed skip too.

echo -e "\n${BOLD}Test: open-iterm-agent.sh assembled command line${RESET}"
iterm_command() {
    "$SCRIPT_DIR/open-iterm-agent.sh" --worktree /tmp/wt --issue-key QA-1 \
        --repo-name testrepo --prompt "" "$@" --print-command 2>/dev/null | head -1
}

if ! command -v osascript >/dev/null 2>&1; then
    echo "  SKIP (no osascript — macOS only)"
elif [[ -z "$(iterm_command)" ]]; then
    echo "  SKIP (osascript can't compile the iTerm AppleScript — is iTerm installed?)"
else
    LINE=$(iterm_command)
    case "$LINE" in
        "AGENT_CMD='claude'; AGENT_FLAGS=''; AGENT_RESUME=' --continue';"*)
            assert_eq "no flags → claude defaults in the assignments" "ok" "ok" ;;
        *) assert_eq "no flags → claude defaults in the assignments" "AGENT_CMD='claude'; AGENT_FLAGS=''; AGENT_RESUME=' --continue';..." "$LINE" ;;
    esac
    case "$LINE" in
        *'"$AGENT_CMD$AGENT_FLAGS --name QA-1$AGENT_RESUME'*)
            assert_eq "flags referenced by expansion, not interpolated" "ok" "ok" ;;
        *) assert_eq "flags referenced by expansion, not interpolated" 'contains "$AGENT_CMD$AGENT_FLAGS --name QA-1$AGENT_RESUME' "$LINE" ;;
    esac

    LINE=$(iterm_command --model sonnet --effort medium)
    case "$LINE" in
        "AGENT_CMD='claude'; AGENT_FLAGS=' --model sonnet --effort medium';"*)
            assert_eq "resolved flags land in the assignment" "ok" "ok" ;;
        *) assert_eq "resolved flags land in the assignment" "AGENT_CMD='claude'; AGENT_FLAGS=' --model sonnet --effort medium';..." "$LINE" ;;
    esac

    # A value full of shell metacharacters must stay inside the single-quoted
    # assignment (escaped for the inner `sh -c`) and never reach the outer
    # shell as syntax. See verify-claude-model-effort.ts for the live
    # round-trip that runs this exact line and proves nothing is executed.
    LINE=$(iterm_command --model 'ev"il; echo PWNED > /tmp/pwned.txt')
    case "$LINE" in
        "AGENT_CMD='claude'; AGENT_FLAGS=' --model ev\\\"il\\;\\ echo\\ PWNED\\ \\>\\ /tmp/pwned.txt';"*)
            assert_eq "hostile value stays inside the quoted assignment" "ok" "ok" ;;
        *) assert_eq "hostile value stays inside the quoted assignment" "escaped assignment prefix" "$LINE" ;;
    esac

    # STE-2: a non-claude agent gets its own command/args/resume assignments
    # and none of the claude flags (--name/dsp/model/effort).
    LINE=$(iterm_command --model sonnet --skip-permissions \
        --agent-command codex --agent-args "--yolo" \
        --agent-resume-args "resume --last" --agent-is-claude false)
    case "$LINE" in
        "AGENT_CMD='codex'; AGENT_FLAGS=' --yolo'; AGENT_RESUME=' resume --last';"*)
            assert_eq "codex assignments carry command/args/resume" "ok" "ok" ;;
        *) assert_eq "codex assignments carry command/args/resume" "AGENT_CMD='codex'; AGENT_FLAGS=' --yolo'; AGENT_RESUME=' resume --last';..." "$LINE" ;;
    esac
    case "$LINE" in
        *--name*|*--model*|*--dangerously-skip-permissions*)
            assert_eq "codex line has no claude flags" "no claude flags" "$LINE" ;;
        *) assert_eq "codex line has no claude flags" "ok" "ok" ;;
    esac

    # STE-2: empty resume args → launch-only, no fallback chain (the resolver
    # sends "" for agents without resume_args; omitting the flag entirely
    # means claude defaults, i.e. --continue).
    LINE=$(iterm_command --agent-command codex --agent-args "--yolo" \
        --agent-resume-args "" --agent-is-claude false)
    case "$LINE" in
        *'||'*) assert_eq "codex without resume args has no fallback chain" "no || chain" "$LINE" ;;
        *'"$AGENT_CMD$AGENT_FLAGS"'*) assert_eq "codex without resume args has no fallback chain" "ok" "ok" ;;
        *) assert_eq "codex without resume args has no fallback chain" 'contains "$AGENT_CMD$AGENT_FLAGS"' "$LINE" ;;
    esac
fi

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
