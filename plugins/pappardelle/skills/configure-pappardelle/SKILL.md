---
name: configure-pappardelle
description: Interactively configure Pappardelle by editing .pappardelle.yml and .pappardelle.local.yml. Helps add profiles, keybindings, hooks, watchlists, and more. Use when the user asks to configure, customize, or tweak their Pappardelle setup.
---

# /configure-pappardelle — Interactive Configuration Editor

Help the user configure their Pappardelle setup by editing `.pappardelle.yml` (shared, checked into git) and/or `.pappardelle.local.yml` (personal, gitignored).

## Getting Started

1. **Find the config files** at the git repository root:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
echo "Repo root: $REPO_ROOT"
ls -la "$REPO_ROOT/.pappardelle.yml" "$REPO_ROOT/.pappardelle.local.yml" 2>/dev/null
```

2. **Read the existing config** (if it exists). If no `.pappardelle.yml` exists, suggest running `/init-pappardelle` first.

3. **Ask what the user wants to configure** using `AskUserQuestion`:

Options:
- **Add or edit a profile** — create a new project profile or modify an existing one
- **Assign emojis to profiles** — suggest a ticket-rail emoji for each profile (STA-924)
- **Configure keybindings** — add, change, or remove keyboard shortcuts
- **Set up workspace init commands** — commands to run after worktree creation (`post_workspace_init`)
- **Set up workspace deinit commands** — commands to run before workspace deletion (`pre_workspace_deinit`)
- **Configure issue watchlist** — auto-create workspaces for assigned issues
- **Edit local overrides** — personal keybinding overrides in `.pappardelle.local.yml`
- **Change providers** — switch issue tracker or VCS host
- **Configure Claude settings** — initialization command, permissions

Then follow the appropriate section below based on their choice.

### Proactive emoji suggestion

Before showing the menu: if the config has >2 profiles and none of them have
an `emoji:`, ask once whether to assign emojis (see *Configuring Profile
Emojis*). If yes → jump there; if no → continue to the menu and don't ask
again this session.

## Configuring Profiles

Profiles define project-specific workspace behavior. Ask these questions with `AskUserQuestion`:

1. **Profile name**: kebab-case slug (e.g., `my-app`, `backend-api`)
2. **Display name**: human-readable (e.g., `My iOS App`, `Backend API`)
3. **Keywords**: words that auto-select this profile when creating workspaces (e.g., `ios`, `app`, `swift`). Include the issue prefix with hyphen if applicable (e.g., `MOB-`)
4. **Emoji** (optional): suggest one via the resolution flow in *Configuring Profile Emojis* below. If the user already has emojis on other profiles, always ask — otherwise skip unless they express interest.
5. **Team prefix override**: if this profile uses a different issue key prefix than the global `team_prefix`
6. **Linear project routing** (`tracker_projects`, optional): a list of Linear project names that map to this profile. Pappardelle uses it for two things — (a) when an existing issue is fetched, its project name is matched against the list to auto-select the profile, and (b) when a *new* issue is created under this profile via `idow`, `tracker_projects[0]` is resolved to a Linear project UUID and assigned automatically (STA-959). Order so the active project for new work is first; re-order when the active project rotates (e.g., once `Foo MVP` ships, move `Foo Quality` to position 0). Skip for Jira — `team_prefix` already controls Jira project routing.
7. **Project type**: ask what kind of project to generate sensible defaults:
   - **iOS app**: ask for app directory, bundle ID, Xcode scheme. Generate `vars` and `commands` for xcodegen/xcodebuild
   - **Backend/API**: generate dependency install commands
   - **Frontend/Web**: generate npm/yarn commands
   - **Other**: let user specify custom commands

### Profile fields reference

```yaml
profiles:
  my-profile:
    keywords: [keyword1, keyword2]
    tracker_projects:               # Optional — Linear project names. [0] is the
      - 'My Project Quality'        # default project for issues newly-created under
      - 'My Project MVP'            # this profile (STA-959).
    display_name: 'My Profile'
    emoji: '🎸'                   # Optional — shown in the ticket rail (STA-924)
    team_prefix: PREFIX           # Optional per-profile override
    claude:
      initialization_command: '/do'  # Optional per-profile override
    vars:                           # Custom template variables
      KEY: 'value'
    vcs:
      label: 'github_label'        # Label applied to PRs/MRs
    links:
      - url: '${ISSUE_URL}'
        title: 'Issue'
      - url: '${PR_URL}'
        title: 'PR'
        if_set: 'PR_URL'
    apps:
      - name: 'Xcode'
        path: '${WORKTREE_PATH}/path/to/project.xcodeproj'
        if_set: 'SOME_VAR'
    commands:
      - name: 'Build project'
        run: 'cd ${WORKTREE_PATH} && make build'
        continue_on_error: false
        background: false
    post_workspace_init:            # Profile-specific init commands (run after global)
      - name: 'Setup step'
        run: 'some command'
    pre_workspace_deinit:           # Profile-specific deinit commands (run after global)
      - name: 'Cleanup step'
        run: 'some command'
        continue_on_error: true
