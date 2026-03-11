# Pappardelle Configuration System

This document describes the `.pappardelle.yml` configuration file format that controls workspace setup behavior for the Pappardelle TUI and dow/idow scripts.

## Overview

The `.pappardelle.yml` file replaces the previous `.git` directory requirement. Instead of assuming a specific project structure, pappardelle now reads configuration from this file to understand how to set up workspaces for different project types.

**Key Design Decisions:**

- **Repository-wide configuration**: One `.pappardelle.yml` at the git repository root
- **Profile-based**: Different project types (iOS apps, backend services) have named profiles
- **Required**: Pappardelle exits with an error if no config file is found
- **Templated**: Supports variable expansion for dynamic values
- **Provider-agnostic**: Supports multiple issue trackers (Linear, Jira) and VCS hosts (GitHub, GitLab)

## File Location

Pappardelle searches for `.pappardelle.yml` at the git repository root only:

```bash
git rev-parse --show-toplevel  # Find repo root
# Then look for: <repo-root>/.pappardelle.yml
```

## Configuration Schema

```yaml
# .pappardelle.yml - Pappardelle workspace configuration
version: 1

# Issue tracker provider (optional, defaults to linear)
issue_tracker:
  provider: linear # "linear" or "jira"
  # base_url: https://mycompany.atlassian.net  # Required for jira

# VCS host provider (optional, defaults to github)
vcs_host:
  provider: github # "github" or "gitlab"
  # host: gitlab.mycompany.com  # Optional for self-hosted GitLab

# Claude configuration (optional)
claude:
  initialization_command: '/idow' # Command passed to Claude on new sessions
  dangerously_skip_permissions: true # Pass --dangerously-skip-permissions to Claude (default: false)

# Commands to run after git worktree is created (optional).
# Without this section, create-worktree.sh just creates the branch.
# Uses the same CommandConfig format as profile commands.
post_worktree_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'
  - name: 'Set PORT'
    run: "sed -i '' 's/^PORT=.*/PORT=5${ISSUE_NUMBER}/' ${WORKTREE_PATH}/.env"
  - name: 'Install dependencies'
    run: 'cd ${WORKTREE_PATH} && uv sync --quiet'
    continue_on_error: true

# Terminal application for workspace windows (optional, default: iTerm)
terminal:
  app: 'iTerm' # Currently only iTerm is supported

# Lifecycle hooks (optional)
# Commands that run at specific points during workspace setup.
hooks:
  # Runs after the workspace is fully created (worktree, PR, apps opened)
  post_workspace_create:
    - name: 'Run setup script'
      run: 'cd ${WORKTREE_PATH} && ./setup.sh'
      continue_on_error: true
      # background: true  # Run in background, don't wait

# Default profile used when no match is found
default_profile: stardust-jams

# Named profiles for different project types
profiles:
  stardust-jams:
    # Keywords that auto-select this profile
    # Matched against user input (case-insensitive)
    keywords:
      - stardust
      - jams
      - music
      - spotify
      - playlist

    # Display name shown in profile picker
    display_name: 'Stardust Jams (iOS Music App)'

    # Per-profile team prefix override (optional)
    # When set, issues created under this profile use this team prefix
    # instead of the global team_prefix. Does not affect bare-number
    # normalization (that always uses the global prefix).
    # team_prefix: JAM

    # Generic template variables injected into workspace context.
    # Keys become available as ${KEY} in templates.
    vars:
      IOS_APP_DIR: '_ios/stardust-jams'
      BUNDLE_ID: 'com.cd17822.stardust-jams'
      SCHEME: 'stardust-jams'

    # VCS label for PRs/MRs (provider-agnostic, preferred)
    vcs:
      label: 'stardust_jams'
    # Legacy alias (still works): github: { label: 'stardust_jams' }

    # Links to open in browser (templated)
    links:
      - url: '${ISSUE_URL}'
        title: 'Issue'
      - url: '${PR_URL}'
        title: 'PR/MR'
        # Optional: only open if variable is non-empty
        if_set: 'PR_URL'

    # Applications to open
    apps:
      - name: 'Cursor'
        path: '${WORKTREE_PATH}'
      - name: 'Xcode'
        path: '${WORKTREE_PATH}/${IOS_APP_DIR}/${SCHEME}.xcodeproj'
        if_set: 'IOS_APP_DIR'
      - name: 'iTerm'
        # Custom command instead of just opening
        command: |
          osascript -e 'tell application "iTerm" to create window with default profile'

    # Commands to run during setup (in order)
    commands:
      - name: 'Generate Xcode project'
        run: 'cd ${WORKTREE_PATH}/${IOS_APP_DIR} && xcodegen generate'
        continue_on_error: false
      - name: 'Setup QA simulator'
        run: '${SCRIPT_DIR}/setup-qa-simulator.sh --worktree ${WORKTREE_PATH} --issue-key ${ISSUE_KEY} --ios-app-dir ${IOS_APP_DIR} --bundle-id ${BUNDLE_ID}'
        background: true # Run in background, don't wait

  king-bee:
    keywords:
      - king
      - bee
      - hive
      - spelling
      - wordle
    display_name: 'King Bee (iOS Spelling Game)'
    vars:
      IOS_APP_DIR: '_ios/King Bee'
      BUNDLE_ID: 'com.cd17822.King-Bee'
      SCHEME: 'King Bee'
    github:
      label: 'the_hive'
    links:
      - url: 'https://linear.app/stardust-labs/issue/${ISSUE_KEY}'
        title: 'Linear Issue'
      - url: '${PR_URL}'
        title: 'GitHub PR'
        if_set: 'PR_URL'
    apps:
      - name: 'Cursor'
        path: '${WORKTREE_PATH}'
      - name: 'Xcode'
        path: '${WORKTREE_PATH}/${IOS_APP_DIR}/${SCHEME}.xcodeproj'
        if_set: 'IOS_APP_DIR'
    commands:
      - name: 'Generate Xcode project'
        run: 'cd "${WORKTREE_PATH}/${IOS_APP_DIR}" && xcodegen generate'
      - name: 'Setup QA simulator'
        run: '${SCRIPT_DIR}/setup-qa-simulator.sh --worktree ${WORKTREE_PATH} --issue-key ${ISSUE_KEY} --ios-app-dir "${IOS_APP_DIR}" --bundle-id ${BUNDLE_ID}'
        background: true

  backend:
    keywords:
      - backend
      - api
      - server
      - database
      - migration
    display_name: 'Backend Service'
    # No iOS configuration for backend-only work
    github:
      label: 'platform'
    links:
      - url: 'https://linear.app/stardust-labs/issue/${ISSUE_KEY}'
        title: 'Linear Issue'
      - url: '${PR_URL}'
        title: 'GitHub PR'
        if_set: 'PR_URL'
    apps:
      - name: 'Cursor'
        path: '${WORKTREE_PATH}'
    commands:
      - name: 'Sync dependencies'
        run: 'cd ${WORKTREE_PATH} && uv sync --all-groups'
        continue_on_error: true
```

