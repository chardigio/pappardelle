#!/bin/bash
# Install Pappardelle hooks for agent status tracking (Claude Code + Codex)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$HOME/.pappardelle/hooks"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"

echo "Installing Pappardelle hooks..."

# Create hooks directory
mkdir -p "$HOOKS_DIR"

# Copy hook scripts
cp "$SCRIPT_DIR/update-agent-status.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/update-agent-status.py"
# Back-compat shim for settings.json files still naming the pre-STA-1850 hook.
# Safe to drop once every install has been re-run against this script.
cp "$SCRIPT_DIR/update-status.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/update-status.py"
cp "$SCRIPT_DIR/comment-question-answered.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/comment-question-answered.py"
cp "$SCRIPT_DIR/zap-notification.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/zap-notification.py"

# Copy helper modules (imported by hook scripts above)
cp "$SCRIPT_DIR/markdown_to_adf.py" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/acli_helpers.py" "$HOOKS_DIR/"

echo "Hook scripts installed to $HOOKS_DIR/"

# --- Claude Code ------------------------------------------------------------
if [ -f "$CLAUDE_SETTINGS" ]; then
    echo ""
    echo "Claude settings file already exists at $CLAUDE_SETTINGS"
    echo "Please manually merge the hooks configuration from:"
    echo "  $SCRIPT_DIR/settings.json.example"
    echo ""
    echo "Or backup your settings and run:"
    echo "  cp $CLAUDE_SETTINGS $CLAUDE_SETTINGS.backup"
    echo "  # Then manually add the hooks configuration"
else
    echo ""
    echo "No Claude settings file found."
    echo "Creating settings with Pappardelle hooks..."
    mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
    cp "$SCRIPT_DIR/settings.json.example" "$CLAUDE_SETTINGS"
    echo "Created $CLAUDE_SETTINGS with Pappardelle hooks"
fi

# --- Codex ------------------------------------------------------------------
# Only wired up when Codex is actually present: creating ~/.codex/hooks.json on
# a machine with no Codex install would be litter.
if command -v codex > /dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
    if [ -f "$CODEX_HOOKS" ]; then
        echo ""
        echo "Codex hooks file already exists at $CODEX_HOOKS"
        echo "Please manually merge the hooks configuration from:"
        echo "  $SCRIPT_DIR/codex-hooks.json.example"
    else
        echo ""
        echo "Creating Codex hooks config..."
        mkdir -p "$(dirname "$CODEX_HOOKS")"
        cp "$SCRIPT_DIR/codex-hooks.json.example" "$CODEX_HOOKS"
        echo "Created $CODEX_HOOKS with Pappardelle hooks"
    fi
else
    echo ""
    echo "Codex not detected — skipping Codex hook install."
    echo "Install Codex, then re-run this script (or copy"
    echo "  $SCRIPT_DIR/codex-hooks.json.example → ~/.codex/hooks.json)."
fi

# Create status and metadata directories
mkdir -p "$HOME/.pappardelle/agent-status"
mkdir -p "$HOME/.pappardelle/repos"

echo ""
echo "Installation complete!"
echo ""
echo "Pappardelle will now track agent status for workspaces."
echo "Run 'pappardelle' to launch the TUI."
