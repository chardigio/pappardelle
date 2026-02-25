# Pappardelle

Interactive Terminal UI for managing DOW (Do on Worktree) workspaces.

## Features

- **3-Pane Layout**: Workspace list, Claude Code viewer, and lazygit viewer side-by-side in tmux
- **Issue Tracker Integration**: Shows issue key, title, and status (Linear or Jira)
- **Claude Status**: Real-time Claude Code status tracking with animated spinner, attention-blinking rows, and per-tool status icons
- **Quick Navigation**: Vim-style `j`/`k` and arrow key navigation with instant pane switching
- **Workspace Provisioning**: Create full workspaces (worktree, PR, Xcode project, Claude session) from a prompt
- **Quick Actions**: Open PRs, issues, and IDE from keybindings (`g`, `i`, `d`)
- **Mouse Support**: Click workspace rows to select
- **Provider Agnostic**: Pluggable issue tracker (Linear, Jira) and VCS host (GitHub, GitLab)

## How It Works

Pappardelle orchestrates isolated development workspaces using tmux, git worktrees, and Claude Code. Here's the end-to-end flow:

### 1. Launch

Running `pappardelle` creates (or attaches to) a tmux session with a 3-pane layout:

- **Left** — workspace list (the TUI itself)
- **Center** — Claude Code viewer (shows the selected workspace's Claude session)
- **Right** — lazygit viewer (shows the selected workspace's git state)

If you're not already in tmux, pappardelle auto-creates a session and re-launches inside it. When running inside iTerm2, it uses `tmux -CC` control mode for native split panes with mouse resize and macOS copy/paste.

### 2. Create a Workspace

Press `n` to open the prompt dialog. You can enter:

- A **free-text description** (e.g., `"add dark mode to settings"`) — creates a new issue
- An **issue key** (e.g., `STA-123`) — uses an existing issue
- A **bare number** (e.g., `123`) — prepends the global `team_prefix` from `.pappardelle.yml` (profile-level prefixes are only used for new issue creation, not bare-number expansion)

This triggers `idow`, which provisions the entire workspace:

1. **Profile selection** — keyword-matches your input against profiles in `.pappardelle.yml` to determine project-specific config (iOS settings, GitHub labels, apps to open)
2. **Issue creation/fetch** — creates a new issue in your tracker (Linear or Jira) or fetches an existing one
3. **Title generation** — for new issues, uses AI to derive a concise title from the description
4. **Git worktree** — creates an isolated worktree at `~/.worktrees/{repo}/{issue-key}/`
5. **PR/MR creation** — opens a placeholder pull request (GitHub) or merge request (GitLab)
6. **Xcode project** — if the profile has an `ios` block (with `app_dir`, `bundle_id`, `scheme`), runs `xcodegen generate` and creates a `Local.xcconfig` with worktree-specific port settings. See [pappardelle-config.md](pappardelle-config.md) for profile `ios` configuration.
7. **Claude session** — starts a named tmux session (`claude-{repo}-{issue-key}`) with Claude Code. If `claude.initialization_command` is set in `.pappardelle.yml` (e.g., `"/idow"`), that command is passed to Claude along with the issue key; otherwise Claude opens with just the issue key.

With the `--open` flag (or pressing `o` in the TUI), additional steps run: opens iTerm2 with Claude, launches configured apps (Cursor, Xcode, etc.), opens the issue and PR URLs in the browser, and clones a QA iOS simulator in the background.

### 3. Navigate Between Workspaces

Use `↑`/`↓` (or `j`/`k`) to move through the workspace list. Highlighting a row instantly switches the Claude and lazygit viewer panes to that workspace's sessions — no restart or re-attach needed. Press `Enter` to focus the Claude pane for direct interaction.

### 4. Real-Time Status Tracking

Claude Code hooks report session status back to the TUI in real time:

1. Claude Code lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, etc.) trigger `update-status.py`
2. The hook writes a JSON status file to `~/.pappardelle/claude-status/{workspace}.json`
3. The TUI watches this directory with a filesystem watcher and updates the status icon instantly

Status icons show at a glance whether Claude is working (animated spinner), waiting for input (`●`), needs permission (`!`), or is done (`●`). See the [Status Values](#status-values) table below for the full list.

### 5. Closing Workspaces

Press `Delete` on a workspace to tear it down. This kills the Claude and lazygit tmux sessions and removes the workspace from the list. The git worktree and any committed work remain intact on disk.

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

| Key   | Action                        |
| ----- | ----------------------------- |
| j / ↓ | Move down                     |
| k / ↑ | Move up                       |
| Enter | Focus Claude pane             |
| g     | Open PR / MR in browser       |
| i     | Open issue in browser         |
| d     | Open IDE (Cursor)             |
| n     | New space                     |
| o     | Open workspace (apps, links)  |
| Del   | Close space                   |
| r     | Refresh list                  |
| e     | Show errors                   |
| ?     | Show help                     |

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
├── simctl-check.ts      # iOS simulator availability check
├── space-utils.ts       # Space data utility helpers
├── spawn-env.ts         # Spawned process environment setup
├── session-routing.ts   # Session routing logic
├── layout-sizing.ts     # Layout calculations
├── list-view-sizing.ts  # List view sizing calculations
├── use-mouse.ts         # Mouse input handling
├── providers/
│   ├── types.ts             # Provider interfaces (IssueTrackerProvider, VcsHostProvider)
│   ├── index.ts             # Provider factory (createIssueTracker, createVcsHost)
│   ├── linear-provider.ts   # Linear provider (linctl)
│   ├── jira-provider.ts     # Jira provider (acli)
│   ├── github-provider.ts   # GitHub provider (gh)
│   └── gitlab-provider.ts   # GitLab provider (glab)
└── components/
    ├── SpaceListItem.tsx    # Individual space list item
    ├── PromptDialog.tsx     # New session prompt dialog
    ├── ConfirmDialog.tsx    # Confirmation dialog
    ├── ErrorDialog.tsx      # Error dialog
    ├── ErrorDisplay.tsx     # Error notification display
    ├── HelpOverlay.tsx      # Help overlay
    └── ClaudeAnimation.tsx  # Claude status animation

scripts/                         # Workspace setup scripts
├── idow                         # Interactive workspace setup
├── start-claude-session.sh      # Claude + lazygit tmux session launcher
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
└── yabai-position.sh            # Yabai window positioning

hooks/
├── update-status.py             # Status tracking hook
├── comment-question-answered.py # Issue tracker Q&A comment hook
├── post-plan-to-tracker.py      # Plan posting hook
├── settings.json.example        # Example Claude settings
└── install.sh                   # Hook installation script
```

## Claude Status Tracking

The TUI tracks Claude Code session status through file-based hooks:

1. Claude Code hooks write status to `~/.pappardelle/claude-status/<workspace>.json`
2. The TUI watches this directory for changes
3. Status is displayed in real-time on workspace cards

### Status Values

| Status     | Icon          | Description                          |
| ---------- | ------------- | ------------------------------------ |
| Working    | ·✢✳∗✻✽       | Animated spinner while processing    |
| Waiting    | ● (green)     | Claude needs user input              |
| Permission | ! (red)       | Claude needs permission approval     |
| Question   | ? (blue)      | Claude asked a clarifying question   |
| Compacting | ◇ (yellow)    | Context window compacting            |
| Done       | ● (green)     | Claude finished the task             |
| Error      | ✗ (red)       | An error occurred                    |
| Unknown    | ? (gray)      | No status available                  |

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
