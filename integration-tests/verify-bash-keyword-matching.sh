#!/bin/bash
#
# Local verification of the bash match_profiles() function in idow.
# Tests: word-boundary matching, multi-word keyword preservation, false-positive prevention.
#
# NOT an ava test — run manually:
#   bash integration-tests/verify-bash-keyword-matching.sh
#
# Creates a temp .pappardelle.yml with known profiles and runs match_profiles()
# against various inputs, asserting expected results.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDOW_SCRIPT="$SCRIPT_DIR/../scripts/idow"

pass_count=0
fail_count=0

pass() {
    echo "  ✅ $1"
    ((pass_count++))
}

fail() {
    echo "  ❌ $1"
    ((fail_count++))
}

assert_eq() {
    local actual="$1" expected="$2" msg="$3"
    if [[ "$actual" == "$expected" ]]; then
        pass "$msg"
    else
        fail "$msg (expected '$expected', got '$actual')"
    fi
}

header() {
    echo ""
    echo "============================================================"
    echo "  $1"
    echo "============================================================"
}

# Create a temp config with known profiles
TEMP_CONFIG=$(mktemp /tmp/pappardelle-test-XXXXXX.yml)
trap 'rm -f "$TEMP_CONFIG"' EXIT

cat > "$TEMP_CONFIG" <<'YAML'
version: 1
default_profile: platform
team_prefix: STA

profiles:
  stardust-jams:
    keywords:
      - stardust
      - jam
      - music
      - spotify
      - playlist
    display_name: "Stardust Jams"

  king-bee:
    keywords:
      - king
      - bee
      - hive
      - spelling
    display_name: "King Bee"

  hit-the-weekly:
    keywords:
      - weekly
      - mileage
      - hit the weekly
      - hitmyweek
    display_name: "Hit the Weekly"

  trotbooks:
    keywords:
      - trotbooks
      - bookkeeping
      - horse
      - trot
      - standardbred
    display_name: "TrotBooks"

  pappardelle:
    keywords:
      - pappardelle
      - tui
      - idow
      - workspace
    display_name: "Pappardelle"

  platform:
    keywords:
      - platform
      - sllib
      - infra
      - deploy
    display_name: "Platform"

  girl-food:
    keywords:
      - girl food
    display_name: "Girl Food"
YAML

# Extract match_profiles and its dependencies from idow, injecting our temp config
CONFIG_PATH="$TEMP_CONFIG"

list_profiles() {
    yq -r '.profiles | keys | .[]' "$CONFIG_PATH"
}

# Source just the match_profiles function by extracting it from idow
# (it's self-contained once CONFIG_PATH and list_profiles are defined)
eval "$(sed -n '/^match_profiles()/,/^}/p' "$IDOW_SCRIPT")"

echo "Bash Keyword Matching — Local Verification"
echo "  Config: $TEMP_CONFIG"
echo "  idow:   $IDOW_SCRIPT"

# ── Multi-word keyword splitting ──────────────────────────────────
header "Multi-word keywords are preserved as phrases"

assert_eq \
    "$(match_profiles 'hit the weekly mileage tracker')" \
    "hit-the-weekly" \
    "\"hit the weekly\" matches as a phrase"

assert_eq \
    "$(match_profiles 'fix the login page')" \
    "" \
    "\"the\" alone does NOT match hit-the-weekly"

assert_eq \
    "$(match_profiles 'hit something')" \
    "" \
    "\"hit\" alone does NOT match hit-the-weekly"

assert_eq \
    "$(match_profiles 'add a recipe to girl food')" \
    "girl-food" \
    "\"girl food\" multi-word keyword matches"

# ── Word-boundary matching ────────────────────────────────────────
header "Word-boundary matching prevents substring false positives"

assert_eq \
    "$(match_profiles 'i was looking at the dashboard')" \
    "" \
    "\"king\" does NOT match inside \"looking\""

assert_eq \
    "$(match_profiles 'the king bee game needs work')" \
    "king-bee" \
    "\"king\" matches as a standalone word"

assert_eq \
    "$(match_profiles 'tracking mileage in the app')" \
    "hit-the-weekly" \
    "\"mileage\" matches as a standalone word"

# ── Real-world regression cases from idow.log ─────────────────────
header "Real-world regression cases (from idow.log)"

RESULT=$(match_profiles 'make the sta-123.trotbooks.com password screen more dramatic and sci-fi')
assert_eq \
    "$RESULT" \
    "trotbooks" \
    "STA-783: trotbooks.com description → trotbooks (not hit-the-weekly)"

RESULT=$(match_profiles "Make it so that if the user is signed in we see that they've signed in before by looking at their local storage. If they sign in and navigate to trotbooks.com it should simply redirect them to the dashboard")
assert_eq \
    "$RESULT" \
    "trotbooks" \
    "STA-786: trotbooks redirect description → trotbooks (not king-bee)"

# ── Basic keyword matching ────────────────────────────────────────
header "Basic keyword matching still works"

assert_eq \
    "$(match_profiles 'fix the hive puzzle')" \
    "king-bee" \
    "\"hive\" matches king-bee"

assert_eq \
    "$(match_profiles 'add spotify integration')" \
    "stardust-jams" \
    "\"spotify\" matches stardust-jams"

assert_eq \
    "$(match_profiles 'fix idow script')" \
    "pappardelle" \
    "\"idow\" matches pappardelle"

assert_eq \
    "$(match_profiles 'deploy the new service')" \
    "platform" \
    "\"deploy\" matches platform"

assert_eq \
    "$(match_profiles 'fix the bookkeeping module')" \
    "trotbooks" \
    "\"bookkeeping\" matches trotbooks"

assert_eq \
    "$(match_profiles 'standardbred racing database')" \
    "trotbooks" \
    "\"standardbred\" matches trotbooks"

# ── Case insensitivity ────────────────────────────────────────────
header "Case insensitivity"

assert_eq \
    "$(match_profiles 'TROTBOOKS needs a fix')" \
    "trotbooks" \
    "Uppercase keyword matches"

assert_eq \
    "$(match_profiles 'Fix The Hive Game')" \
    "king-bee" \
    "Title-case keyword matches"

# ── No match cases ────────────────────────────────────────────────
header "No match returns empty"

assert_eq \
    "$(match_profiles 'fix a random bug somewhere')" \
    "" \
    "Unrelated description matches nothing"

assert_eq \
    "$(match_profiles '')" \
    "" \
    "Empty input matches nothing"

# ── Multiple matches ──────────────────────────────────────────────
header "Multiple matches returned when appropriate"

RESULT=$(match_profiles 'fix the hive and deploy it')
[[ "$RESULT" == *"king-bee"* && "$RESULT" == *"platform"* ]]
if [[ $? -eq 0 ]]; then
    pass "Multiple keywords from different profiles both match"
else
    fail "Multiple keywords from different profiles both match (got '$RESULT')"
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Results: $pass_count passed, $fail_count failed"
echo "============================================================"

if [[ $fail_count -gt 0 ]]; then
    exit 1
fi
