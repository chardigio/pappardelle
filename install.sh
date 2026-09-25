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
# 1. Checks prerequisites (node >= 22, npm, tmux, jq)
# 2. Clones or updates chardigio/pappardelle to ~/.pappardelle/repo/
# 3. Builds and links the npm package (makes `pappardelle` available globally)
# 4. Symlinks `idow` to ~/.local/bin/
# 5. Installs Claude Code hooks for status tracking
# 6. Creates required directories (~/.worktrees/, ~/.pappardelle/claude-status/)
# 7. Installs skill helper scripts to ~/.pappardelle/scripts/

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
# Single source of the Node floor: enforced by the preflight below AND baked
# into the pappardelle shim's runtime guard. node-engine-compat.test.ts fails
# if this drifts from engines.node in package.json or the README badge.
MIN_NODE_MAJOR=22
# A private Node for Pappardelle only, used when the machine has no Node that
# meets the floor. It never touches the system Node, nvm, Homebrew, or PATH.
PRIVATE_NODE_DIR="$PAPPARDELLE_DIR/node"
NODE_DIST_URL="${PAPPARDELLE_NODE_DIST_URL:-https://nodejs.org/dist/latest-v${MIN_NODE_MAJOR}.x}"
REPO_URL="${PAPPARDELLE_REPO_URL:-$REPO_URL}"

# Prints the major version of the node at $1, or nothing if it cannot run.
node_major() {
    local major
    major="$("$1" -p 'parseInt(process.versions.node, 10)' 2>/dev/null)" || return 0
    printf '%s' "${major//[^0-9]/}"
}

# Prints the first node that meets the floor, in the order that best matches
# what will run Pappardelle: the node the TUI runs on (passed by the `U`
# update as PAPPARDELLE_NODE), then PATH, then any version nvm has installed,
# then a private node from an earlier install. PATH alone is not enough: `U`
# runs the installer from the tmux server's environment, where PATH can serve
# an old system node while a newer one sits unused under nvm (STA-1682).
find_node() {
    local candidates=() candidate major
    [[ -n "${PAPPARDELLE_NODE:-}" ]] && candidates+=("$PAPPARDELLE_NODE")
    candidate="$(command -v node 2>/dev/null || true)"
    [[ -n "$candidate" ]] && candidates+=("$candidate")
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    if [[ -d "$nvm_dir/versions/node" ]]; then
        while IFS= read -r candidate; do
            candidates+=("$candidate")
        done < <(find "$nvm_dir/versions/node" -mindepth 3 -maxdepth 3 -path '*/bin/node' 2>/dev/null | sort -Vr)
    fi
    candidates+=("$PRIVATE_NODE_DIR/current/bin/node")

    for candidate in "${candidates[@]}"; do
        [[ -x "$candidate" ]] || continue
        major="$(node_major "$candidate")"
        if [[ -n "$major" && "$major" -ge "$MIN_NODE_MAJOR" ]]; then
            # Resolve through nvm/volta shims and symlinks so the shim can pin
            # the real binary.
            "$candidate" -p 'process.execPath' 2>/dev/null || printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# Downloads the latest official Node $MIN_NODE_MAJOR build into
# $PRIVATE_NODE_DIR, verifies it against the release's SHASUMS256.txt, and
# prints the path of its node binary. $PRIVATE_NODE_DIR/current is swapped
# only after the checksum passes, so a failed download leaves any earlier
# private node in place.
install_private_node() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) print_error "No official Node build for $(uname -s)" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        arm64 | aarch64) arch=arm64 ;;
        x86_64 | amd64) arch=x64 ;;
        *) print_error "No official Node build for $(uname -m)" >&2; return 1 ;;
    esac

    local tmp sums line expected tarball actual
    tmp="$(mktemp -d)"
    if ! sums="$(curl -fsSL "$NODE_DIST_URL/SHASUMS256.txt")"; then
        print_error "Could not download the Node checksums from $NODE_DIST_URL" >&2
        rm -rf "$tmp"; return 1
    fi
    line="$(grep -E "  node-v[0-9.]+-${os}-${arch}\.tar\.gz$" <<<"$sums" | head -1)"
    if [[ -z "$line" ]]; then
        print_error "No Node $MIN_NODE_MAJOR build for ${os}-${arch} at $NODE_DIST_URL" >&2
        rm -rf "$tmp"; return 1
    fi
    expected="${line%% *}"
    tarball="${line##* }"

    print_info "Downloading $tarball for Pappardelle into $PRIVATE_NODE_DIR (your own Node is not changed)" >&2
    if ! curl -fsSL "$NODE_DIST_URL/$tarball" -o "$tmp/$tarball"; then
        print_error "Could not download $NODE_DIST_URL/$tarball" >&2
        rm -rf "$tmp"; return 1
    fi
    if command -v shasum &>/dev/null; then
        actual="$(shasum -a 256 "$tmp/$tarball" | cut -d' ' -f1)"
    else
        actual="$(sha256sum "$tmp/$tarball" | cut -d' ' -f1)"
    fi
    if [[ "$actual" != "$expected" ]]; then
        print_error "Checksum mismatch for $tarball; not installing it" >&2
        rm -rf "$tmp"; return 1
    fi

    local name="${tarball%.tar.gz}"
    mkdir -p "$PRIVATE_NODE_DIR"
    rm -rf "${PRIVATE_NODE_DIR:?}/$name"
    tar -xzf "$tmp/$tarball" -C "$PRIVATE_NODE_DIR"
    rm -rf "$tmp"
    ln -sfn "$name" "$PRIVATE_NODE_DIR/current"
    printf '%s\n' "$PRIVATE_NODE_DIR/current/bin/node"
}

