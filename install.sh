#!/bin/bash

# install.sh - Install Pappardelle workspace manager
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
#
# Or from a local clone:
#   ./install.sh
#
# This script:
# 1. Checks prerequisites (Bun >= 1.4.4, tmux, jq)
# 2. Clones or updates chardigio/pappardelle to ~/.pappardelle/repo/
# 3. Builds and links the application (makes `pappardelle` available globally)
# 4. Symlinks `idow` to ~/.local/bin/
# 5. Creates required directories (~/.worktrees/, ~/.pappardelle/claude-status/)
# 6. Installs skill helper scripts to ~/.pappardelle/scripts/
# 7. Adds the Codex session hook to ~/.codex/hooks.json
# 8. Installs the Claude Code plugin (skills and status hooks) from this
#    checkout (`pappardelle plugin install`)

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }
print_info() { echo -e "${BLUE}→${NC} $1"; }

PAPPARDELLE_DIR="$HOME/.pappardelle"
REPO_DIR="$PAPPARDELLE_DIR/repo"
LOCAL_BIN="$HOME/.local/bin"
WORKTREES_DIR="$HOME/.worktrees"
REPO_URL="https://github.com/chardigio/pappardelle.git"
# Keep the runtime floor aligned with package.json and the launch shim.
MIN_BUN_VERSION=1.4.4
BUN_VERSION=1.4.4
PRIVATE_BUN_DIR="$PAPPARDELLE_DIR/bun"
BUN_DIST_URL="${PAPPARDELLE_BUN_DIST_URL:-https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}}"
REPO_URL="${PAPPARDELLE_REPO_URL:-$REPO_URL}"

bun_supported() {
    local version major minor patch min_major min_minor min_patch
    version="$("$1" --version 2>/dev/null)" || return 1
    [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
    IFS=. read -r major minor patch <<<"$version"
    IFS=. read -r min_major min_minor min_patch <<<"$MIN_BUN_VERSION"
    (( major > min_major || (major == min_major && minor > min_minor) ||
       (major == min_major && minor == min_minor && patch >= min_patch) ))
}

# Pin the updater's Bun first, then PATH, the standard user install, and our
# private runtime. This works from tmux's non-interactive environment too.
find_bun() {
    local candidate
    for candidate in "${PAPPARDELLE_BUN:-}" "$(command -v bun 2>/dev/null || true)" \
        "$HOME/.bun/bin/bun" "$PRIVATE_BUN_DIR/current/bun"; do
        [[ -x "$candidate" ]] || continue
        if bun_supported "$candidate"; then
            "$candidate" -p 'process.execPath'
            return 0
        fi
    done
    return 1
}

# Verify the official pinned release before changing the private runtime link.
# x64 baseline builds also run on machines without AVX2.
install_private_bun() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) print_error "No supported Bun build for $(uname -s)" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        arm64 | aarch64) arch=aarch64 ;;
        x86_64 | amd64) arch=x64-baseline ;;
        *) print_error "No supported Bun build for $(uname -m)" >&2; return 1 ;;
    esac
    if ! command -v unzip &>/dev/null; then
        print_error "Install unzip to download Pappardelle's private Bun runtime" >&2
        return 1
    fi
    local tmp sums expected actual archive name destination
    name="bun-${os}-${arch}"
    archive="$name.zip"
    tmp="$(mktemp -d)"
    if ! sums="$(curl -fsSL "$BUN_DIST_URL/SHASUMS256.txt")"; then
        print_error "Could not download Bun checksums from $BUN_DIST_URL" >&2
        rm -rf "$tmp"; return 1
    fi
    expected="$(awk -v file="$archive" '$2 == file {print $1}' <<<"$sums")"
    if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
        print_error "No checksum for $archive at $BUN_DIST_URL" >&2
        rm -rf "$tmp"; return 1
    fi
    print_info "Downloading $archive for Pappardelle (your own Bun is not changed)" >&2
    if ! curl -fsSL "$BUN_DIST_URL/$archive" -o "$tmp/$archive"; then
        print_error "Could not download $BUN_DIST_URL/$archive" >&2
        rm -rf "$tmp"; return 1
    fi
    if command -v shasum &>/dev/null; then
        actual="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
    else
        actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
    fi
    if [[ "$actual" != "$expected" ]]; then
        print_error "Checksum mismatch for $archive; not installing it" >&2
        rm -rf "$tmp"; return 1
    fi
    if ! unzip -q "$tmp/$archive" -d "$tmp" || ! bun_supported "$tmp/$name/bun"; then
        print_error "Downloaded Bun could not run on this machine" >&2
        rm -rf "$tmp"; return 1
    fi
    mkdir -p "$PRIVATE_BUN_DIR"
    destination="$(mktemp -d "$PRIVATE_BUN_DIR/release.XXXXXX")"
    mv "$tmp/$name/bun" "$destination/bun"
    rm -rf "$tmp"
    ln -sfn "$destination" "$PRIVATE_BUN_DIR/current"
    # Each release is about 90 MB, and only the one `current` names is used.
    find "$PRIVATE_BUN_DIR" -mindepth 1 -maxdepth 1 -name 'release.*' ! -path "$destination" -exec rm -rf {} +
    printf '%s\n' "$PRIVATE_BUN_DIR/current/bun"
}