```

## Configuring Profile Emojis

Each profile can set an `emoji:` — shown as the first cell of its row in
the ticket rail. Goes in `.pappardelle.yml` (shared).

**Pick one for a profile** by trying in order:

1. **Linear project icon** (Linear projects only): `linctl project list --json`
   and look up the profile's `tracker_projects` entry. If `.icon` is a name
   like `Rocket`/`MusicNote`, translate to the matching emoji (🚀/🎵 etc.).
2. **Guess from the profile's `display_name` / `keywords`** — pick whatever
   emoji fits best (music → 🎸, bee → 🐝, infra → ⚙️, etc.).
3. **Ask** via `AskUserQuestion` with 3 candidates + "Other".

**Bulk flow** (menu option or proactive prompt): propose a mapping for all
emoji-less profiles, show it in one table, and ask apply-all / tweak-each /
skip.

Do **not** prompt for `default_emoji:` — Pappardelle auto-promotes
unmatched rows to a blank slot whenever any profile has an `emoji:`, so
rows stay aligned without it. Only touch `default_emoji:` if the user
explicitly asks for a non-blank fallback glyph.

Remind the user to quit and relaunch the TUI to see the change.

## Configuring Keybindings

Keybindings are single-key shortcuts in the Pappardelle TUI. Ask with `AskUserQuestion`:

1. **Which key?** — single character. Warn about reserved keys: `j`, `k`, `g`, `i`, `d`, `o`, `n`, `e`, `p`, `q`, `?`
2. **What should it do?** — run a bash command (`run`) or send text to Claude (`send_to_claude`)
3. **Display name** — shown in the help overlay
4. **Shared or personal?** — shared goes in `.pappardelle.yml`, personal goes in `.pappardelle.local.yml`

```yaml
keybindings:
  - key: 'b'
    name: 'Build app'
    run: 'cd ${WORKTREE_PATH} && make build'
  - key: 'a'
    name: 'Address PR feedback'
    send_to_claude: '/address-pr-feedback'
```

### Local overrides (`.pappardelle.local.yml`)

The local file can add, override, or disable keybindings:

```yaml
keybindings:
  - key: 'V'             # Add new personal binding
    name: 'Open in VS Code'
    run: 'code ${WORKTREE_PATH}'
  - key: 'X'             # Override a shared binding
    name: 'Open in Nova'
    run: 'nova ${WORKTREE_PATH}'
  - key: 'r'             # Disable a shared binding
    disabled: true
```

## Configuring Workspace Init Commands

`post_workspace_init` runs after worktree creation. Common patterns:

```yaml
# Copy environment files
post_workspace_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'
  - name: 'Install dependencies'
    run: 'cd ${WORKTREE_PATH} && npm install'
    continue_on_error: true
  - name: 'Background task'
    run: 'long-running-setup.sh'
    background: true