## Template Variables

The following variables are available for use in templates:

| Variable              | Description                                | Example                                                  |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `${ISSUE_KEY}`        | Issue key                                  | `STA-361`                                                |
| `${ISSUE_NUMBER}`     | Numeric part of issue key                  | `361`                                                    |
| `${ISSUE_URL}`        | Full issue URL (tracker-specific)          | `https://linear.app/...` or `https://jira.../browse/...` |
| `${TITLE}`            | Issue title                                | `Add dark mode`                                          |
| `${DESCRIPTION}`      | Issue description                          | (full text)                                              |
| `${WORKTREE_PATH}`    | Full path to worktree                      | `/Users/charlie/.worktrees/stardust-labs/STA-361`        |
| `${REPO_ROOT}`        | Git repository root                        | `/Users/charlie/code/stardust-labs`                      |
| `${REPO_NAME}`        | Repository directory name                  | `stardust-labs`                                          |
| `${PR_URL}`           | GitHub PR URL (may be empty)               | `https://github.com/...`                                 |
| `${MR_URL}`           | GitLab MR URL (may be empty)               | `https://gitlab.com/.../merge_requests/1`                |
| `${SCRIPT_DIR}`       | Directory containing dow/idow scripts      | `/path/to/_dev/scripts/pappardelle/scripts`              |
| `${HOME}`             | User home directory                        | `/Users/charlie`                                         |
| `${VCS_LABEL}`        | VCS label from profile (provider-agnostic) | `stardust_jams`                                          |
| `${GITHUB_LABEL}`     | Deprecated alias for `${VCS_LABEL}`        | `stardust_jams`                                          |
| `${TRACKER_PROVIDER}` | Issue tracker provider name                | `linear` or `jira`                                       |
| `${VCS_PROVIDER}`     | VCS host provider name                     | `github` or `gitlab`                                     |