# Clones and builds into a staging folder next to $REPO_DIR, and moves it into
# place only after the build succeeds. The shim runs from $REPO_DIR/dist, so
# deleting $REPO_DIR first (as the installer used to) left no working
# Pappardelle when the clone or `bun install` failed. The replaced install is
# kept at $REPO_DIR.previous as a rollback.
install_repo_atomically() {
    local stage
    mkdir -p "$PAPPARDELLE_DIR"
    stage="$(mktemp -d "$PAPPARDELLE_DIR/repo.staging.XXXXXX")"

    print_info "Cloning pappardelle..."
    if ! git clone --quiet "$REPO_URL" "$stage/repo"; then
        print_error "Failed to clone $REPO_URL; your current install is unchanged"
        rm -rf "$stage"; return 1
    fi

    print_info "Installing dependencies and building..."
    if ! (cd "$stage/repo" && bun install --frozen-lockfile --silent && bun run build); then
        print_error "bun install/build failed; your current install is unchanged"
        rm -rf "$stage"; return 1
    fi

    rm -rf "$REPO_DIR.previous"
    if [[ -e "$REPO_DIR" ]]; then
        mv "$REPO_DIR" "$REPO_DIR.previous"
    fi
    mv "$stage/repo" "$REPO_DIR"
    rm -rf "$stage"
    print_status "Built successfully and installed to $REPO_DIR"
}

# Prints the pappardelle clone that holds the install script at $1. Under
# `curl | bash` there is no script file, and dirname "" is ".", which used to
# make any pappardelle checkout in the current directory (such as the repo a
# TUI's `U` update runs from) count as the install and get rebuilt in place.
local_clone_dir() {
    local script="$1" dir
    [[ -n "$script" && -f "$script" ]] || return 1
    dir="$(cd "$(dirname "$script")" && pwd)" || return 1
    grep -q '"name".*"pappardelle"' "$dir/package.json" 2>/dev/null || return 1
    printf '%s\n' "$dir"
}

# Tests source this file to call the functions above without running the
# installer.
if [[ "${PAPPARDELLE_INSTALL_SOURCE_ONLY:-}" == 1 ]]; then
    # shellcheck disable=SC2317 # exit is reached only when not sourced
    return 0 2>/dev/null || exit 0
fi

LOCAL_MODE=false
if LOCAL_CLONE="$(local_clone_dir "${BASH_SOURCE[0]:-}")"; then
    LOCAL_MODE=true
    REPO_DIR="$LOCAL_CLONE"
fi

echo ""
echo -e "${BOLD}Pappardelle Installer${NC}"
echo "====================="
echo ""
echo "Interactive workspace manager for Claude Code + git worktrees"
echo ""

# ============================================================================
# Prerequisite Checks
# ============================================================================

MISSING=()

# Use the same verified Bun for installation, building, and the runtime shim.
BUN_BIN=""
if BUN_BIN="$(find_bun)"; then
    print_status "Bun $("$BUN_BIN" --version) at $BUN_BIN"
