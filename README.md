# 🦀🍝🦀 Pappardelle 🦀🍝🦀

[![Test](https://github.com/chardigio/pappardelle/actions/workflows/test.yml/badge.svg)](https://github.com/chardigio/pappardelle/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TUI for multi-clauding without losing your marbles.

You type a description, it reads or creates an issue in Linear/Jira, spawns a git worktree, builds a PR/MR, and starts a Claude Code session alongside a lazygit session — all wired together in a 3-pane tmux layout you can navigate with simple, customizable keystrokes.

https://github.com/user-attachments/assets/42e7c234-2dd1-4e9e-a211-f2caa4d257d8

---

## Table of Contents

1. [Installation and Getting Started](#1-installation-and-getting-started)
2. [Understanding tmux in Pappardelle](#2-understanding-tmux-in-pappardelle)
3. [Spawning New Sessions](#3-spawning-new-sessions)
4. [Customizing Your Configuration](#4-customizing-your-configuration)
5. [Advanced: Doom-coding with Pappardelle](#5-advanced-doom-coding-with-pappardelle)
6. [Advanced: Wrangling Multi-Repo Changes](#6-advanced-wrangling-multi-repo-changes)
7. [Reference](#7-reference)

---

## 1. Installation and Getting Started

### Install Pappardelle

One-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

See [Section 7: Reference](#7-reference) for alternative install methods.

### Initialize your repo

Pappardelle needs a `.pappardelle.yml` config at your repo root. The fastest way to create one is with the `/init-pappardelle` skill — it checks your [prerequisites](#prerequisites), asks about your VCS host, issue tracker, and project profiles, then generates the config for you:

```bash
mkdir -p ~/.claude/skills/init-pappardelle && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/init-pappardelle/SKILL.md -o .claude/skills/init-pappardelle/SKILL.md
claude /init-pappardelle
```

For the full config format and manual setup, see the [configuration reference](pappardelle-config.md).

### Launch Pappardelle:

```bash
pappardelle
```

![Screenshot 2026-03-02 at 4.18.44 PM](assets/Screenshot%202026-03-02%20at%204.18.44%E2%80%AFPM.png)

---

## 2. Understanding tmux in Pappardelle

### The 3-pane layout

When you launch `pappardelle`, it creates a tmux session (named `pappardelle`) with three panes:

- **Left pane** shows the ticket rail. This is where you navigate workspaces, create new ones, and trigger actions.
- **Center pane** shows the Claude Code session for whichever workspace is highlighted.
- **Right pane** shows [lazygit](https://github.com/jesseduffield/lazygit) for the highlighted workspace's worktree.

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

Pappardelle works with any tmux configuration, but these settings improve the experience — mouse support, Ctrl+arrow pane navigation, and a clean status bar. See [`examples/tmux.conf`](examples/tmux.conf) and append to your `~/.tmux.conf`. If you don't have one yet:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/tmux.conf -o ~/.tmux.conf
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

Press `n` in the workspace list to open the prompt dialog.

![New session dialog](assets/new-session-dialog.png)

### What gets provisioned

When you create a workspace, Pappardelle runs through these steps:

1. **Profile selection** — Your input is keyword-matched against a profile in `.pappardelle.yml`.

2. **Issue creation/fetch** — For new descriptions, a Linear (or Jira) issue is created with a WIP title. For existing issue keys, the issue is fetched.

3. **Git worktree** — An isolated worktree is created at `~/.worktrees/{repo-name}/{issue-key}/`. This is a full working copy of your repo on a new branch, completely isolated from your main checkout.

4. **PR/MR creation** — A placeholder PR (GitHub) or MR (GitLab) is created from the new branch.

5. **Project setup** — Profile `commands` are executed (e.g., `xcodegen generate`, dependency installs). Top-level `post_worktree_init` commands also run after the worktree is created (e.g., copying `.env` files).

6. **Claude & lazygit sessions spawned** — A named tmux session is created and Claude Code is launched inside it. If `claude.initialization_command` is set in `.pappardelle.yml` (e.g., `/do`), that command is passed to Claude along with the issue key. A lazygit session rooted at the worktree dir is also spawned.

---

## 4. Customizing Your Configuration

Pappardelle is configured via a `.pappardelle.yml` file at your git repository root. This file is **required** — Pappardelle won't start without it.
### Profiles

Profiles define per-project-type configuration. When you create a workspace, Pappardelle matches your input text against each profile's `keywords` array. If one profile matches, it's selected automatically. If multiple match, the best match is used. Append `!` to a keyword to enforce that profile (e.g., `music! add playlist shuffle`).

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

```yaml
keybindings:
  - key: 'b'
    name: 'Build'
    run: 'cd ${WORKTREE_PATH}/${IOS_APP_DIR} && xcodebuild build'

  - key: 't'
    name: 'Run tests'
    run: |
      osascript -e '
        tell application "iTerm"
          create window with default profile
          tell current session of current window
            write text "cd \"${WORKTREE_PATH}\" && uv run pytest"
          end tell
        end tell'

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
| GitLab           | `glab`   | `vcs_host: { provider: gitlab, host: "gitlab.company.com" }` |

Omit `issue_tracker` and `vcs_host` to use the defaults (Linear + GitHub).

For the full configuration reference, see [pappardelle-config.md](pappardelle-config.md).

### Real-world example

For a production `.pappardelle.yml` used across a polyglot monorepo (Python backends + Swift iOS apps), see [`examples/monorepo-pappardelle.yml`](examples/monorepo-pappardelle.yml). It demonstrates profiles with iOS build commands, custom keybindings for deploying to devices and simulators, QA simulator setup, `post_worktree_init` hooks, and more.

---

## 5. Advanced: Doom-coding with Pappardelle

https://github.com/user-attachments/assets/acfacd3c-bf42-4e94-84ed-0b57781283a5

Because Pappardelle runs entirely inside tmux, you can access your full workspace setup from anywhere — all you need is an SSH connection to the machine running it.

### What you need

- **A machine that stays on** — A Mac Mini is popular for this, but your laptop works fine too — just keep it plugged in. macOS won't sleep with the lid closed as long as it has power and an active SSH session.
- **[Tailscale](https://tailscale.com/)** — A mesh VPN that makes your dev machine accessible from any network without port forwarding or firewall configuration. Install on both your dev machine and your mobile device.
- **[Termius](https://termius.com/)** (iOS) — A full-featured SSH client for iPhone and iPad with good tmux support, copy/paste, and keyboard shortcuts. Other SSH clients work too (Blink Shell, Prompt 3), but Termius handles tmux rendering well.


### Nice-to-haves

- **[ntfy](https://ntfy.sh/)** — Push notifications to your phone when Claude needs input. Pappardelle ships with a `zap-notification.py` hook that sends a push via ntfy whenever Claude asks a question or hits a permission prompt. This way you don't have to babysit the terminal — just wait for the buzz.
- **[Wispr Flow](https://wisprflow.ai/)** — Voice-to-text dictation that works system-wide, including inside Termius. Lets you talk to Claude instead of thumb-typing on a phone keyboard.

### Useful keybindings

When you're doom-coding from your phone, you want one-tap access to open the PR on the device in your hand. Bind a key that sends an ntfy notification with a clickable link:

```yaml
keybindings:
  - key: 'z'
    name: 'Zap PR'
    run: >
      PR_NUM=$(gh pr list --head ${ISSUE_KEY} --json number -q '.[0].number' 2>/dev/null);
      if [ -n "$PR_NUM" ]; then
        curl -d "${ISSUE_KEY} GitHub PR #$PR_NUM"
          -H "Click: $(gh pr list --head ${ISSUE_KEY} --json url -q '.[0].url')"
          ntfy.sh/${NTFY_TOPIC};
      fi
```

Press `z` on a workspace and your phone buzzes with a notification — tap it and the PR opens in the GitHub app.

---

## 6. Advanced: Wrangling Multi-Repo Changes

Pappardelle is designed for single-repo workflows, but (experimentally) you can extend it to orchestrate changes across multiple repositories using a parent (pappa) repo.

### The setup

Create a parent repository that serves as the orchestration hub:

```
my-workspace/
├── .pappardelle.yml
├── .claude/
│   ├── settings.json         # shared settings + plugins
│   └── skills/
│       ├── do/
│       │   └── SKILL.md      # initialization skill
│       └── address-mr-feedbacks/
│           └── SKILL.md      # orchestration skill
└── CLAUDE.md
```

The parent repo's primary purpose is to share settings, context, and orchestration skills to coordinate work across child repos. Child repos are **not** committed to the parent — they're shallow-cloned on demand during workspace setup.

### Spawning agents in child repos

Multi-repo work has been an achilles heel for Claude Code in the past, but I'm hoping **[Agent Teams](https://code.claude.com/docs/en/agent-teams)** can help solve this. One key unlock with agent teams is that teammates can be spawned in _separate directories_, meaning we can have a parent repo, but then spawn an agent per relevant child repo, which is nice because it automatically loads that repo's CLAUDE.md, skills, settings, etc.

### On-demand shallow cloning

Repos are pulled down as needed — not upfront. During the planning phase, use a search tool like SourceBot's `codesearch` MCP to identify which repos are relevant, then shallow-clone only those:

```bash
git clone --depth 1 https://github.com/org/repo-a.git
```

This keeps initialization fast and reduces noise for the agent while it greps and globs. Because we use `--depth 1`, only the latest commit is fetched — no full history.

### Plugin skills vs. parent repo skills

One key distinction for multi-repo work is between plugin skills and parent repo skills:

- **Plugin skills** (added in the parent repo's `settings.json` but defined elsewhere) are skills that can be used by any repo / agent teammate receives automatically. These handle single-repo concerns.

  Example: An `/address-mr-feedback` plugin that lets any agent look at its own repo's MR and address reviewer comments.

- **Parent repo skills** (in the parent repo's `.claude/skills/`) are orchestration skills that spawn agent teams across child repos.

  Example: An `/address-mr-feedbacks` (plural) skill that spins up an agent team, spawning one agent per relevant child repo — each agent calls the plugin's singular skill for its own MR.

### Example `/do` skill for multi-repo

A starter `/do` skill tailored for multi-repo workflows is available at [`examples/skills/do-multi-repo/SKILL.md`](examples/skills/do-multi-repo/SKILL.md). It covers shallow cloning, agent team spin-up, per-repo QA, and coordinated PR creation. Install it into your parent repo with:

```bash
mkdir -p .claude/skills/do && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/do-multi-repo/SKILL.md -o .claude/skills/do/SKILL.md
```

### Useful keybindings

Bind keys to open specific child repos in your editor for quick navigation:

```yaml
keybindings:
  - key: 's'
    name: 'Open repo-a in Cursor'
    run: 'open -a "Cursor" "${WORKTREE_PATH}/repo-a" 2>/dev/null || open -a "Cursor" "${REPO_ROOT}/repo-a"'
```

Note the fallback to `${REPO_ROOT}/repo-a` here ensures this shortcut works in the `master`/`main` space.

---

## 7. Reference

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

| Hook                           | Trigger                                       | What it does                                                                  |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `update-status.py`             | `PreToolUse`, `PostToolUse`, `Stop`           | Writes session status to `~/.pappardelle/claude-status/` for live TUI updates |
| `comment-question-answered.py` | `PostToolUse` (AskUserQuestion)               | Posts Q&A exchanges as comments on the issue (Linear or Jira)                 |
| `zap-notification.py`          | `PreToolUse`, `PermissionRequest`             | Sends push notifications via ntfy when Claude needs user input                |

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