Additionally, any keys defined in a profile's `vars` section become template variables. For example, `vars: { IOS_APP_DIR: "_ios/MyApp" }` makes `${IOS_APP_DIR}` available in all templates.

### Variable Expansion

Variables are expanded using `${VAR_NAME}` syntax. Environment variables are also available.

```yaml
# All of these work:
path: "${WORKTREE_PATH}"
path: "${HOME}/.worktrees/${REPO_NAME}/${ISSUE_KEY}"
run: "echo ${ISSUE_KEY} | tr '[:upper:]' '[:lower:]'"
```

### Conditional Fields

Use `if_set` to only include an item when a variable has a non-empty value:

```yaml
links:
  - url: '${PR_URL}'
    title: 'GitHub PR'
    if_set: 'PR_URL' # Only opens if PR_URL is not empty
```

## Profile Selection Logic

When running `dow` or `idow` with a description (not an existing issue key):

1. **Keyword Matching**: Each word in the input is checked against all profile keywords
2. **Auto-selection**: If keywords match exactly one profile, it's auto-selected
3. **Disambiguation**: If multiple profiles match, user is prompted to choose
4. **No Match**: User is prompted to select from all profiles
5. **Explicit Override**: User can always type a different profile name

### Selection Flow

```
User input: "add playlist shuffle feature"

1. Tokenize: ["add", "playlist", "shuffle", "feature"]
2. Match against keywords:
   - stardust-jams: "playlist" matches! (score: 1)
   - king-bee: no matches (score: 0)
   - backend: no matches (score: 0)
3. Single winner → auto-select stardust-jams
4. Proceed with workspace setup

User input: "fix api bug"

1. Tokenize: ["fix", "api", "bug"]
2. Match against keywords:
   - stardust-jams: no matches
   - king-bee: no matches
   - backend: "api" matches! (score: 1)
3. Single winner → auto-select backend
4. Proceed with workspace setup

User input: "update homepage"

1. Tokenize: ["update", "homepage"]
2. Match against keywords: no matches
3. Prompt user: "Select a project profile:"
   [1] Stardust Jams (iOS Music App)
   [2] King Bee (iOS Spelling Game)
   [3] Backend Service
```

## Error Handling

### Missing Config File

```
Error: No .pappardelle.yml found at repository root.

Pappardelle requires a configuration file to operate.
Please create .pappardelle.yml at: /path/to/repo/.pappardelle.yml

See https://github.com/chardigio/pappardelle for the configuration schema.
```

### Invalid Config

```
Error: Invalid .pappardelle.yml configuration.

- profiles.stardust-jams.vars.BUNDLE_ID: must be a string
- profiles.backend.commands[0].run: must be a string

Please fix the configuration and try again.
```

### Profile Not Found

```
Error: Profile "nonexistent" not found.

Available profiles:
  - stardust-jams: Stardust Jams (iOS Music App)
  - king-bee: King Bee (iOS Spelling Game)
  - backend: Backend Service
```

## Implementation Components

### pappardelle/source/config.ts

New module for configuration handling:

