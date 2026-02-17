#!/bin/bash
# Install Pappardelle hooks for Claude Code status tracking

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$HOME/.pappardelle/hooks"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

echo "Installing Pappardelle hooks..."

# Create hooks directory
mkdir -p "$HOOKS_DIR"

# Copy hook scripts
cp "$SCRIPT_DIR/update-status.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/update-status.py"
cp "$SCRIPT_DIR/comment-question-answered.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/comment-question-answered.py"
cp "$SCRIPT_DIR/post-plan-to-tracker.py" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/post-plan-to-tracker.py"

echo "Hook scripts installed to $HOOKS_DIR/"

# Check if Claude settings exists
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

# Create status and metadata directories
mkdir -p "$HOME/.pappardelle/claude-status"
mkdir -p "$HOME/.pappardelle/issue-meta"

echo ""
echo "Installation complete!"
echo ""
echo "Pappardelle will now track Claude Code status for workspaces."
echo "Run 'pappardelle' to launch the TUI."
