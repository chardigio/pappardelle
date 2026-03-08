---
name: init-pappardelle
description: Install and initialize Pappardelle in a repository. Installs Pappardelle, checks prerequisites, asks about your VCS host, issue tracker, and project profiles, then generates a .pappardelle.yml config file.
disable-model-invocation: true
---

# /init-pappardelle — Set Up Pappardelle in This Repo

Interactive setup wizard that installs Pappardelle, gathers your configuration preferences, checks prerequisites, and generates a `.pappardelle.yml` file.

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

## Step 2: Install Pappardelle

Check if Pappardelle is already installed:

```bash
command -v pappardelle &>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

- If **not installed**, tell the user you'll install it now and run the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh | bash
```

The install script checks base prerequisites (Node.js >= 18, npm, git, tmux, jq), clones the repo, builds it, and makes `pappardelle` and `idow` available globally. If it fails due to missing prerequisites, help the user install them (e.g., `brew install node tmux jq`) and re-run.

- If **already installed**, print "Pappardelle is already installed" and move on.

## Step 3: Check Provider CLIs

Now that you know which providers they chose, check the provider-specific CLIs. Run these checks in a single bash command:

```bash
echo "=== Provider CLIs ===" && \
for cmd in <VCS_CLI> <TRACKER_CLI> lazygit; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done
```

Replace `<VCS_CLI>` with `gh` (GitHub) or `glab` (GitLab), and `<TRACKER_CLI>` with `linctl` (Linear) or `acli` (Jira) based on the answers from Step 1.

- If any tools are missing, tell the user which ones and offer to install them via `brew install <tool>`. Use `AskUserQuestion` to confirm before installing.
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

After writing the file, print a summary:

1. What was configured (providers, profiles)
2. How to launch: `pappardelle`
3. Link to the full config reference: [pappardelle-config.md](pappardelle-config.md) for customizing keybindings, post-worktree hooks, lifecycle hooks, and more

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
post_worktree_init:
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
post_worktree_init:
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