elif BUN_BIN="$(install_private_bun)"; then
    print_status "Bun installed for Pappardelle at $BUN_BIN"
else
    BUN_BIN=""
    print_error "No Bun >= $MIN_BUN_VERSION found, and the download failed"
    MISSING+=("bun>=$MIN_BUN_VERSION")
fi
if [[ -n "$BUN_BIN" ]]; then
    PATH="$(dirname "$BUN_BIN"):$PATH"
    export PATH
fi

# Check tmux
if command -v tmux &>/dev/null; then
    TMUX_VERSION="$(tmux -V)"
    print_status "$TMUX_VERSION installed"
    if [[ $TMUX_VERSION =~ ([0-9]+)\.([0-9]+) ]] && \
       (( BASH_REMATCH[1] < 3 || (BASH_REMATCH[1] == 3 && BASH_REMATCH[2] <= 7) )); then
        print_info "Use a tmux build with the synchronized-output fix; stable 3.7c still flickers."
        print_info "Upgrade and restart instructions: https://github.com/chardigio/pappardelle#tmux-version"
    fi
else
    print_warning "tmux not found (needed for pappardelle TUI layout)"
    print_info "Install with: brew install tmux"
fi

# Check jq
if command -v jq &>/dev/null; then
    print_status "jq installed"
else
    print_warning "jq not found (needed for hooks)"
    print_info "Install with: brew install jq"
fi

# Check git
if command -v git &>/dev/null; then
    print_status "git installed"
else
    print_error "git not found"
    MISSING+=("git")
fi

# Check yq (YAML processor - required for reading .pappardelle.yml)
if command -v yq &>/dev/null; then
    print_status "yq installed"
else
    print_error "yq not found (required for reading .pappardelle.yml)"
    print_info "Install with: brew install yq"
    MISSING+=("yq")
fi

# Check claude (Claude Code CLI)
if command -v claude &>/dev/null; then
    print_status "Claude Code installed"
else
    print_warning "Claude Code not found (needed for AI-assisted workspaces)"
    print_info "Install with: curl -fsSL https://claude.ai/install.sh | bash"
fi

# Optional: check linctl
if command -v linctl &>/dev/null; then
    print_status "linctl installed (Linear integration)"
else
    print_info "linctl not found (optional, for Linear integration)"
    print_info "Install with: brew tap raegislabs/linctl && brew install linctl"
fi

# Optional: check bd
if command -v bd &>/dev/null; then
    print_status "bd installed (Beads integration)"
else
    print_info "bd not found (optional, for Beads integration)"
    print_info "Install from: https://github.com/gastownhall/beads"
fi

# Optional: check gh
if command -v gh &>/dev/null; then
    print_status "gh CLI installed (GitHub integration)"
else
    print_info "gh CLI not found (optional, for GitHub integration)"
    print_info "Install with: brew install gh"
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo ""
    print_error "Missing critical prerequisites: ${MISSING[*]}"
    print_info "Install Bun: https://bun.sh"
    exit 1
fi

echo ""

# ============================================================================
# Clone or Update Repository
# ============================================================================

if [[ "$LOCAL_MODE" == true ]]; then
    print_status "Running from local clone: $REPO_DIR"
    print_info "Installing dependencies and building..."
    (
        cd "$REPO_DIR"
        bun install --frozen-lockfile --silent
        bun run build
    ) || {
        print_error "bun install/build failed"
        print_info "Try manually: cd $REPO_DIR && bun install --frozen-lockfile && bun run build"
        exit 1
    }
    print_status "Built successfully"
else
    # Always a fresh clone to avoid divergent history issues, built off to the
    # side so a failure keeps the current install working.
    install_repo_atomically || exit 1
fi

# ============================================================================
# Link
# ============================================================================

# Link pappardelle and idow to ~/.local/bin/
mkdir -p "$LOCAL_BIN"

# pappardelle — wrapper script with a pinned Bun runtime.
# Rendered from a template so the shim's behavior is unit-tested
# (install-shim.test.ts); the Bun binary is pinned to the one preflight
# verified rather than PATH-resolved at runtime (STA-1682).
SHIM_TEMPLATE="$REPO_DIR/scripts/pappardelle-shim-template.sh"
if [[ ! -f "$SHIM_TEMPLATE" ]]; then
    print_error "Shim template not found at $SHIM_TEMPLATE"
    exit 1