# Clones and builds into a staging folder next to $REPO_DIR, and moves it into
# place only after the build succeeds. The shim runs $REPO_DIR/dist/cli.js, so
# deleting $REPO_DIR first (as the installer used to) left no working
# Pappardelle when the clone or `npm install` failed. The replaced install is
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
    if ! (cd "$stage/repo" && npm install --silent && npm run build --silent); then
        print_error "npm install/build failed; your current install is unchanged"
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

# Tests source this file to call the functions above without running the
# installer.
if [[ "${PAPPARDELLE_INSTALL_SOURCE_ONLY:-}" == 1 ]]; then
    # shellcheck disable=SC2317 # exit is reached only when not sourced
    return 0 2>/dev/null || exit 0
fi

# Determine if running from a local clone (the repo already)
# When run via `curl | bash`, BASH_SOURCE[0] is empty so SCRIPT_DIR becomes ""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
LOCAL_MODE=false
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/package.json" ]] && \
   grep -q '"name".*"pappardelle"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    # We're running from within the pappardelle repo
    LOCAL_MODE=true
    REPO_DIR="$SCRIPT_DIR"
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

# Check node >= MIN_NODE_MAJOR. The shim pins the node found here, because
# PATH at runtime is NOT PATH at install time (STA-1682). When no node meets
# the floor, install a private one so a `U` update needs no manual steps.
NODE_BIN=""
if NODE_BIN="$(find_node)"; then
    print_status "Node.js $("$NODE_BIN" --version) at $NODE_BIN (>= $MIN_NODE_MAJOR required)"
elif NODE_BIN="$(install_private_node)"; then
    print_status "Node.js $("$NODE_BIN" --version) installed for Pappardelle at $NODE_BIN"
else
    NODE_BIN=""
    print_error "No Node.js >= $MIN_NODE_MAJOR found, and the download failed"
    MISSING+=("node>=$MIN_NODE_MAJOR")
fi
# Build with the npm that ships next to the chosen node.
if [[ -n "$NODE_BIN" ]]; then
    PATH="$(dirname "$NODE_BIN"):$PATH"
    export PATH
fi

# Check npm
if command -v npm &>/dev/null; then
    print_status "npm $(npm --version)"
else
    print_error "npm not found"
    MISSING+=("npm")
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
    print_info "Install Node.js 22+: brew install node"
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
        npm install --silent
        npm run build --silent
    ) || {
        print_error "npm install/build failed"
        print_info "Try manually: cd $REPO_DIR && npm install && npm run build"
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

# pappardelle — wrapper script instead of npm link (avoids Volta shim issues).
# Rendered from a template so the shim's behavior is unit-tested
# (install-shim.test.ts); the node binary is pinned to the one preflight
# verified rather than PATH-resolved at runtime (STA-1682).
SHIM_TEMPLATE="$REPO_DIR/scripts/pappardelle-shim-template.sh"
if [[ ! -f "$SHIM_TEMPLATE" ]]; then
    print_error "Shim template not found at $SHIM_TEMPLATE"
    exit 1
fi
CLI_JS="$REPO_DIR/dist/cli.js"
SHIM_CONTENT="$(<"$SHIM_TEMPLATE")"
SHIM_CONTENT="${SHIM_CONTENT//__NODE_BIN__/$NODE_BIN}"
SHIM_CONTENT="${SHIM_CONTENT//__CLI_JS__/$CLI_JS}"
SHIM_CONTENT="${SHIM_CONTENT//__MIN_NODE_MAJOR__/$MIN_NODE_MAJOR}"
printf '%s\n' "$SHIM_CONTENT" > "$LOCAL_BIN/pappardelle"
chmod +x "$LOCAL_BIN/pappardelle"
print_status "Linked 'pappardelle' command globally (node pinned to $NODE_BIN)"

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
# Install Claude Code Hooks
# ============================================================================

HOOKS_DIR="$PAPPARDELLE_DIR/hooks"
HOOKS_SRC="$REPO_DIR/hooks"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

if [[ -d "$HOOKS_SRC" ]]; then
    mkdir -p "$HOOKS_DIR"

    # Copy hook scripts
    for hook in update-status.py comment-question-answered.py zap-notification.py; do
        if [[ -f "$HOOKS_SRC/$hook" ]]; then
            cp "$HOOKS_SRC/$hook" "$HOOKS_DIR/"
            chmod +x "$HOOKS_DIR/$hook"
        fi
    done

    # Helper modules imported by the hooks above
    for module in markdown_to_adf.py acli_helpers.py tracker_config.py; do
        if [[ -f "$HOOKS_SRC/$module" ]]; then
            cp "$HOOKS_SRC/$module" "$HOOKS_DIR/"
        fi
    done
    print_status "Installed Claude Code hooks to $HOOKS_DIR/"

    # Show instructions for Claude settings
    if [[ -f "$CLAUDE_SETTINGS" ]]; then
        print_info "Claude settings exists at $CLAUDE_SETTINGS"
        print_info "Merge hooks config from: $HOOKS_SRC/settings.json.example"
    else
        if [[ -f "$HOOKS_SRC/settings.json.example" ]]; then
            mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
            cp "$HOOKS_SRC/settings.json.example" "$CLAUDE_SETTINGS"
            print_status "Created $CLAUDE_SETTINGS with Pappardelle hooks"
        fi
    fi
else
    print_warning "Hooks directory not found at $HOOKS_SRC"
fi

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
