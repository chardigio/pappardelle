# Pappardelle

Pappardelle is a powerful, configurable tool for managing multiple development workspaces at once with Claude Code, git worktrees, and tmux.

Pappardelle orchestrates the full lifecycle of a coding task: you type a description, and it creates an issue, git worktree, PR/MR, and a Claude Code session — all wired together in a 3-pane tmux layout you can navigate with simple keystrokes.

---

## Table of Contents

1. [Installation and Getting Started](#1-installation-and-getting-started)
2. [Understanding tmux in Pappardelle](#2-understanding-tmux-in-pappardelle)
3. [Spawning New Sessions](#3-spawning-new-sessions)
4. [Customizing Your Configuration](#4-customizing-your-configuration)
5. [Advanced: Wrangling Multi-Repo Changes](#5-advanced-wrangling-multi-repo-changes)
6. [Advanced: Pappardelle on the Go](#6-advanced-pappardelle-on-the-go)
7. [Reference](#7-reference)

---

## 1. Installation and Getting Started

### Prerequisites

| Tool                                                                   | Required | Install                                                            |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Node.js >= 18                                                          | Yes      | `brew install node`                                                |
| npm                                                                    | Yes      | Comes with Node.js                                                 |
| git                                                                    | Yes      | `brew install git`                                                 |
| tmux                                                                   | Yes      | `brew install tmux`                                                |
| jq                                                                     | Yes      | `brew install jq`                                                  |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) | Yes      | `curl -fsSL https://claude.ai/install.sh \| bash`                  |
| [linctl](https://github.com/raegislabs/linctl)                         | Optional | `brew tap raegislabs/linctl && brew install linctl` (for Linear)   |
| [gh](https://cli.github.com/)                                          | Optional | `brew install gh` (for GitHub)                                     |
| [glab](https://gitlab.com/gitlab-org/cli)                              | Optional | `brew install glab` (for GitLab)                                   |
| [acli](https://developer.atlassian.com/)                               | Optional | `brew tap atlassian/homebrew-acli && brew install acli` (for Jira) |

### Install

**One-line install** (clones to `~/.pappardelle/repo/`, builds, and links globally):

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

See [Section 7: Reference](#7-reference) for alternative install methods (local clone, manual).

### First run

1. **Add a config file** to your repo root (Pappardelle won't start without one):

   ```bash
   # In your git repository root
   touch .pappardelle.yml
   ```

   See [Section 4: Customizing Your Configuration](#4-customizing-your-configuration) for the full config format. A minimal config looks like:

   ```yaml
   version: 1
   team_prefix: PROJ # your issue prefix (e.g., PROJ-123)

   claude:
     initialization_command: '/do' # skill Claude runs on each new workspace

   profiles:
     my-app:
       display_name: 'My App'
   ```

   The `/do` initialization command tells Claude to start planning, implementing, and testing the issue with care. Install a starter `/do` skill into your project with the following command:

   ```bash
   mkdir -p .claude/skills/do && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/example_skills/do/SKILL.md -o .claude/skills/do/SKILL.md
   ```

2. **Launch Pappardelle:**

   ```bash
   pappardelle
   ```

   This creates (or attaches to) a tmux session with the 3-pane layout. If you're not already inside tmux, Pappardelle creates a session and re-launches itself inside it.

### Quick reference

| Key | Action            |
| --- | ----------------- |
| `?` | Show help overlay |

---

## 2. Understanding tmux in Pappardelle

Pappardelle is built on tmux. Understanding the tmux layer will help you navigate, debug, and get the most out of the tool.

### The 3-pane layout

When you launch `pappardelle`, it creates a tmux session (named `pappardelle`) with three panes:

![Screenshot 2026-03-02 at 4.18.44 PM](assets/Screenshot%202026-03-02%20at%204.18.44%E2%80%AFPM.png)

- **Left pane** shows the space list view. This is where you navigate workspaces, create new ones, and trigger actions.
- **Center pane** shows the Claude Code session for whichever workspace is highlighted. Pressing `Enter` focuses this pane so you can interact with Claude directly.
- **Right pane** shows lazygit for the highlighted workspace's worktree.

### How nested sessions work

Each workspace creates two independent tmux sessions:

- `claude-{repo}-{issue-key}` — runs Claude Code
- `lazygit-{repo}-{issue-key}` — runs lazygit

The center and right panes in the Pappardelle session are "viewers" — they run nested tmux clients that attach to these independent sessions. When you highlight a different workspace in the list, Pappardelle uses `tmux switch-client` to instantly swap which session the viewer pane displays.

This means:

- **Workspaces are independent.** Each Claude session runs in its own tmux session. If Pappardelle crashes, your Claude sessions keep running.
- **Attach from anywhere.** You can attach to any workspace's Claude session from a separate terminal: `tmux attach -t claude-stardust-labs-STA-631`.
- **Switching is instant.** After the first attachment, switching between workspaces uses tmux's fast `switch-client` path — no process restart, no visible flash.

### Recommended tmux config

Pappardelle works with any tmux configuration, but these settings improve the experience. Add them to `~/.tmux.conf`:

```bash
# Mouse support — click panes, drag to resize, scroll to browse history
set -g mouse on

# Focus events — enables dim-on-unfocus hooks (helps distinguish active pane)
set -g focus-events on

# Dim unfocused panes when the terminal loses focus
set-hook -g client-focus-out 'set window-style fg=colour245; set window-active-style fg=colour245'
set-hook -g client-focus-in 'set -u window-style; set -u window-active-style'

# Navigate between panes with Ctrl+arrow keys (no prefix needed)
bind -n C-Left select-pane -L
bind -n C-Right select-pane -R
bind -n C-Up select-pane -U
bind -n C-Down select-pane -D

# Mouse scroll — enter copy mode on scroll up, passthrough on scroll down
bind -n WheelUpPane if-shell -F -t = "#{mouse_any_flag}" \
  "send-keys -M" "copy-mode -e; send-keys -M"
bind -n WheelDownPane send-keys -M

# Clean status bar — just show the session name
set -g status-style 'bg=colour235,fg=colour255'
set -g status-left-length 100
set -g status-left '#{?client_prefix,#[bg=colour208]#[fg=colour0] ^B ,#[bg=colour39]#[fg=colour0] #S }'
set -g window-status-format ''
set -g window-status-current-format ''
set -g status-right ''
```

### Exiting Pappardelle

Press `q` in the workspace list pane to quit. This kills the Pappardelle tmux session and all its viewer panes, returning you to your original terminal. Your Claude and lazygit workspace sessions are **not** affected — they run in independent tmux sessions and will keep going after Pappardelle exits. To reattach, just run `pappardelle` again.

To also kill all workspace sessions, use `Delete` on each workspace from the TUI before quitting, or nuke everything with:

```bash
tmux kill-server
```

---

## 3. Spawning New Sessions

### From the TUI

TODO: IMAGE

Press `n` in the workspace list to open the prompt dialog. You can enter:

| Input                                          | What happens                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| A description (e.g., `"add playlist shuffle"`) | Creates a new issue, worktree, PR, and Claude session                         |
| An issue key (e.g., `STA-123`)                 | Fetches the existing issue and creates a workspace for it                     |
| A bare number (e.g., `123`)                    | Prepends the global `team_prefix` from `.pappardelle.yml` (becomes `STA-123`) |

You can also create workspaces from the command line — see [Section 7: Reference](#creating-workspaces-from-the-command-line).

### What gets provisioned

When you create a workspace, Pappardelle runs through these steps:

1. **Profile selection** — Your input is keyword-matched against profiles in `.pappardelle.yml`. If one profile matches, it's auto-selected. If multiple match, you're prompted to choose. If none match, the `default_profile` is used.

2. **Issue creation/fetch** — For new descriptions, a Linear (or Jira) issue is created with a WIP title. For existing issue keys, the issue is fetched.

3. **Git worktree** — An isolated worktree is created at `~/.worktrees/{repo-name}/{issue-key}/`. This is a full working copy of your repo on a new branch, completely isolated from your main checkout.

4. **PR/MR creation** — A placeholder pull request (GitHub) or merge request (GitLab) is created from the new branch.

5. **Project setup** — Profile `commands` are executed (e.g., `xcodegen generate`, dependency installs). Top-level `post_worktree_init` commands also run after the worktree is created (e.g., copying `.env` files).

6. **Claude & lazygit sessions spawned** — A named tmux session is created and Claude Code is launched inside it. If `claude.initialization_command` is set in `.pappardelle.yml` (e.g., `/do`), that command is passed to Claude along with the issue key. A lazygit session rooted at the worktree dir is also spawned.

---

## 4. Customizing Your Configuration

Pappardelle is configured via a `.pappardelle.yml` file at your git repository root. This file is **required** — Pappardelle won't start without it.
### Profiles

Profiles define per-project-type configuration. When you create a workspace, Pappardelle matches your input text against each profile's `keywords` array. If one profile matches, it's selected automatically. If multiple match or none match, you're prompted.

**Profile fields:**

| Field          | Type                   | Description                                                             |
| -------------- | ---------------------- | ----------------------------------------------------------------------- |
| `keywords`     | `string[]`             | Words that trigger auto-selection of this profile                       |
| `display_name` | `string`               | Human-readable name shown in the profile picker                         |
| `team_prefix`  | `string`               | Override the global team prefix for new issues                          |
| `vars`         | `Record<string, string>` | Key-value pairs that become template variables (e.g., `IOS_APP_DIR`)  |
| `vcs`          | `object`               | VCS label config (`label` — applied to PRs/MRs)                        |
| `links`        | `array`                | URLs to open with `o` key (supports `if_set` for conditional inclusion) |
| `apps`         | `array`                | Applications to launch with `o` key                                     |
| `commands`     | `array`                | Setup commands run during workspace creation                            |

### Template variables

All string values in the config support `${VAR_NAME}` expansion:

| Variable             | Example                                 |
| -------------------- | --------------------------------------- |
| `${ISSUE_KEY}`       | `STA-631`                               |
| `${ISSUE_NUMBER}`    | `631`                                   |
| `${ISSUE_URL}`       | `https://linear.app/...`                |
| `${TITLE}`           | `Add dark mode`                         |
| `${WORKTREE_PATH}`   | `/Users/you/.worktrees/my-repo/STA-631` |
| `${REPO_ROOT}`       | `/Users/you/code/my-repo`               |
| `${REPO_NAME}`       | `my-repo`                               |
| `${PR_URL}`          | `https://github.com/.../pull/42`        |
| `${SCRIPT_DIR}`      | `/path/to/pappardelle/scripts`          |
| `${VCS_LABEL}`       | `my_app`                                |
| `${TRACKER_PROVIDER}` | `linear`                               |
| `${VCS_PROVIDER}`    | `github`                                |

Profile `vars` keys are also injected as template variables (e.g., `vars: { IOS_APP_DIR: "_ios/MyApp" }` makes `${IOS_APP_DIR}` available). Environment variables work too (e.g., `${HOME}`).

### Custom keybindings

Bind single keys to bash commands or Claude directives:

TODO: example where we create a new terminal

```yaml
keybindings:
  - key: 'b'
    name: 'Build'
    run: 'cd ${WORKTREE_PATH}/${IOS_APP_DIR} && xcodebuild build'

  - key: 't'
    name: 'Run tests'
    run: 'cd ${WORKTREE_PATH} && uv run pytest'

  - key: 'a'
    name: 'Address PR feedback'
    send_to_claude: '/address-pr-feedback'
```

- **`run`** keybindings execute in the selected workspace's worktree directory. Status is shown in the header while running.
- **`send_to_claude`** keybindings send text to the Claude pane (with Enter). Useful for invoking Claude skills.
- Custom keybindings appear in the help overlay (`?`).
- Reserved keys that can't be rebound: `j`, `k`, `g`, `i`, `d`, `o`, `n`, `e`, `p`, `q`, `?`, `Enter`, `Delete`.

### Providers

Pappardelle supports pluggable issue trackers and VCS hosts:

| Provider         | CLI Tool | Config                                                       |
| ---------------- | -------- | ------------------------------------------------------------ |
| Linear (default) | `linctl` | `issue_tracker: { provider: linear }`                        |
| Jira             | `acli`   | `issue_tracker: { provider: jira, base_url: "https://..." }` |
| GitHub (default) | `gh`     | `vcs_host: { provider: github }`                             |
| GitLab           | `glab`   | `vcs_host: { provider: gitlab }`                             |

Omit `issue_tracker` and `vcs_host` to use the defaults (Linear + GitHub).

For the full configuration reference, see [pappardelle-config.md](pappardelle-config.md).

---

## 5. Advanced: Wrangling Multi-Repo Changes

Pappardelle is designed for single-repo workflows, but (experimentally) you can extend it to orchestrate changes across multiple repositories using a parent (pappa) repo.

### The setup

Create a master repository that embeds the repos you care about as git submodules:

```
my-workspace/
├── .pappardelle.yml
├── .claude/
│   ├── settings.json         # shared settings + plugins
│   └── skills/address-mr-feedbacks/
│       └── SKILL.md          # orchestration skill (plural)
├── repo-a/                   # git submodule
├── repo-b/                   # git submodule
└── repo-c/                   # git submodule
```

The parent repo's primary purpose is to share settings, context, and orchestration skills to coordinate work across submodules.

### Spawning agents in submodules

Multi-repo work has been an achilles heel for Claude Code in the past, but I'm hoping **[Agent Teams](https://code.claude.com/docs/en/agent-teams)** can help solve this. One key unlock with agent teams is that teammates can be spawned in _separate directories_, meaning we can have a parent repo, but then spawn a repo per relevant submodule, which is nice because it automatically loads that submodule's CLAUDE.md, skills, settings, etc.

### Selective submodule fetching

Ideally not every submodule is pulled down upfront for every task. It's best to use a search tool like SourceBot's `codesearch` MCP during the planning phase to identify which submodules are relevant, then `git submodule update --init --depth 1 <submodule-path>` only those.

This helps not only keep initialization latency low, but also makes for less noise for the agent while it greps and globs.

### Plugin skills vs. parent repo skills

One key distinction for multi-repo work is between **plugin** skills and parent repo skills:

- **Plugin skills** (added in the parent repo's `settings.json` but defined elsewhere) are skills that can be used by any repo / agent teammate receives automatically. These handle single-repo concerns.

  Example: An `/address-mr-feedback` plugin that lets any agent look at its own repo's MR and address reviewer comments.

- **Parent repo skills** (in the parent repo's `.claude/skills/`) are orchestration skills that spawn agent teams across submodules.

  Example: An `/address-mr-feedbacks` (plural) skill that spins up an agent team, spawning one agent per relevant submodule — each agent calls the plugin's singular skill for its own MR.

### Example `/do` skill for multi-repo

A starter `/do` skill tailored for multi-repo workflows is available at [`example_skills/do-multi-repo/SKILL.md`](example_skills/do-multi-repo/SKILL.md). It covers submodule init, agent team spin-up, per-repo QA, and coordinated PR creation. Install it into your parent repo with:

```bash
mkdir -p .claude/skills/do && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/example_skills/do-multi-repo/SKILL.md -o .claude/skills/do/SKILL.md
```

### Useful keybindings

Bind keys to open specific submodules in your editor for quick navigation:

```yaml
keybindings:
  - key: 's'
    name: 'Open repo-a in Cursor'
    run: 'open -a "Cursor" "${WORKTREE_PATH}/repo-a" 2>/dev/null || open -a "Cursor" "${REPO_ROOT}/repo-a"'
```

Note the fallback to `${REPO_ROOT}/repo-a` here ensures this shortcut works in the `master`/`main` space.

---

## 6. Advanced: Pappardelle on the Go

Because Pappardelle runs entirely inside tmux, you can access your full workspace setup from anywhere — all you need is an SSH connection to the machine running it.

### What you need

- **[Tailscale](https://tailscale.com/)** — A mesh VPN that makes your dev machine accessible from any network without port forwarding or firewall configuration. Install on both your dev machine and your mobile device.
- **[Termius](https://termius.com/)** (iOS) — A full-featured SSH client for iPhone and iPad with good tmux support, copy/paste, and keyboard shortcuts. Other SSH clients work too (Blink Shell, Prompt 3), but Termius handles tmux rendering well.

### Setup

TODO

---

## 7. Reference

### Alternative install methods

**From a local clone:**

```bash
git clone https://github.com/chardigio/pappardelle.git
cd pappardelle
./install.sh
```

**Manual install:**

```bash
git clone https://github.com/chardigio/pappardelle.git
cd pappardelle
npm install
npm run build
npm link                # makes `pappardelle` available globally
./hooks/install.sh      # installs Claude Code hooks for status tracking
```

**Directories created by the installer:**

| Directory / File                       | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `~/.pappardelle/`                      | Config, hooks, logs, and Claude status files         |
| `~/.pappardelle/claude-status/`        | Real-time status JSON files from Claude hooks        |
| `~/.pappardelle/open-spaces.json`      | Persisted workspace registry (survives reboots)      |
| `~/.pappardelle/logs/`                 | Daily log files (7-day retention)                    |
| `~/.worktrees/`                        | Git worktrees for all your workspaces                |

### Creating workspaces from the command line

You can create workspaces without launching the TUI using the `idow` ("interactively do on worktree") command:

```bash
# Create a workspace from a description
idow "add dark mode to settings"

# Create a workspace for an existing issue
idow STA-123
```

### Claude Code hooks

Pappardelle installs three Claude Code hooks that provide integration between Claude sessions and the TUI:

| Hook                           | Trigger                             | What it does                                                                  |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------- |
| `update-status.py`             | `PreToolUse`, `PostToolUse`, `Stop` | Writes session status to `~/.pappardelle/claude-status/` for live TUI updates |
| `comment-question-answered.py` | `PostToolUse` (AskUserQuestion)     | Posts Q&A exchanges as comments on the issue (Linear or Jira)                 |
| `post-plan-to-tracker.py`      | `PostToolUse` (ExitPlanMode)        | Posts implementation plans as issue comments                                  |

### Logging

Logs are written to `~/.pappardelle/logs/` with daily rotation (7-day retention):

```bash
# View today's log
cat ~/.pappardelle/logs/pappardelle-$(date +%Y-%m-%d).log

# Tail logs in real-time
tail -f ~/.pappardelle/logs/pappardelle-*.log

# View errors only
grep '\[ERROR\]' ~/.pappardelle/logs/*.log
```

Warnings and errors also appear in a red box at the bottom of the TUI. Press `e` to view them.

### Development

```bash
npm run dev      # Watch mode (auto-rebuild on changes)
npm run build    # Build once
npm start        # Run without building
npm test         # Lint + format check + tests
```

### Dependencies

- [Ink](https://github.com/vadimdemedes/ink) — React for CLIs
- [tmux](https://github.com/tmux/tmux) — Terminal multiplexer
- [lazygit](https://github.com/jesseduffield/lazygit) — Terminal git UI
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) — AI coding assistant
