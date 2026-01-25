# Pappardelle

Interactive Terminal UI for managing DOW (Day of Work) workspaces.

## Features

- **Workspace Grid**: Displays aerospace workspaces as cards in a responsive grid
- **Linear Integration**: Shows Linear issue key, title, and status for each workspace
- **App Icons**: Displays icons for open applications in each workspace
- **Claude Status**: Real-time Claude Code status tracking (thinking, working, waiting, done)
- **Quick Navigation**: Arrow key navigation with Enter to switch workspaces
- **New Sessions**: Create new DOW sessions with the "+" button

## Installation

```bash
# From the pappardelle directory
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
├── logger.ts            # Centralized logging system
├── aerospace.ts         # Aerospace CLI integration
├── linear.ts            # Linear (linctl) integration
├── claude-status.ts     # Claude status file management
└── components/
    ├── WorkspaceCard.tsx    # Individual workspace card
    ├── NewWorkspaceCard.tsx # "+" button card
    ├── PromptDialog.tsx     # New session prompt dialog
    └── ErrorDisplay.tsx     # Error notification display

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

## Linear Q&A Comments

When Claude asks clarifying questions using `AskUserQuestion` and the user answers them, a hook automatically posts a comment to the corresponding Linear issue. This creates a permanent record of the Q&A session.

### How It Works

1. Claude uses the `AskUserQuestion` tool to ask questions
2. The user selects answers from the provided options
3. The `PostToolUse` hook for `AskUserQuestion` is triggered
4. The hook extracts the Linear issue key from the workspace path (e.g., `STA-123`)
5. A formatted markdown comment is posted to the Linear issue via `linctl`

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

- The workspace must be in a path containing a Linear issue key (e.g., `~/.worktrees/stardust-labs/STA-123/`)
- `linctl` must be installed and authenticated

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

## Dependencies

- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [aerospace](https://github.com/nikitabobko/AeroSpace) - Tiling window manager
- [linctl](https://github.com/raegislabs/linctl) - Linear CLI

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run
npm start
```
