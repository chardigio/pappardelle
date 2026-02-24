# Pappardelle

Interactive Terminal UI for managing DOW (Do on Worktree) workspaces.

## Features

- **Workspace Grid**: Displays aerospace workspaces as cards in a responsive grid
- **Issue Tracker Integration**: Shows issue key, title, and status (Linear or Jira)
- **App Icons**: Displays icons for open applications in each workspace
- **Claude Status**: Real-time Claude Code status tracking (thinking, working, waiting, done)
- **Quick Navigation**: Arrow key navigation with Enter to switch workspaces
- **New Sessions**: Create new DOW sessions with the "+" button

## Installation

**One-line install:**

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

This installs the `pappardelle` TUI, `idow` CLI tool, and Claude Code hooks for status tracking.

**Or from a local clone:**

```bash
./install.sh
```

**Or manually:**

```bash
npm install
npm run build
npm link  # Makes pappardelle available globally

# Install Claude Code hooks for status tracking
./hooks/install.sh
```

## Usage

```bash
pappardelle
```

### Controls

| Key     | Action                                                 |
| ------- | ------------------------------------------------------ |
| ↑↓←→    | Navigate between workspaces                            |
| Enter   | Switch to selected workspace / Open new session dialog |
| r       | Refresh workspace list                                 |
| c       | Clear error messages                                   |
| q / Esc | Quit                                                   |

## Architecture

```
source/
├── app.tsx              # Main application component
├── cli.tsx              # CLI entry point
├── types.ts             # TypeScript types and constants
├── config.ts            # Configuration loading and parsing
├── logger.ts            # Centralized logging system
├── tmux.ts              # Tmux session management and layout
├── linear.ts            # Issue tracker facade (delegates to providers)
├── claude-status.ts     # Claude status file management
├── git-status.ts        # Git worktree status detection
├── issue-checker.ts     # VCS host facade (delegates to providers)
├── issue-utils.ts       # Issue utility helpers
├── providers/
│   ├── types.ts             # Provider interfaces (IssueTrackerProvider, VcsHostProvider)
│   ├── index.ts             # Provider factory (createIssueTracker, createVcsHost)
│   ├── linear-provider.ts   # Linear provider (linctl)
│   ├── jira-provider.ts     # Jira provider (acli)
│   ├── github-provider.ts   # GitHub provider (gh)
│   └── gitlab-provider.ts   # GitLab provider (glab)
├── session-routing.ts   # Session routing logic
├── layout-sizing.ts     # Layout calculations
├── list-view-sizing.ts  # List view sizing calculations
├── use-mouse.ts         # Mouse input handling
└── components/
    ├── SpaceListItem.tsx    # Individual space list item
    ├── PromptDialog.tsx     # New session prompt dialog
    ├── ConfirmDialog.tsx    # Confirmation dialog
    ├── ErrorDialog.tsx      # Error dialog
    ├── ErrorDisplay.tsx     # Error notification display
    ├── HelpOverlay.tsx      # Help overlay
    └── ClaudeAnimation.tsx  # Claude status animation

scripts/                         # Workspace setup scripts (dow/idow)
├── dow                          # Non-interactive workspace setup
├── idow                         # Interactive workspace setup
├── provider-helpers.sh          # Provider-agnostic helper functions
├── create-worktree.sh           # Git worktree creation
├── create-linear-issue.sh       # Linear issue creation
├── create-github-pr.sh          # GitHub PR creation
├── derive-title.sh              # Issue title generation
├── generate-xcode-project.sh    # XcodeGen project generation
├── setup-qa-simulator.sh        # iOS simulator setup
├── open-iterm-claude.sh         # iTerm + Claude session opener
├── open-cursor.sh               # Cursor editor opener
├── open-firefox-tabs.sh         # Firefox tab opener
├── organize-aerospace.sh        # AeroSpace workspace organizer
├── position-window.sh           # Window positioning
├── yabai-position.sh            # Yabai window positioning
└── test-create-worktree.sh      # Worktree creation tests

hooks/
├── update-status.py             # Status tracking hook
├── comment-question-answered.py # Linear Q&A comment hook
├── settings.json.example        # Example Claude settings
└── install.sh                   # Hook installation script
```

