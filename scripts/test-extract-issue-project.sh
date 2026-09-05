#!/bin/bash

# Test: profile resolution from a fetched issue's tracker project (STA-1649)
#
# When the user types an existing issue key, `idow` fetches the issue and is
# supposed to pick the profile whose `tracker_projects` contains the issue's
# project. That worked for Linear only: the inline jq read `.project.name`
# (linctl's shape), while Jira's `acli jira workitem view --json` nests the
# project at `.fields.project` — AND acli's default field set omits `project`
# entirely, so the fetch must request `--fields '*all'` (as the TS provider
# already does).
#
# What this exercises:
# - extract_issue_project_candidates (provider dispatch: Linear name;
#   Jira name + key)
# - match_profile_by_tracker_project (candidate loop over the yq filter,
#   case-insensitive, first profile wins)
# - fetch_issue_json passes --fields '*all' to acli (shadowed binary records
#   its argv; without this flag the project field never arrives)
#
# Usage: ./test-extract-issue-project.sh

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
        echo "    Actual:              \"$haystack\""
        FAIL=$((FAIL + 1))
    fi
}

TMPDIR_ROOT=$(mktemp -d)

setup_configs() {
    cat > "$TMPDIR_ROOT/.pappardelle-linear.yml" <<'EOF'
version: 1
team_prefix: STA
default_profile: pappardelle
issue_tracker:
  provider: linear
profiles:
  pappardelle:
    display_name: Pappardelle
    keywords: [pappardelle]
    tracker_projects:
      - "Pappardelle Quality"
  king-bee:
    display_name: King Bee
    keywords: [bee]
    tracker_projects:
      - "The Hive Quality"
      - "Wordle"
EOF

    cat > "$TMPDIR_ROOT/.pappardelle-jira.yml" <<'EOF'
version: 1
team_prefix: KAN
default_profile: first-profile
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
profiles:
  first-profile:
    display_name: First Profile
    keywords: [first]
  by-name:
    display_name: Matched By Name
    keywords: [name]
    tracker_projects:
      - "Pappardelle Testing"
  by-key:
    display_name: Matched By Key
    keywords: [key]
    tracker_projects:
      - "SHOP"
EOF

    cat > "$TMPDIR_ROOT/.pappardelle-beads.yml" <<'EOF'
version: 1
team_prefix: pap
default_profile: first-profile
issue_tracker:
  provider: beads
profiles:
  first-profile:
    display_name: First Profile
    keywords: [first]
  by-prefix:
    display_name: Matched By Prefix
    keywords: [prefix]
    tracker_projects:
      - "pap"
  long-prefix:
    display_name: Long Prefix
    keywords: [long]
    tracker_projects:
      - "seatgeek-ticket-management-cli"
EOF
}
setup_configs

# Fixture shapes: linctl returns the issue at the top level; acli nests
# everything under .fields (captured from real CLI output).
LINEAR_ISSUE_JSON='{"identifier":"STA-123","title":"A Linear issue","project":{"id":"uuid-1","name":"Pappardelle Quality"}}'
LINEAR_NO_PROJECT_JSON='{"identifier":"STA-124","title":"Projectless","project":null}'
JIRA_ISSUE_JSON='{"key":"KAN-9","fields":{"summary":"A Jira issue","project":{"key":"KAN","name":"Pappardelle Testing"}}}'
JIRA_KEY_ONLY_MATCH_JSON='{"key":"SHOP-313","fields":{"summary":"Cart bug","project":{"key":"SHOP","name":"Shopping Cart"}}}'
JIRA_NO_PROJECT_JSON='{"key":"KAN-10","fields":{"summary":"No project field"}}'
# Beads has no project field at all; the ID prefix stands in for it.
BEADS_ISSUE_JSON='{"id":"pap-a1b2","title":"A beads issue","status":"open"}'
BEADS_LONG_PREFIX_JSON='{"id":"seatgeek-ticket-management-cli-bqm","title":"Hyphenated prefix","status":"open"}'
BEADS_CHILD_JSON='{"id":"pap-a3f8e9.1","title":"A child issue","status":"open"}'
BEADS_NO_PREFIX_JSON='{"id":"nohyphen","title":"Prefixless","status":"open"}'

# ==========================================================================