```typescript
import YAML from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';

interface PappardelleConfig {
	version: number;
	default_profile: string;
	issue_tracker?: {
		provider: 'linear' | 'jira';
		base_url?: string; // Required for jira
	};
	vcs_host?: {
		provider: 'github' | 'gitlab';
		host?: string; // For self-hosted GitLab
	};
	post_worktree_init?: CommandConfig[]; // Commands to run after worktree creation
	terminal?: {
		app?: string; // Terminal app name (default: iTerm)
	};
	profiles: Record<string, Profile>;
}

interface Profile {
	keywords: string[];
	display_name: string;
	team_prefix?: string; // Override global team_prefix for issue creation
	claude?: {
		initialization_command?: string; // Override global init command for this profile
	};
	vars?: Record<string, string>; // Generic template variables
	vcs?: {
		label: string; // Provider-agnostic VCS label for PRs/MRs
	};
	github?: {
		label: string; // Legacy alias, still supported
	};
	links?: LinkConfig[];
	apps?: AppConfig[];
	post_worktree_init?: CommandConfig[]; // Profile-specific post-worktree-init commands
	commands?: CommandConfig[];
}

// Load config from git root
function loadConfig(): PappardelleConfig {
	const repoRoot = execSync('git rev-parse --show-toplevel', {
		encoding: 'utf-8',
	}).trim();
	const configPath = path.join(repoRoot, '.pappardelle.yml');

	if (!fs.existsSync(configPath)) {
		throw new ConfigNotFoundError(repoRoot);
	}

	const content = fs.readFileSync(configPath, 'utf-8');
	const config = YAML.load(content) as PappardelleConfig;

	validateConfig(config);
	return config;
}

// Template variable expansion
function expandTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\$\{(\w+)\}/g, (match, varName) => {
		return vars[varName] ?? process.env[varName] ?? match;
	});
}

// Profile selection based on keywords
function selectProfile(
	config: PappardelleConfig,
	input: string,
): {profile: Profile; profileName: string} | null {
	const words = input.toLowerCase().split(/\s+/);
	const matches: Array<{name: string; score: number}> = [];

	for (const [name, profile] of Object.entries(config.profiles)) {
		const score = profile.keywords.filter(kw =>
			words.some(w => w.includes(kw.toLowerCase())),
		).length;

		if (score > 0) {
			matches.push({name, score});
		}
	}

	// Sort by score descending
	matches.sort((a, b) => b.score - a.score);

	if (matches.length === 1) {
		return {
			profile: config.profiles[matches[0].name]!,
			profileName: matches[0].name,
		};
	}

	return null; // Multiple or no matches - need user input
}
```

### dow/idow Script Updates

The bash scripts will be updated to:

1. Read `.pappardelle.yml` using `yq` (YAML processor for bash)
2. Implement keyword matching logic
3. Prompt for profile selection when needed
4. Extract profile values for use in workspace setup

```bash
# Load config
CONFIG_PATH="$(git rev-parse --show-toplevel)/.pappardelle.yml"
if [[ ! -f "$CONFIG_PATH" ]]; then
    error "No .pappardelle.yml found at repository root"
fi

# Select profile based on input
select_profile() {
    local input="$1"
    # ... keyword matching logic ...
}

# Get profile value
get_profile_value() {
    local profile="$1"
    local path="$2"
    yq -r ".profiles.$profile.$path // empty" "$CONFIG_PATH"
}
```

## Migration Guide

### From Current System

1. Create `.pappardelle.yml` at repository root (see example above)
2. Update dow/idow scripts (automatic with this PR)
3. Test with: `dow "test stardust jams feature"` (should auto-select profile)

### Existing Workspaces

Existing worktrees and workspaces continue to work. The config is only used when creating new workspaces.

## Provider Configuration

### Issue Tracker Providers

Pappardelle supports multiple issue tracker backends. Configure with the top-level `issue_tracker` field.

| Provider | CLI Tool | Default |
| -------- | -------- | ------- |
| `linear` | `linctl` | Yes     |
| `jira`   | `acli`   | No      |

**Linear** (default — no config needed):

```yaml
# These are equivalent:
issue_tracker:
  provider: linear

# Or simply omit the field entirely
```

**Jira** (requires `base_url`):

```yaml
issue_tracker:
  provider: jira
  base_url: https://mycompany.atlassian.net
```

### VCS Host Providers

Configure with the top-level `vcs_host` field.

| Provider | CLI Tool | Default |
| -------- | -------- | ------- |
| `github` | `gh`     | Yes     |
| `gitlab` | `glab`   | No      |

**GitHub** (default — no config needed):

