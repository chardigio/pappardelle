---
name: init-pappardelle
description: Install and initialize Pappardelle in a repository. Installs Pappardelle, checks prerequisites, asks about your VCS host, issue tracker, and project profiles, then generates a .pappardelle.yml config file.
disable-model-invocation: true
---

# /init-pappardelle — Set Up Pappardelle in This Repo

Interactive setup wizard that gets a repo from zero to "I can launch `pappardelle` and create a workspace." It is **not** just a `.pappardelle.yml` generator — the wizard owns the whole onboarding surface: explainer, config, CLI install, prerequisite verification, and tmux configuration.

## Setup Checklist (do not stop until ALL are verified)

This skill must satisfy **every** item below before printing the final summary. Even if the user already has `.pappardelle.yml` in the repo, **do not assume the rest is in place** — finding a config file is not a green light to bail. Walk the list top to bottom. If a step succeeds (already done / user declines / not applicable), check it off out loud and move on. Do not stop early.

1. **Workspaces explained.** The user has seen the "What is a Workspace?" section, so the wizard's vocabulary makes sense.
2. **`.pappardelle.yml` reflects the user's needs.** Either created from scratch (new install) or reviewed/personalized (existing install).
3. **`.pappardelle.local.yml` exists if local overrides were chosen.** Only when Step 1 collected per-machine overrides (default profile, yolo mode, etc.).
4. **Pappardelle CLI is installed.** `command -v pappardelle` succeeds.
5. **Required prerequisites are installed.** `node`, `npm`, `git`, `tmux`, `jq`, `yq`, `claude` are all on PATH.
6. **Provider CLIs are checked.** `gh` or `glab` for VCS, `linctl` or `acli` for tracker, plus `gitui` (the default companion-pane command — skip if the user set `companion_command` to something else). Warn about missing ones but do not block on them.
7. **Recommended `~/.tmux.conf` settings are in place** or the user has explicitly declined them.
8. **Terminal capability passthrough is configured** — offered and accepted, declined, or skipped because the terminal or tmux version does not support it. Never skip the detection itself.

If the user interrupts mid-flow, that's their call — but never _you_ deciding the work is done before the checklist is complete. The friend who triggered this skill once with `.pappardelle.yml` already in the repo had to write **three follow-up prompts** to get prerequisites, the Pappardelle CLI, and tmux config installed — that's the failure mode this checklist exists to prevent.

Before any other output, print the "What is a Workspace?" section verbatim so the user has shared vocabulary before the wizard starts asking questions.

## What is a Workspace?

A **workspace** in Pappardelle is the per-issue environment Pappardelle creates for you when you start work on a ticket. Each workspace bundles together:

- A dedicated **git worktree** at `~/.worktrees/{repo}/{issue-key}/` — an isolated checkout on a fresh branch, so you can have many in-flight tickets without stashing or switching branches.
- A tracked **issue** in your issue tracker (Linear or Jira) — Pappardelle either creates one from your prompt or uses an existing key like `STA-123`.
- A draft **PR/MR** against the main branch for that worktree.
- Its own **Claude Code session** (a named tmux session: `claude-{repo}-{issue-key}`) where you drive the work.
- Its own **companion session** (tmux session: `companion-{repo}-{issue-key}`) pointed at that worktree, running the `companion_command` (gitui by default).

The Pappardelle TUI is a 3-pane tmux layout that lets you list, switch between, and operate on workspaces — the left pane is the list, the center attaches to the highlighted workspace's Claude session, and the right attaches to its companion pane. Workspaces run in independent tmux sessions, so they survive even if the TUI is closed or restarted.

Everything the wizard asks — providers, profiles, init command, post-init hooks — is about configuring what happens **each time a new workspace is created**.

## Step 1: Configuration File

Check whether a `.pappardelle.yml` already exists at the repo root:

```bash
test -f "$(git rev-parse --show-toplevel)/.pappardelle.yml" && echo "EXISTS" || echo "NOT_FOUND"
```

Branch on the result:

- **NOT_FOUND** → run the **fresh-install** flow (Step 1A) to gather answers and write `.pappardelle.yml`.
- **EXISTS** → run the **personalization** flow (Step 1B) to review and tweak the existing config.

Either way, when Step 1 ends you **fall through to Step 2** — do not skip ahead to the summary.

### Step 1A: Fresh Install — Gather Configuration

Use `AskUserQuestion` for each of the following. Ask them one at a time — don't bundle questions.

#### 1A.i. VCS Host

Ask: "Which VCS host do you use?"

Options:

- **GitHub** (default) — requires `gh` CLI
- **GitLab** — requires `glab` CLI. If selected, follow up asking if it's gitlab.com or self-hosted (get the `host` value).
- **Other** — Pappardelle only supports GitHub and GitLab. Let the user know and stop.

