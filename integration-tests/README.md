# Integration Tests — Local Verification

Standalone scripts that exercise pappardelle's providers and config against **real instances**. They are _not_ ava tests and are never run in CI.

## Prerequisites

- **Linear**: `linctl` on your PATH, authenticated (`linctl auth login`)
- **Jira**: `acli` on your PATH, authenticated, and `JIRA_BASE_URL` env var
- **GitHub**: `gh` on your PATH, authenticated, run from a repo with a GitHub remote
- **GitLab**: `glab` on your PATH, authenticated, run from a repo with a GitLab remote
- **Config**: run from a repo that has a `.pappardelle.yml`

## Usage

Run from the `pappardelle/` directory:

```bash
# Issue tracker providers
npx tsx integration-tests/verify-linear.ts
npx tsx integration-tests/verify-jira.ts

# VCS host providers
npx tsx integration-tests/verify-github.ts
npx tsx integration-tests/verify-gitlab.ts

# Config system
npx tsx integration-tests/verify-config.ts

# Watchlist end-to-end pipeline
npx tsx integration-tests/verify-watchlist.ts

# Comment posting (creates real comments — clean up after)
npx tsx integration-tests/verify-comments.ts

# Workspace deinit (runs real shell commands in a temp dir)
npx tsx integration-tests/verify-workspace-deinit.ts

# Run all (that apply to your setup)
npx tsx integration-tests/verify-linear.ts && \
npx tsx integration-tests/verify-github.ts && \
npx tsx integration-tests/verify-config.ts && \
npx tsx integration-tests/verify-watchlist.ts
```

## Scripts

| Script | What it verifies |
|--------|-----------------|
| `verify-linear.ts` | getIssue, searchAssignedIssues, label parsing, caching, batch fetch, state colors |
| `verify-jira.ts` | Same as Linear but via acli CLI |
| `verify-github.ts` | PR detection by branch name, changedFiles count, buildPRUrl |
| `verify-gitlab.ts` | MR detection by branch name, diff file count, buildPRUrl |
| `verify-config.ts` | Config loading, validation, profiles, watchlist, keybindings, Claude config |
| `verify-watchlist.ts` | Full pipeline: config → provider fetch → label filter → workspace decision |
| `verify-comments.ts` | createComment on Linear and/or Jira (posts real comments) |
| `verify-workspace-deinit.ts` | Command execution, variable expansion, continue_on_error, cwd fallback |

## Environment Variables

| Variable | Used by | Default |
|----------|---------|---------|
| `LINEAR_ISSUE` | verify-linear, verify-comments | `STA-683` |
| `LINEAR_STATUSES` | verify-linear | `Todo,In Progress` |
| `JIRA_BASE_URL` | verify-jira, verify-comments | (required for Jira scripts) |
| `JIRA_ISSUE` | verify-jira, verify-comments | (auto-detected or required) |
| `JIRA_STATUSES` | verify-jira | `To Do,In Progress` |
| `GITHUB_ISSUE` | verify-github | `STA-683` |
| `GITHUB_PR` | verify-github | (auto-detected) |
| `GITLAB_HOST` | verify-gitlab | `gitlab.com` |
| `GITLAB_ISSUE` | verify-gitlab | (required) |
| `EXISTING_SPACES` | verify-watchlist | (empty) |

A non-zero exit code means something failed.
