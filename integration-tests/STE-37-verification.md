# STE-37 acceptance verification

Verified on 2026-10-20 with Claude Code 2.1.302, Pi 1.3.0, Codex 0.163.0, and tmux next-3.9. The branch remains based on [PR #37](https://github.com/chardigio/pappardelle/pull/37) at `3f3fab8898b5591af5b550d165a28b63fd80e16c`.

## Transport

Agents run directly in the normal launch shell. There is no Python PTY proxy or proxy-specific process-ancestry handling. A persistent, read-only `pipe-pane -Oo` monitor captures native reports and writes atomic snapshots. It never injects capability replies or keyboard input.

Agent sessions set `PI_PROGRAM_STATUS=1` through both production launchers, including shells where the agent is later restarted by hand. Pi bypasses capability negotiation; Codex reports without negotiation. Claude retains its existing hooks. Other programs that require a successful capability query are not enabled by this monitor.

The startup gate remains so the monitor attaches before an agent can emit its first report. The shell launcher uses the TUI's selected Node executable, including when PATH has no Node or a stale Node. Python is no longer required for status transport or agent startup; the existing Claude hooks still use Python.

## Installed agents

| Agent               | Source                                                          | Result                                               |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Claude Code 2.1.302 | Existing status hooks                                           | 18 live checks passed                                |
| Pi 1.3.0            | Native OSC 7501, forced with the production session environment | 21 live checks passed                                |
| Codex 0.163.0       | Native OSC 7501 through the real TUI workspace                  | Six live rail checks and 14 standalone checks passed |

### Claude

`verify-program-status-claude.ts --live --keep` uses only the status-update entries from `hooks/settings.json.example`. Authentication and manual permissions remain active. Startup and resume report idle, prompts report working, questions render a question mark, Bash permission requests render attention, and Stop reports idle. Approved writes are checked in the disposable fixture; cancelled writes remain absent. Subsequent turns, keyboard interruption, shell return, and resume work. Parsed traces contain no native status reports.

Legacy behavior is preserved: Escape cancellation can leave the last hook status active or waiting until another hook event occurs. The next prompt and completion recover the indicator. SessionEnd maps to idle rather than authoritative native clear.

Evidence: `pappa-program-status-SB5PB9/verification.json` in the printed temporary directory.

### Pi

`verify-program-status-pi.ts --live --keep` uses its existing Tailscale Aperture provider configuration (`openai/gpt-6.1-sol`). Native idle, working, done, question and permission dialogs, decoded messages, approval, denial, interruption, another turn, exit/clear, and resume reach the monitor, source resolver, and Ink row. A conflicting Claude hook cannot replace native completion. The temporary extension opens Pi's own dialogs and emits no protocol sequences.

Evidence: `pappa-program-status-pfNnDD/pi-verification.json` in the printed temporary directory.

### Codex workspace

`verify-program-status-codex-workspace.ts --live --keep` runs the built TUI with its real three-pane layout in an isolated home and repository. A named agent profile has `command: codex` and is selected for the main workspace. The production TUI launches its agent session, and the fixture checks both native snapshots and actual rail text.

| Scenario                   | Rail result                                         |
| -------------------------- | --------------------------------------------------- |
| Profile launches Codex     | Green idle dot                                      |
| Real model turn            | Animated working indicator                          |
| Turn completes             | Green idle dot                                      |
| Command needs approval     | Attention indicator                                 |
| Approved command completes | Green idle dot; fixture file contains expected text |
| Agent exits                | Authoritative unknown indicator                     |

Codex reports completion as idle in these scenarios. Its optional kind, message, progress, title, error, and child records were not triggered. Temporary authentication symlinks and Codex homes are removed even with `--keep`.

Evidence: `/private/tmp/pappa-codex-rail-r85RFW/codex-workspace-verification.json` and `codex-rail-transcript.md`.

### Earlier negative checks

On 2026-10-13, installed OpenCode 2.0.28 and agy 1.3.4 completed real model turns but emitted no native status. Their indicators remained unknown. OpenCode used Tailscale Aperture; agy used its existing Gemini configuration. Those versions were not rerun for proxy removal. Their negative verifier now uses a plain shell.

## Account-free verification

- Ten production-launcher checks pass: primary-session recording and nested-agent rejection for Claude and Codex through both launchers; Pi's environment and normal shell-pipeline SIGPIPE behavior; startup, input, initial status, and shell return without Python; selected Node monitoring with missing or stale PATH Node
- The deterministic transport verifier passes 21 checks, including unanswered capability queries, native reports, both launch paths, hook fallback, source precedence, child records, monitor persistence, keyboard input, resizing, pane generations, concurrent attachments, repository isolation, unrelated pipes, and deletion followed by late monitor exit
- Four checks pass through the actual Ink App, filesystem watcher, and WorkspaceRefresh: persisted idle, child question, authentication attention, and completion
- All 186 Python hook checks pass, including primary-agent recording; proxy tests are removed with the proxy
- All 46 shell-launch checks and shellcheck pass
- TypeScript build, integration-verifier type checks, and package dry run pass; the package no longer includes a Python proxy
- Full npm test passes Prettier, XO, and all 2,537 AVA checks on Node 22.22.3 with concurrency one

The live agent checks use Node 26.12.0. Repository checks use Node 22.22.3, matching CI's Node major. The existing filesystem-watcher test can miss its initial event under load; it passed separately and in the final serial full-suite run after one parallel full-suite timeout.