#### 1A.ii. Issue Tracker

Ask: "Which issue tracker do you use?"

Options:

- **Linear** (default) — requires `linctl` CLI
- **Jira** — requires `acli` CLI. If selected, follow up asking for their Jira base URL (e.g., `https://mycompany.atlassian.net`).
- **Neither / Other** — Pappardelle requires Linear or Jira. Let the user know and stop.

#### 1A.iii. Team Prefix & Profiles

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
  - `tracker_projects`: the tracker project(s) this profile lives in — Linear project names, or Jira project names/keys (either matches, STA-1649). Routes existing issues to the profile; on Linear the first entry also doubles as the default project for issues created under this profile (STA-959). Defer to `/configure-pappardelle` if the user doesn't already know their project names.
- Set `default_profile` to the most common one

#### 1A.iv. Claude Initialization Command

Ask: "Would you like Claude to run a skill automatically when a new workspace is created? The default is `/do` which starts planning and implementing the issue."

Options:

- **Yes, use `/do`** (default) — set `initialization_command: '/do'`
- **Custom** — let them type a skill name
- **No** — omit the `claude` section

If they chose `/do`, also offer to install the starter `/do` skill. Both files are required: `SKILL.md`'s first step copies `TODO-TEMPLATE.md` into the worktree, so fetching the skill alone leaves it broken:

```bash
mkdir -p .claude/skills/do \
  && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/do/SKILL.md -o .claude/skills/do/SKILL.md \
  && curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/skills/do/TODO-TEMPLATE.md -o .claude/skills/do/TODO-TEMPLATE.md
```

After installing, check whether `.claude/skills` is tracked:

```bash
git ls-files --error-unmatch .claude/skills > /dev/null 2>&1
```

If it isn't, the skill is invisible in exactly the place `initialization_command` runs. Worktrees only receive tracked files, so `/do` won't exist in any workspace pappardelle creates. Tell the user this and offer two fixes:

- **Commit it** (recommended when the checklist is shared with the team) — `git add .claude/skills/do`
- **Keep it untracked** — add a `post_workspace_init` entry that links the main checkout's skills into each new worktree:

  ```yaml
  post_workspace_init:
    - name: 'Link local skills'
      run: '[ -e ${WORKTREE_PATH}/.claude/skills ] || { mkdir -p ${WORKTREE_PATH}/.claude && ln -sfn ${REPO_ROOT}/.claude/skills ${WORKTREE_PATH}/.claude/skills; }'
  ```

  The `[ -e ]` guard is not optional: `ln -sfn` pointed at an existing directory creates the link _inside_ it (`.claude/skills/skills`) rather than replacing it, so an unguarded version corrupts any repo that later commits a skill.

#### 1A.v. Dangerously Skip Permissions ("Yolo Mode")

Ask: "Should Claude start in 'yolo mode' — automatically approving all tool calls without asking for permission? (This sets `dangerously_skip_permissions: true` in your config)"

Options:

- **No** (default) — set `dangerously_skip_permissions: false`
- **Yes** — set `dangerously_skip_permissions: true`. Warn the user: "This means Claude can read, write, and execute anything without confirmation. Only enable this if you trust the skills and prompts being used in your workspaces."

This setting is only relevant if a `claude` section exists (i.e., the user chose an initialization command in 1A.iv). If they opted out of `claude` in 1A.iv, skip this question.

#### 1A.vi. Write `.pappardelle.yml`

Based on the answers, generate a `.pappardelle.yml` file at the repository root. Use the full config format from the [configuration reference](pappardelle-config.md).

Rules:

- Always include `version: 1`
- Always `issue_tracker`
- Always `vcs_host`
- Always include `team_prefix`
- **Single prefix**: one profile with no `keywords`, set as `default_profile`
- **Multiple prefixes**: one profile per prefix, each with `keywords: ["PREFIX-"]` (include the hyphen) and a per-profile `team_prefix` override. Set `default_profile` to the most common one

Then **continue to Step 2** — do not stop here.

### Step 1B: Existing Install — Personalize