```yaml
vcs_host:
  provider: github
```

**GitLab** (optionally specify self-hosted instance):

```yaml
vcs_host:
  provider: gitlab
  host: gitlab.mycompany.com # Optional, defaults to gitlab.com
```

### Backwards Compatibility

Omitting `issue_tracker` and `vcs_host` defaults to Linear + GitHub. Existing configs that don't specify these fields continue to work unchanged.

The `github.label` field in profiles is still supported as a legacy alias for `vcs.label`. If both are present, `vcs.label` takes precedence.

### Example: Jira + GitLab Configuration

```yaml
version: 1

issue_tracker:
  provider: jira
  base_url: https://mycompany.atlassian.net

vcs_host:
  provider: gitlab
  host: gitlab.mycompany.com

default_profile: backend

profiles:
  backend:
    keywords:
      - backend
      - api
      - server
    display_name: 'Backend Service'
    vcs:
      label: 'backend'
    links:
      - url: '${ISSUE_URL}'
        title: 'Jira Issue'
      - url: '${MR_URL}'
        title: 'GitLab MR'
        if_set: 'MR_URL'
    apps:
      - name: 'Cursor'
        path: '${WORKTREE_PATH}'
    commands:
      - name: 'Install dependencies'
        run: 'cd ${WORKTREE_PATH} && npm install'
```

### CLI Tool Requirements

| Provider | Tool     | Install                                                                                |
| -------- | -------- | -------------------------------------------------------------------------------------- |
| Linear   | `linctl` | `brew tap raegislabs/linctl && brew install linctl`                                    |
| Jira     | `acli`   | See [Atlassian CLI docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) |
| GitHub   | `gh`     | `brew install gh`                                                                      |
| GitLab   | `glab`   | `brew install glab`                                                                    |

## Claude Configuration

The `claude` section configures how Claude is initialized when opening a new workspace session. It can be set globally and/or per-profile.

```yaml
# Global (applies to all profiles unless overridden)
claude:
  initialization_command: '/idow' # Optional, default: empty
  dangerously_skip_permissions: true # Optional, default: false

profiles:
  stardust-jams:
    # Per-profile override (takes precedence over global)
    claude:
      initialization_command: '/do-stardust'
```

| Field                          | Type      | Default | Description                                                                                                                                                  |
| ------------------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialization_command`       | `string`  | `""`    | Command passed to Claude when opening a new session. Typically a skill name like `/idow` or `/dow`. When empty, Claude opens with no initialization command. |
| `dangerously_skip_permissions` | `boolean` | `false` | When `true`, Claude is launched with `--dangerously-skip-permissions`. This bypasses all permission prompts. Only enable in trusted repositories.            |

The initialization command is combined with the issue key: `<command> <issue-key>` (e.g., `/idow STA-481`).

**Per-profile overrides**: When a profile defines `claude.initialization_command`, it takes precedence over the global value. This allows different profiles to use different initialization skills (e.g., `/do-stardust` for profiles that use a TODO.md checklist workflow).

## Issue Watchlist

The `issue_watchlist` section enables automatic workspace creation for issues assigned to you. Pappardelle polls the issue tracker every 30 seconds and spawns workspaces for matching issues that don't already have one.

```yaml
issue_watchlist:
  assignee: me           # 'me' auto-detects from CLI, or use explicit username/email
  statuses:
    - To Do
    - In Progress
    - In Review