echo -e "${BOLD}Test: extract_issue_project_candidates — Linear shape${RESET}"
result=$(extract_issue_project_candidates "$LINEAR_ISSUE_JSON" "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "Linear issue → project name" "Pappardelle Quality" "$result"

result=$(extract_issue_project_candidates "$LINEAR_NO_PROJECT_JSON" "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "Linear issue without project → empty" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: extract_issue_project_candidates — Jira shape emits name then key${RESET}"
result=$(extract_issue_project_candidates "$JIRA_ISSUE_JSON" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "Jira issue → name + key lines" "Pappardelle Testing
KAN" "$result"

result=$(extract_issue_project_candidates "$JIRA_NO_PROJECT_JSON" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "Jira issue without project → empty" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: match_profile_by_tracker_project — Linear name (regression pin)${RESET}"
candidates=$(extract_issue_project_candidates "$LINEAR_ISSUE_JSON" "$TMPDIR_ROOT/.pappardelle-linear.yml")
result=$(match_profile_by_tracker_project "$candidates" "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "Linear project name → profile" "pappardelle" "$result"

result=$(match_profile_by_tracker_project "wordle" "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "case-insensitive name match" "king-bee" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: match_profile_by_tracker_project — Jira name and key${RESET}"
candidates=$(extract_issue_project_candidates "$JIRA_ISSUE_JSON" "$TMPDIR_ROOT/.pappardelle-jira.yml")
result=$(match_profile_by_tracker_project "$candidates" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "Jira project name → profile (not first-profile)" "by-name" "$result"

candidates=$(extract_issue_project_candidates "$JIRA_KEY_ONLY_MATCH_JSON" "$TMPDIR_ROOT/.pappardelle-jira.yml")
result=$(match_profile_by_tracker_project "$candidates" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "Jira project key → profile when name has no match" "by-key" "$result"

result=$(match_profile_by_tracker_project "shop" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "case-insensitive key match" "by-key" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: match_profile_by_tracker_project — no match / empty input${RESET}"
result=$(match_profile_by_tracker_project "Unknown Project" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "unknown project → empty" "" "$result"

result=$(match_profile_by_tracker_project "" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "empty candidates → empty" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: fetch_issue_json requests --fields '*all' from acli${RESET}"
# acli's default view field set (assignee, description, issuetype, status,
# summary) omits `project`; without '*all' the candidates above never exist.
FAKE_BIN="$TMPDIR_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/acli" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$TMPDIR_ROOT/acli-argv.txt"
echo '$JIRA_ISSUE_JSON'
EOF
chmod +x "$FAKE_BIN/acli"

result=$(PATH="$FAKE_BIN:$PATH" fetch_issue_json "KAN-9" "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_contains "fetch returns acli stdout" '"key":"KAN-9"' "$result"

argv=$(cat "$TMPDIR_ROOT/acli-argv.txt" 2>/dev/null || echo "MISSING")
assert_contains "acli argv includes --fields" "--fields" "$argv"
assert_contains "acli argv includes *all" "*all" "$argv"

# ==========================================================================

echo -e "\n${BOLD}Test: extract_issue_project_candidates — beads uses the ID prefix${RESET}"
BEADS_CONFIG="$TMPDIR_ROOT/.pappardelle-beads.yml"

result=$(extract_issue_project_candidates "$BEADS_ISSUE_JSON" "$BEADS_CONFIG")
assert_eq "beads issue → ID prefix" "pap" "$result"

result=$(extract_issue_project_candidates "$BEADS_LONG_PREFIX_JSON" "$BEADS_CONFIG")
assert_eq "hyphenated prefix splits on the last hyphen" \
    "seatgeek-ticket-management-cli" "$result"

result=$(extract_issue_project_candidates "$BEADS_CHILD_JSON" "$BEADS_CONFIG")
assert_eq "child ID drops its .N suffix" "pap" "$result"

result=$(extract_issue_project_candidates "$BEADS_NO_PREFIX_JSON" "$BEADS_CONFIG")
assert_eq "prefixless ID → empty" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: match_profile_by_tracker_project — beads prefix routing${RESET}"
candidates=$(extract_issue_project_candidates "$BEADS_ISSUE_JSON" "$BEADS_CONFIG")
result=$(match_profile_by_tracker_project "$candidates" "$BEADS_CONFIG")
assert_eq "prefix pap → by-prefix profile" "by-prefix" "$result"

candidates=$(extract_issue_project_candidates "$BEADS_LONG_PREFIX_JSON" "$BEADS_CONFIG")
result=$(match_profile_by_tracker_project "$candidates" "$BEADS_CONFIG")
assert_eq "hyphenated prefix → long-prefix profile" "long-prefix" "$result"

candidates=$(extract_issue_project_candidates "$BEADS_NO_PREFIX_JSON" "$BEADS_CONFIG")
result=$(match_profile_by_tracker_project "$candidates" "$BEADS_CONFIG")
assert_eq "no prefix → no profile match" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: extract_issue_url — beads issues have no web page${RESET}"
result=$(extract_issue_url "$BEADS_ISSUE_JSON" "$BEADS_CONFIG" "pap-a1b2")
assert_eq "beads issue → empty URL" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: extract_issue_title/description — beads shape${RESET}"
result=$(extract_issue_title "$BEADS_ISSUE_JSON" "$BEADS_CONFIG")
assert_eq "beads title read from .title" "A beads issue" "$result"

result=$(extract_issue_description '{"id":"pap-a1b2","description":"the body"}' "$BEADS_CONFIG")
assert_eq "beads description read from .description" "the body" "$result"

result=$(extract_issue_description "$BEADS_ISSUE_JSON" "$BEADS_CONFIG")
assert_eq "beads issue without description → empty" "" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: beads_first_issue — every payload shape bd emits${RESET}"
# bd show returns a one-element array, not the bare object its schema doc
# describes, and BD_JSON_ENVELOPE=1 wraps whatever it returns.
result=$(echo '[{"id":"pap-a1b2","title":"From array"}]' | beads_first_issue | jq -r '.title')
assert_eq "bare array → first element" "From array" "$result"

result=$(echo '{"schema_version":1,"data":[{"id":"pap-a1b2","title":"Enveloped"}]}' | beads_first_issue | jq -r '.title')
assert_eq "envelope around array → first element" "Enveloped" "$result"

result=$(echo '{"schema_version":1,"data":{"id":"pap-a1b2","title":"Enveloped object"}}' | beads_first_issue | jq -r '.title')
assert_eq "envelope around object → the object" "Enveloped object" "$result"

result=$(echo '{"id":"pap-a1b2","title":"Bare object"}' | beads_first_issue | jq -r '.title')
assert_eq "bare object → itself" "Bare object" "$result"

result=$(echo '[]' | beads_first_issue | jq -r '.title // "none"')
assert_eq "empty array → empty object" "none" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: create_issue — beads argv and output${RESET}"
# Shadow bd so the test never touches a real database. create_issue asks for
# --json and reduces the payload with beads_first_issue, so the fake answers in
# the envelope shape beads 2.0 makes its default.
cat > "$FAKE_BIN/bd" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$TMPDIR_ROOT/bd-argv.txt"
for arg in "\$@"; do
    case "\$prev" in
        --body-file) cp "\$arg" "$TMPDIR_ROOT/bd-body.txt" ;;
    esac
    prev="\$arg"
done
echo "Warning: multiple 'bd' binaries found in PATH" >&2
echo '{"schema_version":1,"data":[{"id":"pap-a1b2"}]}'
EOF
chmod +x "$FAKE_BIN/bd"

result=$(PATH="$FAKE_BIN:$PATH" create_issue \
    --title "Add dark mode" \
    --prompt "add dark mode to settings" \
    --config "$BEADS_CONFIG" \
    --profile by-prefix)
assert_eq "create_issue emits the new key" '{"issue_key":"pap-a1b2","issue_url":""}' "$result"

argv=$(cat "$TMPDIR_ROOT/bd-argv.txt" 2>/dev/null || echo "MISSING")
assert_contains "bd argv uses create" "create" "$argv"
assert_contains "bd argv passes the title" "Add dark mode" "$argv"
assert_contains "bd argv passes --json" "--json" "$argv"
# Beads spells its types lowercase and rejects Jira's "Task".
assert_contains "bd argv lowercases the issue type" "task" "$argv"
assert_contains "bd argv sends the description via a file" "--body-file" "$argv"

body=$(cat "$TMPDIR_ROOT/bd-body.txt" 2>/dev/null || echo "MISSING")
assert_contains "description body quotes the original prompt" \
    "> add dark mode to settings" "$body"

# stderr advisories must not leak into the parsed issue key.
assert_eq "warning on stderr stays out of the key" \
    '{"issue_key":"pap-a1b2","issue_url":""}' "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: ISSUE_NUMBER derivation from an issue key${RESET}"
# idow's `grep -oE '[0-9]+'` emits one line per digit run. Classic keys have
# exactly one; beads IDs carry a content hash, so "bd-a1b2" yields "1\n2" and
# any ${ISSUE_NUMBER} template it feeds becomes a broken multi-line command.
issue_number_for() {
    local provider="$1" key="$2"
    if [[ "$provider" == "beads" ]]; then
        echo ""
    else
        echo "$key" | grep -oE '[0-9]+' | head -1 || echo ""
    fi
}

assert_eq "classic key → its number" "595" "$(issue_number_for linear STA-595)"
assert_eq "beads hash ID → empty" "" "$(issue_number_for beads bd-a1b2)"
assert_eq "beads child ID → empty" "" "$(issue_number_for beads bd-a3f8e9.1)"

raw=$(echo "bd-a1b2" | grep -oE '[0-9]+' | tr '\n' '|')
assert_eq "raw grep on a beads ID is multi-line (the bug this guards)" "1|2|" "$raw"

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
