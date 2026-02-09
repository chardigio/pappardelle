# Pappardelle Configuration System

This document describes the `.pappardelle.yml` configuration file format that controls workspace setup behavior for the Pappardelle TUI and dow/idow scripts.

## Overview

The `.pappardelle.yml` file replaces the previous `.git` directory requirement. Instead of assuming a specific project structure, pappardelle now reads configuration from this file to understand how to set up workspaces for different project types.

**Key Design Decisions:**

- **Repository-wide configuration**: One `.pappardelle.yml` at the git repository root
- **Profile-based**: Different project types (iOS apps, backend services) have named profiles
- **Required**: Pappardelle exits with an error if no config file is found
- **Templated**: Supports variable expansion for dynamic values

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

    # iOS app configuration
    ios:
      app_dir: '_ios/stardust-jams'
      bundle_id: 'com.cd17822.stardust-jams'
      scheme: 'stardust-jams'
      # Optional: simulator device name (default: iPhone 17 Pro)
      simulator: 'iPhone 17 Pro'

    # GitHub PR configuration
    github:
      label: 'stardust_jams'

    # Links to open in browser (templated)
    links:
      - url: 'https://linear.app/stardust-labs/issue/${ISSUE_KEY}'
        title: 'Linear Issue'
      - url: '${PR_URL}'
        title: 'GitHub PR'
        # Optional: only open if variable is non-empty
        if_set: 'PR_URL'

    # Applications to open
    apps:
      - name: 'Cursor'
        path: '${WORKTREE_PATH}'
      - name: 'Xcode'
        path: '${XCODEPROJ_PATH}'
        if_set: 'XCODEPROJ_PATH'
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

    # Window layout configuration (for Aerospace)
    layout:
      # Position numbers follow Aerospace grid (1-9)
      positions:
        iTerm: 1 # Left column, top
        Cursor: 4 # Left column, middle
        Xcode: 8 # Middle column, full height
        Simulator: 3 # Right column, top
        Firefox: 6 # Right column, middle

  king-bee:
    keywords:
      - king
      - bee
      - hive
      - spelling
      - wordle
    display_name: 'King Bee (iOS Spelling Game)'
    ios:
      app_dir: '_ios/King Bee'
      bundle_id: 'com.cd17822.King-Bee'
      scheme: 'King Bee'
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
        path: '${XCODEPROJ_PATH}'
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

| Variable            | Description                           | Example                                           |
| ------------------- | ------------------------------------- | ------------------------------------------------- |
| `${ISSUE_KEY}`      | Linear issue key                      | `STA-361`                                         |
| `${ISSUE_URL}`      | Full Linear issue URL                 | `https://linear.app/...`                          |
| `${TITLE}`          | Issue title                           | `Add dark mode`                                   |
| `${DESCRIPTION}`    | Issue description                     | (full text)                                       |
| `${WORKTREE_PATH}`  | Full path to worktree                 | `/Users/charlie/.worktrees/stardust-labs/STA-361` |
| `${REPO_ROOT}`      | Git repository root                   | `/Users/charlie/code/stardust-labs`               |
| `${REPO_NAME}`      | Repository directory name             | `stardust-labs`                                   |
| `${PR_URL}`         | GitHub PR URL (may be empty)          | `https://github.com/...`                          |
| `${XCODEPROJ_PATH}` | Path to .xcodeproj (may be empty)     | `/path/to/App.xcodeproj`                          |
| `${SCRIPT_DIR}`     | Directory containing dow/idow scripts | `/path/to/_dev/scripts/dow`                       |
| `${HOME}`           | User home directory                   | `/Users/charlie`                                  |
| `${IOS_APP_DIR}`    | iOS app directory from profile        | `_ios/stardust-jams`                              |
| `${BUNDLE_ID}`      | iOS bundle ID from profile            | `com.cd17822.stardust-jams`                       |
| `${SCHEME}`         | Xcode scheme from profile             | `stardust-jams`                                   |
| `${GITHUB_LABEL}`   | GitHub PR label from profile          | `stardust_jams`                                   |

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

- profiles.stardust-jams.ios.bundle_id: required field missing
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
	profiles: Record<string, Profile>;
}

interface Profile {
	keywords: string[];
	display_name: string;
	ios?: {
		app_dir: string;
		bundle_id: string;
		scheme: string;
		simulator?: string;
	};
	github?: {
		label: string;
	};
	links?: LinkConfig[];
	apps?: AppConfig[];
	commands?: CommandConfig[];
	layout?: LayoutConfig;
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

## Future Enhancements

Potential future additions (not in current scope):

- **Profile inheritance**: Base profiles that others extend
- **Remote config**: Fetch config from URL
- **Plugin system**: Custom setup steps
- **Workspace templates**: Pre-configured file scaffolding
