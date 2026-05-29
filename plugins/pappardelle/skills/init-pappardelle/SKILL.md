---
name: init-pappardelle
description: Install and initialize Pappardelle in a repository. Installs Pappardelle, checks prerequisites, asks about your VCS host, issue tracker, and project profiles, then generates a .pappardelle.yml config file.
disable-model-invocation: true
---

# /init-pappardelle — Set Up Pappardelle in This Repo

Interactive setup wizard that installs Pappardelle, gathers your configuration preferences, checks prerequisites, and generates a `.pappardelle.yml` file.

Before running any of the steps below, print the "What is a Workspace?" section verbatim so the user has a shared vocabulary before the wizard starts asking questions. This is important — the rest of the wizard uses the word "workspace" throughout.

## What is a Workspace?

A **workspace** in Pappardelle is the per-issue environment Pappardelle creates for you when you start work on a ticket. Each workspace bundles together:

- A dedicated **git worktree** at `~/.worktrees/{repo}/{issue-key}/` — an isolated checkout on a fresh branch, so you can have many in-flight tickets without stashing or switching branches.
- A tracked **issue** in your issue tracker (Linear or Jira) — Pappardelle either creates one from your prompt or uses an existing key like `STA-123`.
- A draft **PR/MR** against the main branch for that worktree.
- Its own **Claude Code session** (a named tmux session: `claude-{repo}-{issue-key}`) where you drive the work.
- Its own **lazygit session** (tmux session: `lazygit-{repo}-{issue-key}`) pointed at that worktree.

The Pappardelle TUI is a 3-pane tmux layout that lets you list, switch between, and operate on workspaces — the left pane is the list, the center attaches to the highlighted workspace's Claude session, and the right attaches to its lazygit. Workspaces run in independent tmux sessions, so they survive even if the TUI is closed or restarted.

Everything the wizard asks — providers, profiles, init command, post-init hooks — is about configuring what happens **each time a new workspace is created**.

## Step 0: Check for Existing Configuration

Before starting the wizard, check if a `.pappardelle.yml` already exists:

```bash
test -f "$(git rev-parse --show-toplevel)/.pappardelle.yml" && echo "EXISTS" || echo "NOT_FOUND"
```

If `NOT_FOUND`, skip to Step 1.

If `EXISTS`, read and parse the config file to extract the current configuration, then walk the user through personalization. Use `AskUserQuestion` for each sub-step — ask them one at a time, don't bundle questions.

### 0a. Show Current Configuration

Present a summary of the existing config:

> **Pappardelle is already configured in this repository.**
>
> **Current configuration:**
>
> - VCS Host: {provider}
> - Issue Tracker: {provider}
> - Team Prefix: {prefix}
> - Profiles:
>   - **{display_name}** — keywords: {comma-separated keywords}
>   - **{display_name}** — keywords: {comma-separated keywords}
>   - _(repeat for each profile)_

### 0b. Add a New Profile?

Ask: "Do any of the existing profiles fit your use case, or would you like to add a new one?"

- If they're happy with existing profiles, move on.
- If they want a new profile, gather the same info as Step 1c (display name, keywords, project type, commands) and add it to `.pappardelle.yml`.

### 0c. Default Profile

Ask: "Which profile should be your default? (This is the profile used when no keywords match your issue.)"

List the available profiles by name. If they pick one that differs from the current `default_profile`, write/update `.pappardelle.local.yml` with the override:

```yaml
default_profile: their-choice
```

If they pick the one that's already the default, skip writing.

### 0d. Dangerously Skip Permissions

Show the current `dangerously_skip_permissions` value and ask: "Should Claude start in 'yolo mode' — automatically approving all tool calls? (Currently: {yes/no})"

- If they want to change it, write/update `.pappardelle.local.yml` with the override:
  ```yaml
  claude:
    dangerously_skip_permissions: true # or false
  ```
- If they're happy with the current value, skip.

### 0e. Write Local Overrides

If any local overrides were collected in 0c–0d, write or update `.pappardelle.local.yml`. Preserve any existing content (e.g., `keybindings`, `issue_watchlist`) — only add/update the fields that changed.

After this, skip to Step 6 (Summary) — print a summary of what was configured and launch instructions.

## Step 1: Gather Configuration

Use `AskUserQuestion` for each of these. Ask them one at a time — don't bundle questions.

### 1a. VCS Host

Ask: "Which VCS host do you use?"

Options:

- **GitHub** (default) — requires `gh` CLI
- **GitLab** — requires `glab` CLI. If selected, follow up asking if it's gitlab.com or self-hosted (get the `host` value).
- **Other** — Pappardelle only supports GitHub and GitLab. Let the user know and stop.

### 1b. Issue Tracker

Ask: "Which issue tracker do you use?"

Options:

- **Linear** (default) — requires `linctl` CLI
- **Jira** — requires `acli` CLI. If selected, follow up asking for their Jira base URL (e.g., `https://mycompany.atlassian.net`).
- **Neither / Other** — Pappardelle requires Linear or Jira. Let the user know and stop.

### 1c. Team Prefix & Profiles

Ask: "What are your issue key prefixes? For example, if your issues look like PROJ-123, the prefix is PROJ. If you have multiple teams/projects with different prefixes (e.g., FE-123, BE-456), list them all."

**Single prefix** (e.g., they say just "PROJ"):

- Set the global `team_prefix: PROJ`
- Create one default profile with no `keywords` (it catches everything)
- Ask what kind of project it is (iOS app, backend, frontend, etc.) to generate sensible `display_name` and `commands`

**Multiple prefixes** (e.g., they say "FE for frontend, BE for backend, MOB for mobile"):

- Set the global `team_prefix` to whichever prefix they use most (ask if unclear)
- Create one profile per prefix:
  - Slug name: kebab-case of the project name (e.g., `frontend`, `backend`, `mobile`)
  - `display_name`: human-readable name they gave
  - `keywords`: include the prefix with hyphen (e.g., `["FE-"]`) — this is how Pappardelle auto-selects the profile when the user enters an issue key like `FE-123`
  - `team_prefix`: set per-profile to override the global prefix for issue creation
  - `commands`: reasonable setup commands based on project type (e.g., `npm install` for Node.js, `xcodegen generate` for iOS)
  - `emoji`: optional — suggest one via `/configure-pappardelle`'s emoji flow. With 3+ profiles, offer to bulk-assign now.
  - `tracker_projects`: Linear-only — the names of the Linear project(s) this profile lives in. The first entry doubles as the default project for issues created under this profile (STA-959). Skip for Jira; defer to `/configure-pappardelle` if the user doesn't already know their project names.
- Set `default_profile` to the most common one

### 1d. Claude initialization command

Ask: "Would you like Claude to run a skill automatically when a new workspace is created? The default is `/do` which starts planning and implementing the issue."

Options:

- **Yes, use `/do`** (default) — set `initialization_command: '/do'`
- **Custom** — let them type a skill name
- **No** — omit the `claude` section

If they chose `/do`, also offer to install the starter `/do` skill:

```bash
mkdir -p .claude/skills/do && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/do/SKILL.md -o .claude/skills/do/SKILL.md
```

### 1e. Dangerously Skip Permissions ("Yolo Mode")

Ask: "Should Claude start in 'yolo mode' — automatically approving all tool calls without asking for permission? (This sets `dangerously_skip_permissions: true` in your config)"

Options:

- **No** (default) — set `dangerously_skip_permissions: false`
- **Yes** — set `dangerously_skip_permissions: true`. Warn the user: "This means Claude can read, write, and execute anything without confirmation. Only enable this if you trust the skills and prompts being used in your workspaces."

This setting is only relevant if a `claude` section exists (i.e., the user chose an initialization command in 1d). If they opted out of `claude` in 1d, skip this question.

## Step 2: Install Pappardelle

Check if Pappardelle is already installed:

```bash
command -v pappardelle &>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

- If **not installed**, tell the user you'll install it now and run the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

The install script checks base prerequisites (Node.js >= 18, npm, git, tmux, jq), clones the repo, builds it, and makes the `pappardelle` command available globally. If it fails due to missing prerequisites, help the user install them (e.g., `brew install node tmux jq`) and re-run.

- If **already installed**, print "Pappardelle is already installed" and move on.

## Step 3: Check Prerequisites & Provider CLIs

Now that you know which providers they chose, check the required tools and provider-specific CLIs. Run these checks in a single bash command:

```bash
echo "=== Required ===" && \
for cmd in node npm git tmux jq yq claude; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done && \
echo "=== Provider CLIs ===" && \
for cmd in <VCS_CLI> <TRACKER_CLI> lazygit; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done
```

Replace `<VCS_CLI>` with `gh` (GitHub) or `glab` (GitLab), and `<TRACKER_CLI>` with `linctl` (Linear) or `acli` (Jira) based on the answers from Step 1.

- If any **required** tools are missing, **stop and do not proceed** to Step 4. Tell the user which ones are missing and offer to install them via `brew install <tool>` (or the appropriate install command for Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`). Use `AskUserQuestion` to confirm before installing. Re-run the check after installation and only proceed once all required tools pass.
- If any **provider CLIs** are missing, warn the user but allow proceeding — Pappardelle will work but some features will be degraded.
- If all tools are present, move on.

## Step 4: tmux Configuration

Ask: "Would you like me to add the recommended tmux config? It enables mouse support, pane navigation with Ctrl+Shift+arrow keys, and a clean status bar. (I'll append to ~/.tmux.conf)"

