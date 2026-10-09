# Integration Tests — Local Verification

Standalone scripts that exercise pappardelle's providers and config against **real instances**. They are _not_ ava tests. Account-free program status checks also run in CI.

## Program status

Build first, then run the deterministic checks with Node 22+, Python 3, and tmux installed:

```bash
npm run build
npx tsx integration-tests/verify-program-status.ts
npx tsx integration-tests/verify-program-status-app.ts
```

The transport test exercises both launch paths on an isolated tmux socket, including capability-query ordering, status persistence, source precedence, child records, resizing, pane replacement, and cleanup. The app test mounts the real Ink `App`, its watcher, and `WorkspaceRefresh`, with fixture issue and VCS providers. Narrow row rendering is covered by the transport harness and AVA component tests. The app check requires no automatic watchlists in the merged local configuration.

To drive real interactive Claude sessions, authenticate Claude Code 2.1.295 or newer and opt in explicitly:

```bash
npx tsx integration-tests/verify-program-status-claude.ts --live --keep
```

This uses native OSC in safe mode, then resumes with only fixture settings and Pappardelle's status hook. It exercises turns, questions, permission approval/denial, interruption, shell return, and resume. Permissions and normal authentication remain active. Harmless tool actions use a disposable fixture directory; the script removes only its own tmux server. `--keep` preserves parsed protocol events and verification frames in the printed temporary directory. It never runs in CI.

Each scenario has a timeout. Claude does not necessarily emit every protocol field or state; auth/error/child records and hard limits use the synthetic fixture. [STE-37 acceptance results](STE-37-verification.md) record the observed native behavior.

Status directory overrides are `PAPPARDELLE_STATUS_DIR` for hooks and `PAPPARDELLE_PROGRAM_STATUS_DIR` for native snapshots. `PAPPARDELLE_TMUX_SOCKET` selects the isolated server. `PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR` enables bounded, parsed-event traces for verification; screen output is never saved by the monitor. `PAPPARDELLE_CLAUDE_CONFIG_PATH` isolates launch-time trust writes in synthetic tests.

## Prerequisites

- **Linear**: `linctl` on your PATH, authenticated (`linctl auth login`)
- **Jira**: `acli` on your PATH, authenticated, and `JIRA_BASE_URL` env var
- **Beads**: `bd` on your PATH, run from a git repo whose `.beads` database has at least one issue
- **GitHub**: `gh` on your PATH, authenticated, run from a repo with a GitHub remote
- **GitLab**: `glab` on your PATH, authenticated, run from a repo with a GitLab remote
- **Config**: run from a repo that has a `.pappardelle.yml`

## Usage

Run from the `pappardelle/` directory:

```bash
# Issue tracker providers
npx tsx integration-tests/verify-linear.ts
npx tsx integration-tests/verify-jira.ts
npx tsx integration-tests/verify-beads.ts

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

# Bash keyword matching (idow match_profiles function)
bash integration-tests/verify-bash-keyword-matching.sh

# claude.model / claude.effort, config → both resolvers → real launch → live claude
# (--no-live skips the one real `claude --print` call)
npx tsx integration-tests/verify-claude-model-effort.ts

# Run all (that apply to your setup)
npx tsx integration-tests/verify-linear.ts && \
npx tsx integration-tests/verify-github.ts && \
npx tsx integration-tests/verify-config.ts && \
npx tsx integration-tests/verify-watchlist.ts
```

## Scripts

| Script                            | What it verifies                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify-linear.ts`                | getIssue, searchAssignedIssues, label parsing, caching, batch fetch, state colors                                                                            |
| `verify-jira.ts`                  | Same as Linear but via acli CLI                                                                                                                              |
| `verify-beads.ts`                 | Same as Linear but via the bd CLI; read-only unless `BEADS_WRITE=1`                                                                                          |
| `verify-github.ts`                | PR detection by branch name, changedFiles count, buildPRUrl                                                                                                  |
| `verify-gitlab.ts`                | MR detection by branch name, diff file count, buildPRUrl                                                                                                     |
| `verify-config.ts`                | Config loading, validation, profiles, watchlist, keybindings, Claude config                                                                                  |
| `verify-watchlist.ts`             | Full pipeline: config → provider fetch → label filter → workspace decision                                                                                   |
| `verify-comments.ts`              | createComment on Linear and/or Jira (posts real comments)                                                                                                    |
| `verify-workspace-deinit.ts`      | Command execution, variable expansion, continue_on_error, cwd fallback                                                                                       |
| `verify-bash-keyword-matching.sh` | Bash `match_profiles()` in idow: word boundaries, multi-word keywords, false positives                                                                       |
| `verify-claude-model-effort.ts`   | `claude.model`/`claude.effort` across all 3 config layers: bash and TS resolvers agree, flags reach the real `claude` command line, live claude accepts them |

## Environment Variables

| Variable          | Used by                        | Default                     |
| ----------------- | ------------------------------ | --------------------------- |
| `LINEAR_ISSUE`    | verify-linear, verify-comments | `STA-683`                   |
| `LINEAR_STATUSES` | verify-linear                  | `Todo,In Progress`          |
| `JIRA_BASE_URL`   | verify-jira, verify-comments   | (required for Jira scripts) |
| `JIRA_ISSUE`      | verify-jira, verify-comments   | (auto-detected or required) |
| `JIRA_STATUSES`   | verify-jira                    | `To Do,In Progress`         |
| `BEADS_ISSUE`     | verify-beads                   | (first result of `bd list`) |
| `BEADS_STATUSES`  | verify-beads                   | (empty = all ready issues)  |
| `BEADS_ASSIGNEE`  | verify-beads                   | (no assignee filter)        |
| `BEADS_WRITE`     | verify-beads                   | unset (read-only)           |
| `GITHUB_ISSUE`    | verify-github                  | `STA-683`                   |
| `GITHUB_PR`       | verify-github                  | (auto-detected)             |
| `GITLAB_HOST`     | verify-gitlab                  | `gitlab.com`                |
| `GITLAB_ISSUE`    | verify-gitlab                  | (required)                  |
| `EXISTING_SPACES` | verify-watchlist               | (empty)                     |

A non-zero exit code means something failed.

### Workspace startup benchmark

Measure local workspace setup and reopening overhead against another checkout:

```bash
python3 integration-tests/benchmark-workspace-startup.py --baseline /path/to/base-checkout
```

`--candidate` defaults to this checkout and `--samples` to 7.

Requires Bash, Mike Farah's `yq`, `jq`, and Git. Each revision uses isolated home,
config, and workspace directories. Samples alternate between revisions;
the report includes median time, YAML parser invocations, and config merges.
Tracker/VCS calls, worktree checkout, terminal launchers, and Claude are stubbed,
and configured commands are no-ops. These timings measure Pappardelle's local
orchestration cost; actual network, checkout, setup commands, and agent startup
add to the time a user experiences.