```

| Field      | Type       | Required | Description                                                                                                          |
| ---------- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `assignee` | `string`   | Yes      | The issue tracker username/email to match. Use `me` for auto-detection via the CLI tool (linctl/acli).               |
| `statuses` | `string[]` | Yes      | Non-empty list of issue status names to watch. Only issues with one of these statuses will trigger workspace creation. |

**How it works:**
1. Pappardelle polls the issue tracker every 30 seconds using the configured assignee and statuses
2. For Linear: calls `linctl issue list --assignee <user> --state <status>` per status
3. For Jira: uses JQL `assignee = currentUser() AND status IN ("To Do", "In Progress")`
4. New issues (not already in the space list) are auto-spawned as full workspaces via `idow`
5. Each issue is only spawned once per Pappardelle session (tracked in memory)

**Note:** The `assignee: me` value uses `currentUser()` in Jira JQL and `me` in linctl, both of which resolve to the authenticated user automatically.

## Post-Worktree-Init Commands

The `post_worktree_init` section defines commands to run after a git worktree is created. Without this section, `create-worktree.sh` only creates the branch — no file copying, env setup, or dependency installation.

Commands use the same `CommandConfig` format as profile commands, with full template variable support.

### Global Post-Worktree-Init

```yaml
post_worktree_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'
  - name: 'Set PORT'
    run: "sed -i '' 's/^PORT=.*/PORT=5${ISSUE_NUMBER}/' ${WORKTREE_PATH}/.env"
  - name: 'Install dependencies'
    run: 'cd ${WORKTREE_PATH} && uv sync --quiet'
    continue_on_error: true
```

### Per-Profile Post-Worktree-Init

Profiles can also define `post_worktree_init` commands that run _after_ the global ones. This is useful for profile-specific setup like creating TODO checklists or generating project files.

```yaml
profiles:
  stardust-jams:
    post_worktree_init:
      - name: 'Create TODO.md'
        run: 'cp ${REPO_ROOT}/.claude/skills/do-stardust/TODO-TEMPLATE.md ${WORKTREE_PATH}/TODO.md'
```

Global commands always run first, then profile-specific commands. Both use the same `CommandConfig` format.

Each command entry uses the `CommandConfig` structure:

| Field               | Type      | Default  | Description                                               |
| ------------------- | --------- | -------- | --------------------------------------------------------- |
| `name`              | `string`  | Required | Human-readable name for logging                           |
| `run`               | `string`  | Required | Command to execute (supports template variables)          |
| `continue_on_error` | `boolean` | `false`  | If true, subsequent commands still run even if this fails |
| `background`        | `boolean` | `false`  | If true, run command in background without waiting        |

### Example: Python project

```yaml
post_worktree_init:
  - name: 'Copy .env'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null || true'
  - name: 'Set PORT'
    run: "sed -i '' 's/^PORT=.*/PORT=5${ISSUE_NUMBER}/' ${WORKTREE_PATH}/.env"
  - name: 'Install dependencies'
    run: 'cd ${WORKTREE_PATH} && uv sync --quiet'
    continue_on_error: true
```

### Example: Node.js project

```yaml
post_worktree_init:
  - name: 'Copy env files'
    run: 'cp -n ${REPO_ROOT}/.env ${WORKTREE_PATH}/.env 2>/dev/null; cp -n ${REPO_ROOT}/.env.local ${WORKTREE_PATH}/.env.local 2>/dev/null || true'
  - name: 'Install dependencies'
    run: 'cd ${WORKTREE_PATH} && npm install'
    continue_on_error: true
```

### Example: Minimal (no setup)

```yaml
# Omit the post_worktree_init section entirely — just creates the branch
```

## Terminal Configuration

The `terminal` section configures which terminal application is used for workspace windows.

```yaml
terminal:
  app: 'iTerm' # Currently only iTerm is supported
```

| Field | Type     | Default | Description                                                     |
| ----- | -------- | ------- | --------------------------------------------------------------- |
| `app` | `string` | `iTerm` | Terminal application name. Currently only `iTerm` is supported. |

When omitted, defaults to iTerm.

## Lifecycle Hooks

The `hooks` section defines commands that run at specific points during workspace setup.

```yaml
hooks:
  post_workspace_create:
    - name: 'Run setup script'
      run: 'cd ${WORKTREE_PATH} && ./setup.sh'
      continue_on_error: true
      background: false
