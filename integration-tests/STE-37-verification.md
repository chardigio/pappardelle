# STE-37 acceptance verification

Verified on 2026-11-03 after rebasing onto upstream/main `459111c`, which merged [agent profiles, PR #37](https://github.com/chardigio/pappardelle/pull/37). Repository checks use Node 22.22.3.

## Installed-agent capability check

All five installed CLIs completed real model turns in isolated tmux fixtures with normal authentication and permissions. Pi and OpenCode retained their existing Tailscale Aperture providers. No sign-ins or user configuration changes were added.

| Installed agent     | Source under tmux                 | Live result                                                                            |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| Codex 0.166.0       | Native, no opt-in                 | Six TUI rail checks and 14 standalone checks passed                                    |
| Pi 1.5.0            | Native with `PI_PROGRAM_STATUS=1` | 21 checks passed, including dialogs, interruption, exit and resume                     |
| OpenCode 2.2.5      | Native, no opt-in                 | Six checks passed: real Aperture reply, root/child states, completion and shell return |
| agy 1.4.12          | Native with `AGY_CLI_OSC7501=on`  | Six checks passed using the production session environment                             |
| Claude Code 2.1.317 | Existing hooks                    | 18 checks passed: questions, permissions, interruption recovery, exit and resume       |

OpenCode and agy now have positive verifiers. Codex reports `done` on completion in the verified scenarios; its verifier accepts valid idle/done outcomes while still requiring a genuine reply rather than an echoed prompt.

Without their overrides, Pi and agy query capabilities but do not emit native state through this tmux path. Both overrides are set by the TUI and shell launchers. agy's setting is documented in its [1.4.0 changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md). Claude's native support remains query-gated; no documented force-on setting was found, so its hooks remain the supported source here.

## Transport and shell handling

Agents use their original tmux PTY. A read-only `pipe-pane -Oo` consumer parses [OSC 7501 reports](https://www.superlogical.com/rex/docs/build/program-status), writes atomic snapshots, and never injects capability replies or keyboard input. No Python PTY proxy, forwarding relay, or agent-specific protocol wrapper remains.

The temporary startup gate attaches monitoring before the first report, then execs the existing command handoff. The handoff runs the configured interactive shell and returns to a responsive login shell on exit. An agent-only OSC 133 A marker clears active records while preserving done/error. Companion behavior remains unchanged.

One passive Node monitor per pane and five-second fallback probes remain intentional. Watcher updates read the known snapshot without tmux discovery; existing ten-second full reconciliation detects replacement. External replacement retaining its old pipe/lease can remain cached until reconciliation. Unrelated pane pipes are preserved.

## Defects reproduced and fixed

| Defect                                                 | Verified remediation                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| TUI launch depended on tmux's default shell            | Explicit shell argv forwarding; real Nushell 0.116.1 now launches correctly                                |
| Abrupt agent exit left working/blocked status          | Both launchers clear active status at the login-shell handoff, retain done/error, and preserve input       |
| Viewer/self-session detection ignored selected sockets | Named and quoted absolute sockets use the same selector throughout                                         |
| Window/split selection redirected monitoring           | Session metadata pins the agent pane; unrelated panes remain unmonitored                                   |
| CLI/orphan teardown retained snapshots and leases      | Normal/detached/orphan cleanup removes generations; partial failures and sibling keys/repos stay protected |
| Late publication recreated deleted messages            | Lease-first revocation and a post-rename check prevent a paused publisher recreating snapshots             |
| One failed probe discarded live state                  | Inconclusive failures retain state; EOF and confirmed pane-process death still retire monitors             |
| Gate release failure stranded startup                  | Pending metadata recovers on reuse; an ambiguous successful delivery never kills its agent                 |
| File events repeatedly spawned discovery               | Warm watcher updates require zero tmux commands; full reads still reconcile                                |
| Obsolete watcher duplicated production code            | Dead helpers removed; relevant burst/tool assertions moved to the real watcher                             |

Claude's legacy cancellation limitation is preserved: cancelling permission can leave attention until another hook event. QA verified actual interruption, no denied write, and recovery on the next real turn. It does not claim cancellation emits an immediate idle hook.

## Running TUI evidence

The Codex workspace verifier launched the built TUI with a named `command: codex` profile, an isolated home/repository, and a custom socket. Both actual viewer clients used that server. Captured rail frames:

```text
agent profile launch, native idle       ● main
real model turn, native working         ✢ main
completed turn, native done             ● main
tool approval, native blocked           ! main
approved tool completes, native done    ● main
agent exit, authoritative unknown       ? main
```

The approved fixture file contained the expected text. The separate actual App verifier passed persisted idle, child question, authentication attention and completion through its watcher and WorkspaceRefresh.

## Local validation

- TypeScript build and full-repository Prettier/XO checks
- Full AVA run with `--serial --concurrency=1 --timeout=5m`; its three obsolete command-shim failures were adapted to explicit launch argv and rerun separately
- 196 Python hook checks
- 49 shell-launch checks and shellcheck
- 23 launcher regressions and 53 targeted socket/attachment/reaper cases
- 21 deterministic transport checks
- Six lifecycle checks, including transient probe recovery, owner death without EOF and late publication cancellation
- Five cleanup checks through real monitored sessions and default CLI dependencies
- Four checks through the actual Ink App

Lifecycle and cleanup checks run in CI alongside transport and App checks. Live-agent checks are opt-in and never run in CI.

## Cleanup

Private fixture servers, agents, background publishers, temporary repositories/homes, tool files, authentication symlinks and generated provider-session data are removed after runs, including failed attempts. Retained evidence contains only nonsensitive fixture events and rail frames. Eighteen nonsensitive Claude entries and two agy entries remain in their shared append-only histories: rewriting concurrently used user history files could discard unrelated entries. User sessions and provider settings remain unchanged.
