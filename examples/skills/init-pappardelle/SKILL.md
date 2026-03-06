---
name: init-pappardelle
description: Initialize Pappardelle in a repository. Checks prerequisites, asks about your VCS host, issue tracker, and project profiles, then generates a .pappardelle.yml config file.
---

# /init-pappardelle — Set Up Pappardelle in This Repo

Interactive setup wizard that checks prerequisites, gathers your configuration preferences, and generates a `.pappardelle.yml` file.

## Step 1: Check Prerequisites

Check which required and optional tools are installed. Run these checks in a single bash command:

```bash
echo "=== Required ===" && \
for cmd in node npm git tmux jq claude; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done && \
echo "=== Optional ===" && \
for cmd in linctl gh glab acli lazygit; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ not installed')"; done
```

- If any **required** tools are missing, tell the user which ones and offer to install them via `brew install <tool>` (or the appropriate install command for Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`). Use `AskUserQuestion` to confirm before installing.
- If all required tools are present, move on.

## Step 2: Gather Configuration

Use `AskUserQuestion` for each of these. Ask them one at a time — don't bundle questions.

### 2a. VCS Host

Ask: "Which VCS host do you use?"

Options:
- **GitHub** (default) — requires `gh` CLI
- **GitLab** — requires `glab` CLI. If selected, follow up asking if it's gitlab.com or self-hosted (get the `host` value).
- **Other** — Pappardelle only supports GitHub and GitLab. Let the user know and stop.

### 2b. Issue Tracker

Ask: "Which issue tracker do you use?"

Options:
- **Linear** (default) — requires `linctl` CLI
- **Jira** — requires `acli` CLI. If selected, follow up asking for their Jira base URL (e.g., `https://mycompany.atlassian.net`).
- **Neither / Other** — Pappardelle requires Linear or Jira. Let the user know and stop.

For whichever provider they chose, check that the corresponding CLI tool is installed. If not, offer to install it.

### 2c. Team Prefix

Ask: "What is your issue key prefix? (e.g., PROJ for PROJ-123)"

This becomes the global `team_prefix`.

### 2d. Profiles

Ask: "What project types do you work on in this repo? Describe each one briefly (e.g., 'iOS app called MyApp', 'backend API', 'React frontend'). You can list multiple."

Based on their answer, generate sensible profile entries with:
- A slug name (kebab-case)
- `display_name`
- `keywords` array (words that would appear in issue descriptions for this project type)
- Reasonable `commands` if applicable (e.g., `xcodegen generate` for iOS, `npm install` for Node.js)

### 2e. Claude initialization command

Ask: "Would you like Claude to run a skill automatically when a new workspace is created? The default is `/do` which starts planning and implementing the issue."

Options:
- **Yes, use `/do`** (default) — set `initialization_command: '/do'`
- **Custom** — let them type a skill name
- **No** — omit the `claude` section

If they chose `/do`, also offer to install the starter `/do` skill:

```bash
mkdir -p .claude/skills/do && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/do/SKILL.md -o .claude/skills/do/SKILL.md
```

### 2f. tmux configuration

Ask: "Would you like me to add the recommended tmux config? It enables mouse support, pane navigation with Ctrl+arrow keys, and a clean status bar. (I'll append to ~/.tmux.conf)"

If yes, fetch the recommended config and append it to `~/.tmux.conf` (skip any settings that already exist):

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/tmux.conf >> ~/.tmux.conf
```

Check if `~/.tmux.conf` exists first and read it — if settings already exist, skip the duplicates rather than appending blindly.

If they decline, move on.

## Step 3: Generate .pappardelle.yml

Based on the answers, generate a `.pappardelle.yml` file at the repository root. Use the full config format from the [configuration reference](pappardelle-config.md).

Rules:
- Always include `version: 1`
- Only include `issue_tracker` if it's not the default (Linear)
- Only include `vcs_host` if it's not the default (GitHub)
- Always include `team_prefix`
- Include a `default_profile` set to the first profile
- Include all profiles with their keywords, display names, and any commands

Before writing the file, show the generated YAML to the user and use `AskUserQuestion` to confirm: "Does this look right? I'll write it to .pappardelle.yml."

If a `.pappardelle.yml` already exists, warn the user and ask before overwriting.

## Step 4: Summary

After writing the file, print a summary:

1. What was configured (providers, profiles)
2. How to launch: `pappardelle`
3. Link to the full config reference: [pappardelle-config.md](pappardelle-config.md) for customizing keybindings, post-worktree hooks, lifecycle hooks, and more