## Claude Status Tracking

The TUI tracks Claude Code session status through file-based hooks:

1. Claude Code hooks write status to `~/.pappardelle/claude-status/<workspace>.json`
2. The TUI watches this directory for changes
3. Status is displayed in real-time on workspace cards

### Status Values

| Status     | Icon | Description                          |
| ---------- | ---- | ------------------------------------ |
| Working    | ◐    | Claude is processing or using a tool |
| Waiting    | ?    | Claude needs user input              |
| Permission | !    | Claude needs permission approval     |
| Done       | ✓    | Claude finished the task             |
| Idle       | ○    | Session is idle                      |
| Unknown    | ?    | No status available                  |

## Issue Tracker Q&A Comments

When Claude asks clarifying questions using `AskUserQuestion` and the user answers them, a hook automatically posts a comment to the corresponding issue. This creates a permanent record of the Q&A session.

Supports both **Linear** (via `linctl`) and **Jira** (via `acli`), configured in `.pappardelle.yml`.

### How It Works

1. Claude uses the `AskUserQuestion` tool to ask questions
2. The user selects answers from the provided options
3. The `PostToolUse` hook for `AskUserQuestion` is triggered
4. The hook extracts the issue key from the workspace path (e.g., `STA-123`)
5. The hook reads `.pappardelle.yml` to determine the issue tracker provider
6. A formatted markdown comment is posted via `linctl` (Linear) or `acli` (Jira)

### Example Comment

```markdown
### Clarifying Questions Answered

**Timing**: How should the feature behave?

Options:

- Option A: Description **[Selected]**
- Option B: Another description

**Answer**: Option A

---

_Recorded at 2024-01-15 14:30:45_
```

### Requirements

- The workspace must be in a path containing an issue key (e.g., `~/.worktrees/stardust-labs/STA-123/`)
- The appropriate CLI tool must be installed and authenticated:
  - **Linear**: `linctl` (`brew tap raegislabs/linctl && brew install linctl`)
  - **Jira**: `acli` (Atlassian CLI)

## Logging

Pappardelle includes a file-based logging system for debugging and error tracking.

### Log Location

Logs are written to `~/.pappardelle/logs/` with daily rotation:

- `pappardelle-YYYY-MM-DD.log`
- Keeps last 7 days of logs

### Log Levels

| Level | Description                       |
| ----- | --------------------------------- |
| debug | Detailed diagnostic information   |
| info  | General operational events        |
| warn  | Warning conditions (shown in TUI) |
| error | Error conditions (shown in TUI)   |

### Error Display

- Warnings and errors are displayed in a red-bordered box at the bottom of the TUI
- Press `c` to clear displayed errors
- Full error history is available in log files

### View Logs

```bash
# View today's log
cat ~/.pappardelle/logs/pappardelle-$(date +%Y-%m-%d).log

# Tail logs in real-time
tail -f ~/.pappardelle/logs/pappardelle-*.log

# View errors only
grep '\[ERROR\]' ~/.pappardelle/logs/*.log
```

## Provider Configuration

Pappardelle supports pluggable issue tracker and VCS host providers, configured via `.pappardelle.yml`:

```yaml
# Issue tracker: "linear" (default) or "jira"
issue_tracker:
  provider: jira
  base_url: https://mycompany.atlassian.net

# VCS host: "github" (default) or "gitlab"
vcs_host:
  provider: gitlab
  host: gitlab.mycompany.com # optional, for self-hosted
```

Omitting these fields defaults to Linear + GitHub. See [pappardelle-config.md](pappardelle-config.md) for full configuration reference.

## Dependencies

- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [tmux](https://github.com/tmux/tmux) - Terminal multiplexer (for pane layout)
- Issue tracker CLI: [linctl](https://github.com/raegislabs/linctl) (Linear) or `acli` (Jira)
- VCS host CLI: [gh](https://cli.github.com/) (GitHub) or [glab](https://gitlab.com/gitlab-org/cli) (GitLab)

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run
npm start
```
