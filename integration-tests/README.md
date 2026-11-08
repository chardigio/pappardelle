# Integration Tests — Local Verification

Standalone scripts that exercise pappardelle's providers and config against **real instances**. They are _not_ ava tests. Account-free program status checks also run in CI.

## Program status

Build first, then run the deterministic checks with Node 22+, Python 3, and tmux installed:

```bash
bun run build
bun integration-tests/verify-program-status.ts
bun integration-tests/verify-program-status-app.ts
bun integration-tests/verify-program-status-lifecycle.ts
bun integration-tests/verify-program-status-cleanup.ts
```

The transport test exercises both launch paths on an isolated tmux socket, including read-only capability-query handling, status persistence, source precedence, child records, resizing, pane replacement, and cleanup. The app test mounts the real Ink `App`, its watcher, and `WorkspaceRefresh`, with fixture issue and VCS providers. Narrow row rendering is covered by the transport harness and AVA component tests. The app check requires no automatic watchlists in the merged local configuration.

The lifecycle check covers pinned agent panes across window/split selection, event updates without tmux discovery, transient liveness failures, and lease revocation during an in-flight publication. The cleanup check drives actual CLI close, detached teardown, and orphan reaping, verifying that snapshots and leases are removed only for successfully closed workspaces. Both use isolated tmux servers and temporary status directories.

`source/program-status-launch.test.ts` adds ten account-free checks through the production TUI and shell launchers. Real hook processes verify primary-session recording and nested-agent rejection for Claude and Codex profiles. Restricted pane PATHs verify agent startup, initial status capture, input, and shell return without Python, plus monitoring with the selected Node executable when PATH has no Node or a stale Node. With Python installed, both launchers also verify Pi's forced reporting environment and normal SIGPIPE behavior in shell pipelines. Build first; these checks run with the normal AVA suite when tmux is installed.

## Popups

```bash
bun integration-tests/verify-popup-close.ts
```

Attaches a real tmux client in a pty to a throwaway server, opens popups through `openPopupTerminal`, and checks that `close()` makes each one go away even after a renderer-style read on its input, that the process keeps no fd on the closed popup's pty (Linux only), and that a popup opened right after a close stays open. Runs in CI.

## Interactive agents

To drive real interactive Claude sessions, authenticate Claude Code and opt in explicitly:

```bash
bun integration-tests/verify-program-status-claude.ts --live --keep
```

This uses the existing status-hook configuration from `hooks/settings.json.example`, restricted to status updates, with no PTY proxy or capability replies. It exercises turns, questions, permission approval/denial, interruption, shell return, and resume. Permissions and normal authentication remain active. Harmless tool actions use a disposable fixture directory; the script removes only its own tmux server. `--keep` preserves parsed protocol events and verification frames in the printed temporary directory. It never runs in CI.

To verify interactive Codex, authenticate it and use a build with OSC 7501 support (verified with stable `0.166.0`):

```bash
bun integration-tests/verify-program-status-codex.ts --live --keep
bun integration-tests/verify-program-status-codex-workspace.ts --live --keep
```

`PAPPARDELLE_CODEX_BIN` selects a binary outside your normal installation. Standalone release downloads also require their matching `codex-code-mode-host` executable alongside the Codex binary for tool calls. The fixture uses a temporary Codex configuration, an authentication-file symlink, a read-only sandbox with approval requests, and a harmless approved file write. It verifies idle/working/blocked, completion as idle or done, native precedence, exit, and resume through the monitor and Ink row. It deletes its temporary Codex home and authentication link even with `--keep`; only fixture files, parsed protocol evidence, and indicator frames remain. It never runs in CI.

The workspace verifier runs the built TUI in real tmux panes with an isolated home, repository, and socket directory. A named agent profile uses `command: codex`, and the TUI launches it through normal workspace attachment. It checks native snapshots and the rendered main-workspace rail for idle, working, approval attention, completion, and exit, then saves a rail transcript. `--keep` retains evidence while still removing the temporary Codex home and authentication symlink.

Other installed CLI checks are also opt-in:

```bash
bun integration-tests/verify-program-status-pi.ts --live --keep
bun integration-tests/verify-program-status-opencode.ts --live --keep
bun integration-tests/verify-program-status-agy.ts --live --keep
```

Pi uses its normal provider configuration (`PAPPARDELLE_PI_MODEL` defaults to `openai/gpt-6.1-sol`, and `PAPPARDELLE_PI_BIN` can select another binary). The fixture uses the production agent-session environment to set `PI_PROGRAM_STATUS=1` and registers two temporary extension commands that open Pi's own question and confirmation dialogs; the extension emits no protocol reports. It verifies decoded messages and blocking kinds, real model turns, interruption, hook precedence, exit, and resume. Other extensions, MCP, tools, skills, and context-file discovery are disabled for this fixture.

OpenCode's verifier checks native root and child reports, a real model reply, completion, native precedence, and shell return. Its selected model and configured Aperture endpoint are checked from the fixture session's metadata and configuration. agy's verifier uses the production session environment, including its documented `AGY_CLI_OSC7501=on` opt-in, and checks native idle, working, completion, precedence, and exit. These checks preserve normal provider configuration and permissions, add no sign-ins, and never run in CI.

Each scenario has a timeout. Claude uses hooks, while Pi, Codex, OpenCode, and agy use native reports; auth/error/child records and hard limits also use the synthetic fixture. [STE-37 acceptance results](STE-37-verification.md) record the observed native behavior and remaining capability-negotiation constraints.

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
bun integration-tests/verify-linear.ts
bun integration-tests/verify-jira.ts
bun integration-tests/verify-beads.ts

# VCS host providers
bun integration-tests/verify-github.ts
bun integration-tests/verify-gitlab.ts

# Config system
bun integration-tests/verify-config.ts

# Watchlist end-to-end pipeline
bun integration-tests/verify-watchlist.ts

# Comment posting (creates real comments — clean up after)
bun integration-tests/verify-comments.ts

# Workspace deinit (runs real shell commands in a temp dir)
bun integration-tests/verify-workspace-deinit.ts

# Bash keyword matching (idow match_profiles function)
bash integration-tests/verify-bash-keyword-matching.sh

# claude.model / claude.effort, config → both resolvers → real launch → live claude
# (--no-live skips the one real `claude --print` call)
bun integration-tests/verify-claude-model-effort.ts

# Run all (that apply to your setup)
bun integration-tests/verify-linear.ts && \
bun integration-tests/verify-github.ts && \
bun integration-tests/verify-config.ts && \
bun integration-tests/verify-watchlist.ts
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