fi
CLI_JS="$REPO_DIR/dist/cli.js"
SHIM_CONTENT="$(<"$SHIM_TEMPLATE")"
SHIM_CONTENT="${SHIM_CONTENT//__BUN_BIN__/$BUN_BIN}"
SHIM_CONTENT="${SHIM_CONTENT//__CLI_JS__/$CLI_JS}"
SHIM_CONTENT="${SHIM_CONTENT//__MIN_BUN_VERSION__/$MIN_BUN_VERSION}"
printf '%s\n' "$SHIM_CONTENT" > "$LOCAL_BIN/pappardelle"
chmod +x "$LOCAL_BIN/pappardelle"
print_status "Linked 'pappardelle' command globally (Bun pinned to $BUN_BIN)"

# idow
IDOW_SRC="$REPO_DIR/scripts/idow"
if [[ -f "$IDOW_SRC" ]]; then
    if [[ -L "$LOCAL_BIN/idow" || -f "$LOCAL_BIN/idow" ]]; then
        rm "$LOCAL_BIN/idow"
    fi
    ln -s "$IDOW_SRC" "$LOCAL_BIN/idow"
    print_status "Linked idow → $LOCAL_BIN/idow"
else
    print_warning "idow script not found at $IDOW_SRC"
fi

# ============================================================================
# Install the Codex Session Hook
# ============================================================================

"$REPO_DIR/plugins/pappardelle/hooks/install-codex-hooks.sh"
"$REPO_DIR/plugins/pappardelle/hooks/install-agy-hooks.sh"

# ============================================================================
# Create Required Directories
# ============================================================================

mkdir -p "$PAPPARDELLE_DIR/claude-status"
mkdir -p "$PAPPARDELLE_DIR/repos"
mkdir -p "$PAPPARDELLE_DIR/logs"
mkdir -p "$WORKTREES_DIR"
print_status "Created directories (~/.pappardelle/, ~/.worktrees/)"

# ============================================================================
# Install Skill Scripts
# ============================================================================

install_skill_scripts() {
    local skill="$1"
    local src="$REPO_DIR/plugins/pappardelle/skills/$skill/scripts"

    if [[ ! -d "$src" ]]; then
        print_warning "$skill scripts not found at $src — /$skill skill will be non-functional"
        return
    fi

    mkdir -p "$PAPPARDELLE_DIR/scripts/$skill"
    for script in "$src"/*.sh; do
        [[ -f "$script" ]] || continue
        cp "$script" "$PAPPARDELLE_DIR/scripts/$skill/"
        chmod +x "$PAPPARDELLE_DIR/scripts/$skill/$(basename "$script")"
    done
    print_status "Installed $skill scripts to $PAPPARDELLE_DIR/scripts/$skill/"
}

install_skill_scripts sous-chef
install_skill_scripts init-pappardelle

# ============================================================================
# Install the Claude Code Plugin
# ============================================================================

if ! "$BUN_BIN" "$CLI_JS" plugin install; then
    print_warning "Could not install the Pappardelle Claude Code plugin (skills and hooks)"
    print_info "Retry with: pappardelle plugin install"
fi

# ============================================================================
# Check PATH
# ============================================================================

echo ""
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
    print_warning "$LOCAL_BIN is not in your PATH"
    echo ""
    print_info "Add this to your shell profile (~/.zshrc or ~/.bash_profile):"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    print_info "Then reload: source ~/.zshrc"
    echo ""
fi

# ============================================================================
# Done
# ============================================================================

echo ""
print_status "Installation complete!"
echo ""
echo "Commands available:"
echo ""
echo -e "  ${BOLD}pappardelle${NC}           Launch the workspace TUI"
echo ""
echo "Example:"
echo ""
echo "  pappardelle"
echo ""
echo "Configuration:"
echo "  Add a .pappardelle.yml to your repo root."
echo "  See https://github.com/chardigio/pappardelle for the configuration schema."
echo ""
