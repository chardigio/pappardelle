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
# 1. Checks prerequisites (node >= 18, npm, tmux, jq)
# 2. Clones or updates chardigio/pappardelle to ~/.pappardelle/repo/
# 3. Builds and links the npm package (makes `pappardelle` available globally)
# 4. Symlinks `idow` to ~/.local/bin/
# 5. Installs Claude Code hooks for status tracking
# 6. Creates required directories (~/.worktrees/, ~/.pappardelle/claude-status/)

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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

# Check node >= 18
if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_VERSION" -ge 18 ]]; then
        print_status "Node.js v$(node --version | sed 's/v//') (>= 18 required)"
    else
        print_error "Node.js $(node --version) too old (>= 18 required)"
        MISSING+=("node>=18")
    fi
else
    print_error "Node.js not found"
    MISSING+=("node")
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
    print_status "tmux installed"
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

# Optional: check linctl
if command -v linctl &>/dev/null; then
    print_status "linctl installed (Linear integration)"
else
    print_info "linctl not found (optional, for Linear integration)"
    print_info "Install with: brew tap raegislabs/linctl && brew install linctl"
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
    print_info "Install Node.js 18+: brew install node"
    exit 1
fi

echo ""

# ============================================================================
# Clone or Update Repository
# ============================================================================

if [[ "$LOCAL_MODE" == true ]]; then
    print_status "Running from local clone: $REPO_DIR"
else
    if [[ -d "$REPO_DIR/.git" ]]; then
        print_info "Updating existing installation..."
        (cd "$REPO_DIR" && git pull --quiet) && print_status "Updated $REPO_DIR" \
            || print_warning "git pull failed, continuing with existing version"
    else
        print_info "Cloning pappardelle..."
        mkdir -p "$PAPPARDELLE_DIR"
        if git clone --quiet "$REPO_URL" "$REPO_DIR"; then
            print_status "Cloned to $REPO_DIR"
        else
            print_error "Failed to clone $REPO_URL"
            exit 1
        fi
    fi
fi

# ============================================================================
# Build and Link
# ============================================================================

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

# npm link to make `pappardelle` available globally
(cd "$REPO_DIR" && npm link --silent) && print_status "Linked 'pappardelle' command globally" \
    || print_warning "npm link failed — you may need to run: cd $REPO_DIR && sudo npm link"

# ============================================================================
# Symlink idow to ~/.local/bin/
# ============================================================================

IDOW_SRC="$REPO_DIR/scripts/idow"

if [[ -f "$IDOW_SRC" ]]; then
    mkdir -p "$LOCAL_BIN"

    # idow
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
    for hook in update-status.py comment-question-answered.py post-plan-to-tracker.py; do
        if [[ -f "$HOOKS_SRC/$hook" ]]; then
            cp "$HOOKS_SRC/$hook" "$HOOKS_DIR/"
            chmod +x "$HOOKS_DIR/$hook"
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
mkdir -p "$PAPPARDELLE_DIR/issue-meta"
mkdir -p "$PAPPARDELLE_DIR/logs"
mkdir -p "$WORKTREES_DIR"
print_status "Created directories (~/.pappardelle/, ~/.worktrees/)"

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
echo "  ${BOLD}pappardelle${NC}           Launch the workspace TUI"
echo "  ${BOLD}idow${NC} <prompt>         Create a workspace from a prompt or issue key"
echo ""
echo "Examples:"
echo ""
echo "  pappardelle"
echo "  idow add dark mode to settings"
echo "  idow STA-123"
echo ""
echo "Configuration:"
echo "  Add a .pappardelle.yml to your repo root."
echo "  See https://github.com/chardigio/pappardelle for the configuration schema."
echo ""