If yes, fetch the recommended config and append it to `~/.tmux.conf` (skip any settings that already exist):

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/tmux.conf >> ~/.tmux.conf
```

Check if `~/.tmux.conf` exists first and read it — if settings already exist, skip the duplicates rather than appending blindly.

If they decline, move on.

## Step 5: Generate .pappardelle.yml

Based on the answers, generate a `.pappardelle.yml` file at the repository root. Use the full config format from the [configuration reference](pappardelle-config.md).

Rules:

- Always include `version: 1`
- Always `issue_tracker`
- Always `vcs_host`
- Always include `team_prefix`
- **Single prefix**: one profile with no `keywords`, set as `default_profile`
- **Multiple prefixes**: one profile per prefix, each with `keywords: ["PREFIX-"]` (include the hyphen) and a per-profile `team_prefix` override. Set `default_profile` to the most common one

## Step 6: Summary

After writing the file, print a clear "you're done" summary. The goal is to leave the user with (a) exactly what was written where, (b) a concrete next command to run, and (c) a heads-up of what creating their first workspace will actually do.

Format it like this, filling in the real values from what you just collected:

```
✅ Pappardelle is configured.

Wrote /path/to/repo/.pappardelle.yml:
  • Issue tracker: {linear | jira (<base_url>)}
  • VCS host:      {github | gitlab (<host>)}
  • Team prefix:   {PROJ}
  • Profiles:      {default} (or list each one with its keywords)
  • Claude init:   {/do | <custom> | (none)}
  • Yolo mode:     {on | off}

Wrote /path/to/repo/.pappardelle.local.yml:
  • {only include this block if local overrides were written in 0c–0e or 1e}
  • default_profile: <name>
  • dangerously_skip_permissions: <value>

Next steps:
  1. Launch the TUI:            pappardelle
  2. In the TUI, press `n` to create your first workspace.
  3. Type an issue key (e.g., PROJ-123) or a one-line description of what you want to build.

What happens when you create a workspace:
  • A git worktree is created at ~/.worktrees/{repo}/{issue-key}/
  • A draft PR/MR is opened from the new branch
  • A named tmux session spins up Claude Code (with `{initialization_command}` if set)
  • A lazygit session is spawned for that worktree
  • The TUI's center and right panes attach to those sessions

For customizing keybindings, post-init hooks, issue watchlists, auto-remove-when-done, etc., see
[pappardelle-config.md](pappardelle-config.md) or run `/configure-pappardelle`.
```

Keep the summary grounded in what was actually written — don't list a `.pappardelle.local.yml` block if no local overrides were set, and don't mention yolo mode if the user skipped the `claude` section entirely.

## Example Outputs

### Single prefix (GitHub + Linear)

```yaml
version: 1

# Issue key prefix (e.g., PROJ-123)
team_prefix: PROJ

# VCS host
vcs_host:
  provider: github

# Issue tracker
issue_tracker:
  provider: linear

# Claude configuration
claude:
  initialization_command: '/do'
  dangerously_skip_permissions: false

# Commands to run after git worktree is created
post_workspace_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'

# Custom keybindings
keybindings:
  - key: 'c'
    name: 'Clear context'
    send_to_claude: '/clear'

# Profiles
profiles:
  default:
    display_name: 'Default'
    links:
      - url: '${ISSUE_URL}'
        title: 'Linear Issue'
      - url: '${PR_URL}'
        title: 'GitHub PR'
        if_set: 'PR_URL'
```

### Multiple prefixes (GitLab + Jira)

```yaml
version: 1

# Issue key prefix (most common one — FE is the default for bare numbers)
team_prefix: FE

# VCS host
vcs_host:
  provider: gitlab
  host: gitlab.mycompany.com

# Issue tracker
issue_tracker:
  provider: jira
  base_url: https://mycompany.atlassian.net

# Claude configuration
claude:
  initialization_command: '/do'
  dangerously_skip_permissions: false

# Commands to run after git worktree is created
post_workspace_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'

# Custom keybindings
keybindings:
  - key: 'c'
    name: 'Clear context'
    send_to_claude: '/clear'

# Profiles
profiles:
  frontend:
    display_name: 'Frontend'
    team_prefix: FE
    keywords:
      - FE-
      - frontend
    links:
      - url: '${ISSUE_URL}'
        title: 'Jira Issue'
      - url: '${MR_URL}'
        title: 'GitLab MR'
        if_set: 'MR_URL'

  backend:
    display_name: 'Backend'
    team_prefix: BE
    keywords:
      - BE-
      - backend
    links:
      - url: '${ISSUE_URL}'
        title: 'Jira Issue'
      - url: '${MR_URL}'
        title: 'GitLab MR'
        if_set: 'MR_URL'

  mobile:
    display_name: 'Mobile'
    team_prefix: MOB
    keywords:
      - MOB-
      - mobile
    links:
      - url: '${ISSUE_URL}'
        title: 'Jira Issue'
      - url: '${MR_URL}'
        title: 'GitLab MR'
        if_set: 'MR_URL'
```