The repo already has `.pappardelle.yml`. Read and parse it, then walk the user through personalization with `AskUserQuestion` (one question at a time, don't bundle).

This branch is **personalization only** — it does not let you skip the rest of the checklist. When you finish here, you still **fall through to Step 2** to verify the CLI is installed, prereqs are present, and tmux is configured.

#### 1B.i. Show Current Configuration

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
>
> I'll quickly check whether you'd like any local tweaks, and then I'll verify the Pappardelle CLI, your prerequisites, and your tmux config are all set up — even if Pappardelle is already configured here, those pieces may not be in place yet on this machine.

#### 1B.ii. Add a New Profile?

Ask: "Do any of the existing profiles fit your use case, or would you like to add a new one?"

- If they're happy with existing profiles, move on.
- If they want a new profile, gather the same info as 1A.iii (display name, keywords, project type, commands) and add it to `.pappardelle.yml`.

#### 1B.iii. Default Profile

Ask: "Which profile should be your default? (This is the profile used when no keywords match your issue.)"

List the available profiles by name. If they pick one that differs from the current `default_profile`, queue a local override (written in 1B.v):

```yaml
default_profile: their-choice
```

If they pick the one that's already the default, skip.

#### 1B.iv. Dangerously Skip Permissions

Show the current `dangerously_skip_permissions` value and ask: "Should Claude start in 'yolo mode' — automatically approving all tool calls? (Currently: {yes/no})"

- If they want to change it, queue a local override:
  ```yaml
  claude:
    dangerously_skip_permissions: true # or false
  ```
- If they're happy with the current value, skip.

#### 1B.v. Write `.pappardelle.local.yml` (if needed)

If any local overrides were collected in 1B.iii–1B.iv, write or update `.pappardelle.local.yml`. Preserve any existing content (e.g., `keybindings`, `issue_watchlist`) — only add/update the fields that changed.

Then **continue to Step 2** — the checklist is not finished.

## Step 2: Install Pappardelle CLI

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

Do not skip this step just because `.pappardelle.yml` already exists in the repo — config presence says nothing about whether the CLI is on this machine.

## Step 3: Verify Prerequisites & Provider CLIs

Now check the required tools and the provider-specific CLIs from the user's configuration. Run these checks in a single bash command:

```bash
echo "=== Required ===" && \
for cmd in node npm git tmux jq yq claude; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done && \
echo "=== Provider CLIs ===" && \
for cmd in <VCS_CLI> <TRACKER_CLI> gitui; do printf "%-10s %s\n" "$cmd" "$(command -v $cmd >/dev/null 2>&1 && echo '✓' || echo '✗ MISSING')"; done
```

Replace `<VCS_CLI>` with `gh` (GitHub) or `glab` (GitLab), and `<TRACKER_CLI>` with `linctl` (Linear) or `acli` (Jira). `gitui` is the default companion-pane command — if `.pappardelle.yml` sets `companion_command` to a different tool, check that instead. When you took the existing-config path in Step 1B, read these values straight out of the parsed `.pappardelle.yml`.

- If any **required** tools are missing, **stop and do not proceed** to Step 4. Tell the user which ones are missing and offer to install them via `brew install <tool>` (or the appropriate install command for Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`). Use `AskUserQuestion` to confirm before installing. Re-run the check after installation and only proceed once all required tools pass.
- If any **provider CLIs** are missing, warn the user but allow proceeding — Pappardelle will work but some features will be degraded.
- If all tools are present, move on.

## Step 4: tmux Configuration

### 4.i. Base Config

Ask: "Would you like me to add the recommended tmux config? It enables mouse support, pane navigation with Ctrl+Shift+arrow keys, and a clean status bar. (I'll append to ~/.tmux.conf)"

If yes, fetch the recommended config and append it to `~/.tmux.conf` (skip any settings that already exist):

```bash
curl -fsSL https://raw.githubusercontent.com/chardigio/pappardelle/main/examples/tmux.conf >> ~/.tmux.conf
```

Check if `~/.tmux.conf` exists first and read it — if settings already exist, skip the duplicates rather than appending blindly.

If they decline, record that and move on — declining counts as the step being done; do not re-prompt later.

### 4.ii. Terminal Capability Passthrough (conditional)

tmux does not forward the outer terminal's synchronized-output and truecolor support to inner apps unless told to, which is what makes full-screen TUIs flicker and tear while repainting. Offer these settings only when the terminal actually supports them, so run the detection first — never write the block based on `$TERM`, which inside tmux reports what tmux advertises rather than what the real terminal is.

Run the probe:

```bash
bash ~/.pappardelle/scripts/init-pappardelle/detect-terminal-capabilities.sh
```

It prints one line, e.g. `TERM=xterm-ghostty tmux_ok=yes(3.7) sync_ok=yes rgb_ok=yes ti_ok=yes usstyle_ok=yes`. Interpret it:

- **`tmux_ok=no`** — the `sync` terminal feature needs tmux >= 3.2. Skip this whole sub-step and tell the user upgrading tmux (`brew install tmux`) would fix TUI flicker.
- **`sync_ok=no` and `rgb_ok=no`** — the terminal genuinely does not support these. Skip silently; adding the settings would be wrong.
- **Otherwise** — offer the block, naming only what the detection actually found. `sync_ok` and `rgb_ok` are independent and this branch is reached when *either* is yes, so build the phrase from the flags: both yes gives "synchronized output and truecolor", `sync_ok` alone gives "synchronized output", `rgb_ok` alone gives "truecolor". Never name a capability the detection reported `no` for. Use **AskUserQuestion** to ask: "Your terminal ({TERM}) supports {capabilities}. Want me to add the tmux settings that pass those through? Without them, full-screen TUIs like Claude Code visibly flicker and tear while repainting inside tmux." Options: **Yes** — add the settings; **No** — skip them.

If they accept, **read `~/.tmux.conf` first** and skip any of these settings that are already present, exactly as Step 4.i does. Do not append blindly: re-running this wizard on a machine that already has the block must not duplicate it, and Step 5 asks you to report `✓ already present`, which you cannot do truthfully without checking. If every applicable setting is already there, report it as already present and write nothing.

Otherwise prepend the missing lines to `~/.tmux.conf` (order does not matter, but keeping them above the Pappardelle block reads better). Include only the lines the detection supports: drop `*:RGB` if `rgb_ok=no`, drop `*:sync` if `sync_ok=no`, drop the `usstyle` line if `usstyle_ok=no`, and drop `default-terminal` if `ti_ok=no` (use `screen-256color` instead, or leave it out):

```tmux
# Advertise a real terminfo to inner apps. The default (`screen`) costs
# truecolor and italics, and pushes TUIs toward full-screen redraws
set -g default-terminal "tmux-256color"

# Forward the outer terminal's synchronized-update (DECSET 2026) and truecolor
# support so TUI repaints land as one frame instead of tearing mid-update
set -ga terminal-features "*:RGB"
set -ga terminal-features "*:sync"

# Styled/colored underlines and OSC 8 hyperlinks, when the terminal has them
set -ga terminal-features "<TERM>:usstyle:hyperlinks"

# The 500ms default makes Esc-heavy apps (nvim) feel laggy
set -sg escape-time 10
```

Replace `<TERM>` with the `TERM=` value the probe reported (e.g. `xterm-ghostty`), not `$TERM`.

**Gotcha:** `terminal-features` is an array option and `set -ga` appends a new **comma**-separated element. Features within one entry must be joined with `:`. Writing `"xterm-ghostty:usstyle,hyperlinks"` silently produces two entries, the second a bare `hyperlinks` with no TERM pattern, which does nothing.

Then tell the user the settings need a **new tmux server** to take effect: `default-terminal` applies only to new sessions and the client-side features resolve at attach time. Do **not** run `tmux kill-server` yourself; it would kill any session they are attached to, possibly the one running this skill. Tell them to run it when convenient, then verify:

```bash
tmux display -p '#{client_termfeatures}'   # should list whichever features you added
```

If they decline, record it and move on; do not re-prompt.

## Step 5: Summary

Only run this step after every item in the **Setup Checklist** at the top is verified. The goal is to leave the user with (a) exactly what was written where, (b) a concrete next command to run, and (c) a heads-up of what creating their first workspace will actually do.

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
  • {only include this block if local overrides were written in 1B.iii–1B.v or 1A.v}
  • default_profile: <name>
  • dangerously_skip_permissions: <value>

Verified:
  • Pappardelle CLI installed:  ✓
  • Required prerequisites:     ✓ (node, npm, git, tmux, jq, yq, claude)
  • Provider CLIs:              {✓ all present | ⚠ missing: <list> — degraded features}
  • tmux config:                {✓ appended | ✓ already present | — user declined}
  • Terminal passthrough:       {✓ added (<features actually written>) — restart tmux server to apply | ✓ already present | — user declined | — not supported by <TERM>}

Next steps:
  1. Launch the TUI:            pappardelle
  2. In the TUI, press `n` to create your first workspace.
  3. Type an issue key (e.g., PROJ-123) or a one-line description of what you want to build.

What happens when you create a workspace:
  • A git worktree is created at ~/.worktrees/{repo}/{issue-key}/
  • A draft PR/MR is opened from the new branch
  • A named tmux session spins up Claude Code (with `{initialization_command}` if set)
  • A companion session runs the `companion_command` (gitui by default) for that worktree
  • The TUI's center and right panes attach to those sessions

For customizing keybindings, post-init hooks, issue watchlists, auto-remove-when-done, etc., see
[pappardelle-config.md](pappardelle-config.md) or run `/configure-pappardelle`.
```

Keep the summary grounded in what was actually written and verified — don't list a `.pappardelle.local.yml` block if no local overrides were set, don't mention yolo mode if the user skipped the `claude` section entirely, and don't claim tmux was configured if the user declined.

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
