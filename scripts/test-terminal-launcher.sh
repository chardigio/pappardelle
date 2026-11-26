#!/bin/bash

# Test: terminal.app resolution in resolve-terminal-app.sh (pappardelle-31y)
#
# Exercises the REAL resolver across the config layers and the auto-detection
# inputs. Detection reads the environment rather than TERM_PROGRAM (tmux
# clobbers that), and gates on the AppleScript dictionary being present, since
# only Ghostty 1.3+ ships one. GHOSTTY_APP points detection at a fake bundle so
# this runs anywhere, including CI on ubuntu.
#
# Usage: ./test-terminal-launcher.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-asserts.sh
source "$SCRIPT_DIR/../test/helpers/shell-asserts.sh"
# shellcheck source=SCRIPTDIR/../test/helpers/shell-fixtures.sh
source "$SCRIPT_DIR/../test/helpers/shell-fixtures.sh"

test_tmpdir BUNDLES
mkdir -p "$BUNDLES/Ghostty.app/Contents/Resources"
touch "$BUNDLES/Ghostty.app/Contents/Resources/Ghostty.sdef"

SCRIPTABLE_BUNDLE="$BUNDLES/Ghostty.app"
# A pre-1.3 Ghostty: the app exists but ships no AppleScript dictionary.
mkdir -p "$BUNDLES/OldGhostty.app/Contents/Resources"
UNSCRIPTABLE_BUNDLE="$BUNDLES/OldGhostty.app"

# Run the real resolver under a controlled environment. Args:
# <Ghostty signal: bundle-id|bin-dir|none> <bundle path>.
resolve() {
    local signal="$1"
    local bundle="$2"
    local -a env_args=(-u GHOSTTY_BIN_DIR -u __CFBundleIdentifier "GHOSTTY_APP=$bundle")
    case "$signal" in
        bundle-id) env_args+=("__CFBundleIdentifier=com.mitchellh.ghostty") ;;
        bin-dir) env_args+=("GHOSTTY_BIN_DIR=/opt/ghostty/bin") ;;
    esac
    env "${env_args[@]}" "$SCRIPT_DIR/resolve-terminal-app.sh" "${CONFIG_LAYER_ARGS[@]}"
}

NO_TERMINAL_SECTION='project: test'

echo -e "${BOLD}Test: auto-detection${RESET}"

write_config_layers "$NO_TERMINAL_SECTION"
assert_eq "Ghostty env + scriptable bundle → Ghostty" "Ghostty" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"
assert_eq "Ghostty env + pre-1.3 bundle → iTerm" "iTerm" "$(resolve bundle-id "$UNSCRIPTABLE_BUNDLE")"
assert_eq "no Ghostty env → iTerm" "iTerm" "$(resolve none "$SCRIPTABLE_BUNDLE")"

# GHOSTTY_BIN_DIR is the second surviving signal; a shell started by Ghostty's
# own shell integration has it even without the bundle identifier.
assert_eq "GHOSTTY_BIN_DIR alone is enough" "Ghostty" "$(resolve bin-dir "$SCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: auto"
assert_eq "explicit auto behaves like no section" "Ghostty" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

echo -e "\n${BOLD}Test: explicit values skip detection${RESET}"

write_config_layers "terminal:
  app: iTerm"
assert_eq "explicit iTerm wins under full Ghostty conditions" "iTerm" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: Ghostty"
assert_eq "explicit Ghostty wins with nothing detected" "Ghostty" "$(resolve none "$UNSCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: Terminal"
assert_eq "an app Pappardelle does not drive is passed through unchanged" "Terminal" \
    "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

# idow dispatches on an exact name, so a casing the user plausibly writes must
# not fall through to the unsupported-terminal warning.
write_config_layers "terminal:
  app: ghostty"
assert_eq "lowercase ghostty is canonicalized" "Ghostty" "$(resolve none "$UNSCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: ITERM"
assert_eq "uppercase ITERM is canonicalized" "iTerm" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: iTerm2"
assert_eq "iTerm2 is accepted as the same app" "iTerm" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: AUTO"
assert_eq "uppercase AUTO still detects" "Ghostty" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

echo -e "\n${BOLD}Test: config layering${RESET}"

write_config_layers "terminal:
  app: iTerm" "terminal:
  app: Ghostty"
assert_eq "local config overrides project config" "Ghostty" "$(resolve none "$UNSCRIPTABLE_BUNDLE")"

write_config_layers "$NO_TERMINAL_SECTION" "" "terminal:
  app: Ghostty"
assert_eq "home config applies when the project is silent" "Ghostty" "$(resolve none "$UNSCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: iTerm" "" "terminal:
  app: Ghostty"
assert_eq "project config overrides home config" "iTerm" "$(resolve bundle-id "$SCRIPTABLE_BUNDLE")"

write_config_layers "terminal:
  app: iTerm" "terminal:
  app: auto" "terminal:
  app: Ghostty"
assert_eq "local auto re-enables detection over a lower explicit value" "iTerm" \
    "$(resolve none "$SCRIPTABLE_BUNDLE")"

summarize