```

### Hook Points

| Hook                    | When it Runs                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `post_workspace_create` | After workspace setup is complete (worktree created, PR created, apps opened), before final summary |

### Hook Command Fields

Each hook entry uses the same `CommandConfig` structure as profile commands:

| Field               | Type      | Default  | Description                                                |
| ------------------- | --------- | -------- | ---------------------------------------------------------- |
| `name`              | `string`  | Required | Human-readable name for logging                            |
| `run`               | `string`  | Required | Command to execute (supports template variables)           |
| `continue_on_error` | `boolean` | `false`  | If true, workspace setup continues even if this hook fails |
| `background`        | `boolean` | `false`  | If true, run command in background without waiting         |

### Available Template Variables in Hooks

All standard template variables are available: `${SCRIPT_DIR}`, `${WORKTREE_PATH}`, `${ISSUE_KEY}`, `${REPO_ROOT}`, `${REPO_NAME}`, `${PR_URL}`, plus any profile `vars`.

## Local Overrides (`.pappardelle.local.yml`)

You can create a `.pappardelle.local.yml` file in the same directory as `.pappardelle.yml` for personal keybinding overrides. This file is gitignored so it won't create noise in version control.

The local file uses the same schema but only the `keybindings` section is merged. It supports three operations:

- **Add**: Keybindings with keys not in the base config are added
- **Override**: Keybindings whose key matches a base keybinding replace it entirely
- **Disable**: Keybindings with `disabled: true` remove that key from the active set

```yaml
# .pappardelle.local.yml — personal overrides (gitignored)
keybindings:
  # Add a personal binding
  - key: 'V'
    name: 'Open in VS Code'
    run: 'code ${WORKTREE_PATH}'
  # Override the repo-wide X binding
  - key: 'X'
    name: 'Open in Nova'
    run: 'nova ${WORKTREE_PATH}'
  # Disable a binding I don't use
  - key: 'r'
    disabled: true
```

Reserved keys (`j`, `k`, `g`, `i`, `d`, `o`, `n`, `e`, `p`, `q`, `?`) remain blocked in both files. Duplicate detection applies across the merged result.

If the local file has syntax errors, config loading fails with an error message mentioning the local file.

## Custom Keybindings

The `keybindings` section defines custom keyboard shortcuts that execute bash commands in the context of the currently selected workspace's worktree directory.

```yaml
keybindings:
  - key: 'b'
    name: 'Build iOS app'
    run: 'cd ${WORKTREE_PATH}/${IOS_APP_DIR} && xcodebuild build'
  - key: 't'
    name: 'Run tests'
    run: 'cd ${WORKTREE_PATH} && uv run pytest'
  - key: 'a'
    name: 'Address PR feedback'
    send_to_claude: '/address-pr-feedback'
```

### Keybinding Fields

| Field            | Type     | Description                                                                              |
| ---------------- | -------- | ---------------------------------------------------------------------------------------- |
| `key`            | `string` | Single character key to bind (must not conflict with built-in shortcuts)                 |
| `name`           | `string` | Human-readable name shown in help overlay and status messages                            |
| `run`            | `string` | Command to execute (supports template variables). Use either `run` or `send_to_claude`.  |
| `send_to_claude` | `string` | Text to send to the Claude pane (sent with Enter). Use either `run` or `send_to_claude`. |

### Reserved Keys

The following keys are reserved for built-in shortcuts and cannot be used for custom keybindings:

`j`, `k`, `g`, `i`, `d`, `o`, `n`, `e`, `p`, `?`

Additionally, `Enter` and `Delete` are reserved but use special key codes (not single characters).

### Behavior

- **`run` keybindings**: Commands run with `cwd` set to the selected workspace's worktree path. Status is shown in the header: "Running: {name}..." then "✓ {name} ({time})" or "✗ {name} failed". Only one custom command can run at a time. Template variables are expanded using the selected workspace's context.
- **`send_to_claude` keybindings**: Text is sent directly to the Claude viewer pane (with Enter). Any partial input in the Claude prompt is cleared first. Useful for sending slash commands like `/address-pr-feedback`.
- Custom keybindings appear in the help overlay (`?`) under a "Custom Commands" section. `send_to_claude` keybindings show "→ Claude" to indicate they target the Claude pane.

### Template Variables in Keybindings

All standard template variables are available: `${WORKTREE_PATH}`, `${ISSUE_KEY}`, `${REPO_ROOT}`, `${REPO_NAME}`, `${SCRIPT_DIR}`, `${VCS_LABEL}`, plus any profile `vars`.

Profile-specific variables (like `IOS_APP_DIR`) are resolved by matching the selected workspace's issue title against profile keywords. If no match is found, the default profile is used.