```

Ask with `AskUserQuestion`:
1. What setup steps are needed after creating a new worktree?
2. Should any steps be allowed to fail? (`continue_on_error: true`)
3. Should any steps run in the background? (`background: true`)

> **Note:** `post_worktree_init` is accepted as a backwards-compatible alias. Use `post_workspace_init` for new configs.

## Configuring Workspace Deinit Commands

`pre_workspace_deinit` runs before workspace deletion. If a command fails (without `continue_on_error`), deletion is aborted.

```yaml
pre_workspace_deinit:
  - name: 'Close issue'
    run: 'linctl issue update ${ISSUE_KEY} --state Done'
    continue_on_error: true
  - name: 'Remove worktree'
    run: 'git worktree remove ${WORKTREE_PATH} --force'
    continue_on_error: true
```

Ask with `AskUserQuestion`:
1. What cleanup should happen when deleting a workspace?
2. Should deletion be blocked if cleanup fails?

## Configuring Issue Watchlist

Auto-create workspaces for issues assigned to you.

```yaml
issue_watchlist:
  assignee: me              # 'me' auto-detects, or use explicit username
  statuses:
    - To Do
    - In Progress
  labels:                   # Optional: filter by label
    - pappardelle
```

Ask with `AskUserQuestion`:
1. Which issue statuses should trigger workspace creation?
2. Should it filter by specific labels?
3. Assignee: use `me` (auto-detect) or a specific username?

## Configuring Providers

### Issue tracker

```yaml
issue_tracker:
  provider: linear          # or 'jira'
  # base_url: https://mycompany.atlassian.net  # Required for Jira
```

### VCS host

```yaml
vcs_host:
  provider: github          # or 'gitlab'
  # host: gitlab.mycompany.com  # Optional for self-hosted GitLab
```

## Configuring Claude Settings

```yaml
claude:
  initialization_command: '/do'    # Skill to run on new sessions
  dangerously_skip_permissions: false  # 'yolo mode'
```

Per-profile overrides take precedence:

```yaml
profiles:
  my-profile:
    claude:
      initialization_command: '/do-custom'
```

## Template Variables Reference

Available in all command templates, link URLs, and app paths:

| Variable | Description | Example |
|----------|-------------|---------|
| `${ISSUE_KEY}` | Issue key | `STA-361` |
| `${ISSUE_NUMBER}` | Numeric part | `361` |
| `${ISSUE_URL}` | Full issue URL | `https://linear.app/...` |
| `${TITLE}` | Issue title | `Add dark mode` |
| `${DESCRIPTION}` | Issue description | (full text) |
| `${WORKTREE_PATH}` | Worktree path | `/Users/.../STA-361` |
| `${REPO_ROOT}` | Git repo root | `/Users/.../stardust-labs` |
| `${REPO_NAME}` | Repo directory name | `stardust-labs` |
| `${PR_URL}` | GitHub PR URL | `https://github.com/...` |
| `${MR_URL}` | GitLab MR URL | `https://gitlab.com/...` |
| `${SCRIPT_DIR}` | Pappardelle scripts dir | `/path/to/scripts` |
| `${VCS_LABEL}` | VCS label from profile | `stardust_jams` |
| `${TRACKER_PROVIDER}` | Issue tracker | `linear` or `jira` |
| `${VCS_PROVIDER}` | VCS host | `github` or `gitlab` |

Profile `vars` keys also become template variables (e.g., `vars: { APP_DIR: "src" }` → `${APP_DIR}`).

## Important Rules

- **Always read the existing config before editing** — use the Read tool to get current state
- **Use `AskUserQuestion` liberally** — don't guess what the user wants, ask
- **Validate after editing** — check YAML syntax is correct
- **Shared vs personal**: changes to `.pappardelle.yml` affect everyone on the team; `.pappardelle.local.yml` is gitignored and personal
- **Reserved keybinding keys**: `j`, `k`, `g`, `i`, `d`, `o`, `n`, `e`, `p`, `q`, `?` — never assign these
- **Command fields**: every command needs `name` (string) and `run` (string). Optional: `continue_on_error` (bool), `background` (bool)
- If the user's request matches the arguments passed to this skill (e.g., `/configure-pappardelle add a keybinding for running tests`), skip the initial "what do you want to configure" question and jump directly to the relevant section
- **Restart required**: after making config changes, remind the user that any running Pappardelle TUI must be restarted to pick up the changes — press `q` to quit, then re-launch with `pappardelle`
