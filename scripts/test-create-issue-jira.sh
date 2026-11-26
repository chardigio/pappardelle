#!/bin/bash

# Test: create_issue against a Jira config
#
# Runs the real create_issue from provider-helpers.sh with an acli on PATH that
# records its argv, and checks the --type and --project it is handed:
#   --issue-type → issue_tracker.default_issue_type → "Task"
#   --team → team_prefix (uppercased) → "STA"
#
# Usage: ./scripts/test-create-issue-jira.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-helpers.sh"

test_tmpdir TMPDIR_ROOT
FAKE_BIN="$TMPDIR_ROOT/bin"
ACLI_ARGV="$TMPDIR_ROOT/acli-argv.txt"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/acli" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$ACLI_ARGV"
echo "✓ Work item ENG-42 created"
EOF
chmod +x "$FAKE_BIN/acli"

# jira_config <top-level yaml> [issue_tracker yaml]: a Jira config with the
# given lines added at the top level and under issue_tracker.
jira_config() {
    printf 'version: 1\n%s\nissue_tracker:\n  provider: jira\n  base_url: https://example.atlassian.net\n%s\n' \
        "$1" "${2:-}" > "$TMPDIR_ROOT/.pappardelle.yml"
}

# create <create_issue args...>: creates an issue with the config jira_config
# last wrote.
create() {
    rm -f "$ACLI_ARGV"
    PATH="$FAKE_BIN:$PATH" create_issue --title "Add dark mode" --prompt "add dark mode" \
        --config "$TMPDIR_ROOT/.pappardelle.yml" "$@"
}

# The value acli got for a flag.
acli_arg() {
    grep -A1 -x -e "$1" "$ACLI_ARGV" 2>/dev/null | tail -n 1
}

# ==========================================================================

echo -e "\n${BOLD}Test: create_issue reports the issue acli created${RESET}"
jira_config "team_prefix: ENG"
assert_eq "the key and URL come from acli's output" \
    '{"issue_key":"ENG-42","issue_url":"https://example.atlassian.net/browse/ENG-42"}' "$(create)"

# ==========================================================================

echo -e "\n${BOLD}Test: the issue type${RESET}"
jira_config "team_prefix: ENG"
create >/dev/null
assert_eq "defaults to Task" "Task" "$(acli_arg --type)"

jira_config "team_prefix: ENG" "  default_issue_type: Feature"
create >/dev/null
assert_eq "issue_tracker.default_issue_type when set" "Feature" "$(acli_arg --type)"

create --issue-type Bug >/dev/null
assert_eq "--issue-type beats the default" "Bug" "$(acli_arg --type)"

# ==========================================================================

echo -e "\n${BOLD}Test: the project${RESET}"
jira_config "team_prefix: eng"
create >/dev/null
assert_eq "team_prefix from the config, uppercased" "ENG" "$(acli_arg --project)"

jira_config ""
create >/dev/null
assert_eq "STA when the config sets no team_prefix" "STA" "$(acli_arg --project)"

jira_config "team_prefix: eng"
create --team OPS >/dev/null
assert_eq "--team beats team_prefix" "OPS" "$(acli_arg --project)"

# ==========================================================================

summarize
