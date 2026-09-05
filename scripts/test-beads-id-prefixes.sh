#!/bin/bash

# Test: beads ID recognition is anchored to the repo's configured prefixes
#
# A beads suffix is a content hash, so it can be pure letters, and nothing about
# the shape of `fix-crash` or `dark-mode` distinguishes it from a real ID. idow
# used to route any hyphenated input to the existing-issue branch, so those
# descriptions died on a `bd show` lookup instead of creating an issue.
#
# What this exercises:
# - beads_id_prefixes (global team_prefix, per-profile team_prefix, and each
#   profile's tracker_projects, lowercased and deduplicated)
# - is_beads_issue_key (prefix anchoring, last-hyphen split so hyphenated
#   prefixes survive, underscores, hierarchical .N children)
#
# The prefix set must agree with getBeadsPrefixes in source/config.ts and
# get_beads_prefixes in hooks/tracker_config.py.
#
# Usage: ./test-beads-id-prefixes.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-helpers.sh"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

TMPDIR_ROOT=$(mktemp -d)
# shellcheck disable=SC2329  # invoked via trap
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

assert_key() {
    local test_name="$1"
    local input="$2"
    local config="$3"

    if is_beads_issue_key "$input" "$config" "$NO_BEADS_CONFIG"; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected \"$input\" to be recognized as a beads ID"
        FAIL=$((FAIL + 1))
    fi
}

assert_not_key() {
    local test_name="$1"
    local input="$2"
    local config="$3"

    if is_beads_issue_key "$input" "$config" "$NO_BEADS_CONFIG"; then
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected \"$input\" to be treated as a description"
        FAIL=$((FAIL + 1))
    else
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    fi
}

# Every assertion pins the beads config explicitly: the default is the config of
# whatever repo the suite runs in, whose prefix would leak into the expected sets.
NO_BEADS_CONFIG="$TMPDIR_ROOT/absent/config.yaml"

BEADS_CONFIG="$TMPDIR_ROOT/beads-config.yaml"
printf 'issue-prefix: dbprefix\n' > "$BEADS_CONFIG"

MULTI="$TMPDIR_ROOT/multi.yml"
cat > "$MULTI" <<'YAML'
version: 1
team_prefix: myproj
issue_tracker:
  provider: beads
profiles:
  backend:
    keywords: [api]
    team_prefix: my_service
  vendor:
    keywords: [sdk]
    tracker_projects:
      - 'vendor-sdk'
      - "Other-Thing"
YAML

SOLO="$TMPDIR_ROOT/solo.yml"
printf 'version: 1\nteam_prefix: solo\n' > "$SOLO"

BARE="$TMPDIR_ROOT/bare.yml"
printf 'version: 1\n' > "$BARE"

echo ""
echo -e "${BOLD}beads_id_prefixes${RESET}"

assert_eq "collects every configured source, lowercased and sorted" \
    "my_service
myproj
other-thing
vendor-sdk" \
    "$(beads_id_prefixes "$MULTI" "$NO_BEADS_CONFIG")"

assert_eq "just the global prefix when there are no profiles" \
    "solo" "$(beads_id_prefixes "$SOLO" "$NO_BEADS_CONFIG")"

assert_eq "empty when nothing is configured" \
    "" "$(beads_id_prefixes "$BARE" "$NO_BEADS_CONFIG")"

# bd mints IDs under the database's own issue-prefix, which need not match
# team_prefix. Omitting it made those IDs read as prose and file a duplicate.
assert_eq "includes the database issue-prefix" \
    "dbprefix
solo" \
    "$(beads_id_prefixes "$SOLO" "$BEADS_CONFIG")"

assert_eq "just the database issue-prefix when the config sets nothing" \
    "dbprefix" "$(beads_id_prefixes "$BARE" "$BEADS_CONFIG")"

echo ""
echo -e "${BOLD}is_beads_issue_key${RESET}"

assert_key "global prefix" "myproj-a1b2" "$MULTI"
assert_key "hierarchical child" "myproj-a3f8e9.1" "$MULTI"
assert_key "hyphenated tracker_projects prefix" "vendor-sdk-a1b2" "$MULTI"
assert_key "hyphenated prefix with a child suffix" "vendor-sdk-a1b2.2" "$MULTI"
assert_key "underscored per-profile prefix" "my_service-a1b2" "$MULTI"
assert_key "tracker_projects entry matched case-insensitively" "other-thing-hic" "$MULTI"
assert_key "uppercase input of a known prefix" "MYPROJ-A1B2" "$MULTI"

assert_not_key "hyphenated description" "fix-crash" "$MULTI"
assert_not_key "two-word description" "dark-mode" "$MULTI"
assert_not_key "long description" "add-dark-mode-to-settings" "$MULTI"
assert_not_key "known prefix word but not a key shape" "vendor" "$MULTI"
assert_not_key "unknown prefix" "nope-x1" "$MULTI"
assert_not_key "nesting deeper than beads allows" "myproj-a1b2.1.2.3.4" "$MULTI"
assert_not_key "anything at all when no prefix is configured" "solo-a1b2" "$BARE"

if is_beads_issue_key "dbprefix-a1b2" "$BARE" "$BEADS_CONFIG"; then
    echo -e "  ${GREEN}PASS${RESET} database issue-prefix alone recognizes a key"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${RESET} database issue-prefix alone recognizes a key"
    FAIL=$((FAIL + 1))
fi

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
