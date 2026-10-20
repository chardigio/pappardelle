# STE-37 acceptance verification

Claude verified locally on 2026-10-08 with Claude Code 2.1.295. Codex, Pi, OpenCode, and agy were verified on 2026-10-13. Those fixtures used Node 26.11.1 and tmux next-3.9. The installed stable Codex and PR #37 TUI checks used Node 26.12.0 and the same tmux version.

## Native interactive Claude

`npx tsx integration-tests/verify-program-status-claude.ts --live --keep` passed 27 checks through the production PTY proxy, persistent monitor, workspace source resolver, and actual Ink row.

| Scenario                            | Observed native reports and result                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh interactive safe-mode session | `idle:app=claude-code`                                                                                                                            |
| Simple turn and another turn        | `working`, then `done`; completion message arrived as a subsequent replacement report                                                             |
| AskUserQuestion                     | `blocked:kind=question`, then working/completion after Enter; question indicator rendered                                                         |
| Bash permission                     | `blocked:kind=permission`, then working/completion after approval; fixture file contained the expected text                                       |
| Permission denial                   | `idle` after Escape; denied fixture file was absent                                                                                               |
| Keyboard interruption               | Working settled to idle/done; another turn succeeded                                                                                              |
| Exit to shell                       | `clear`; indicator became authoritative unknown                                                                                                   |
| Resume                              | Native idle, working, and done reports continued on the existing pane                                                                             |
| Resume with Pappardelle hooks       | Native status remained authoritative against conflicting hook state; matching Bash tool details appeared during working and cleared on completion |

Only parsed status events and fixture indicator frames are retained. Native auth, error, child records, and optional progress/title were not triggered; deterministic fixtures cover them.

The initial raw `pipe-pane -IO` prototype received queries and returned replies, but tmux's DA response reached Claude first and disabled native reporting. The authorized PTY proxy replies before forwarding that DA probe. The deterministic fixture verifies this ordering on every run, and Python tests cover every split boundary and opaque-string preservation.

## Native interactive Codex

Codex's [OSC 7501 change](https://github.com/openai/codex/pull/52725) merged after stable `0.162.1` was published. Verification used the [0.163.0-alpha.10 prerelease](https://github.com/openai/codex/releases/tag/rust-v0.163.0-alpha.10), downloaded to a temporary directory with its matching code-mode host. The normal Codex installation was unchanged.

`verify-program-status-codex.ts --live --keep` passed 14 checks through the production PTY proxy, persistent monitor, workspace source resolver, and Ink row. Repeating with `--without-proxy` passed the same 14 checks in a plain tmux pane.

Retested on 2026-10-19 with the installed stable `codex-cli 0.163.0`: all 14 checks passed with the proxy and all 14 passed without it. Both runs verified native idle/working/blocked reports, approval and its resulting fixture file, precedence over a conflicting Claude hook, exit cleanup, and resume through the monitor and Ink row. No verifier changes were needed.

| Scenario              | Observed native reports and result                                                     |
| --------------------- | -------------------------------------------------------------------------------------- |
| Fresh session         | `idle:app=codex`; green idle indicator                                                 |
| Turn and another turn | `working:app=codex`, then `idle:app=codex` on completion                               |
| Permission request    | `blocked:app=codex`; attention indicator                                               |
| Permission approval   | `working`, then `idle`; the harmless fixture file contained the expected text          |
| Conflicting hook      | Native Codex idle remained authoritative over a Claude error hook                      |
| Exit                  | `clear`; indicator became authoritative unknown                                        |
| Resume                | Native idle, working, idle on completion, and clear on exit continued on the same pane |

This Codex version reports completion as `idle`, and does not emit `done`, blocking kind, message, title, progress, or child ids in these scenarios. It emits OSC 7501 without a capability query, including through tmux, so its native reporting works without the proxy. Claude still needs the proxy for its capability-query ordering.

The initial standalone Codex download lacked its code-mode host, so tool execution could not request approval. Adding the matching host resolved that fixture setup failure; both complete runs passed. Authentication used a temporary symlink to the existing auth file; the temporary Codex home and link were removed before preserving evidence. No credentials or Codex transcripts were retained in the fixture.

### PR #37 agent-profile integration

Rebased onto [PR #37](https://github.com/chardigio/pappardelle/pull/37) at `3f3fab8898b5591af5b550d165a28b63fd80e16c`. The monitor gate now wraps the generic agent launcher, and the rail resolves the renamed `agent-*` sessions.

`verify-program-status-codex-workspace.ts --live --keep` passed six checks with installed `codex-cli 0.163.0`. It ran the built CLI with its real three-pane tmux layout in a disposable repository, using a named `codex-rail` agent profile with `command: codex`. The TUI created and attached the main workspace's agent session; the fixture checked its profile environment and both native snapshots and the actual rail text.

| Scenario                   | Rail result                                       |
| -------------------------- | ------------------------------------------------- |
| Profile launches Codex     | `● main`, native idle                             |
| Real model turn            | Animated working indicator                        |
| Turn completes             | `● main`, native idle                             |
| Command needs approval     | `! main`, native blocked                          |
| Approved command completes | `● main`; fixture file contains the expected text |
| Codex exits                | `? main`, authoritative unknown                   |

The main workspace selects `codex-rail` through the top-level `agent_profile` setting. The fixture saves a rail transcript and parsed protocol evidence. Its isolated home and tmux socket directory avoid user configuration and sessions; the temporary Codex home and authentication symlink are deleted even when keeping evidence.

## Installed Pi, OpenCode, and agy

| Installed CLI   | Provider used in the fixture                                                                                 | Result                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Pi 1.2.0        | OpenAI `gpt-6.1-sol` through configured Tailscale Aperture (`http://ai/v1`)                                  | 21 positive native-status checks passed                                               |
| OpenCode 2.0.28 | OpenAI `gpt-6.1-sol`; its session metadata and provider config confirmed Tailscale Aperture (`http://ai/v1`) | Real model turn and exit succeeded; no OSC 7501 reports; four negative checks passed  |
| agy 1.3.4       | Existing Antigravity Gemini 3.8 Flash configuration, with low effort for this invocation                     | Real model turn and exit succeeded; no OSC 7501 reports; three negative checks passed |

Pi's [native implementation](https://github.com/earendil-works/pi/issues/10607) detects support before DA1. The fixture did not force `PI_PROGRAM_STATUS`; the production proxy answered detection. Native `idle`, `working`, `done`, `blocked:kind=question`, `blocked:kind=permission`, and `clear` reports reached the monitor, source resolver, and Ink row. Question and confirmation messages decoded correctly. Answering, approving, denying, interrupting, starting another turn, and resuming all restored the expected state. A conflicting Claude hook could not replace native completion. The temporary extension only invoked Pi's own UI dialogs and emitted no OSC sequences. Native auth, error, compaction, and child records were not triggered.

OpenCode's [OSC 7501 PR](https://github.com/anomalyco/opencode/pull/54560) was still open at verification time. Neither installed OpenCode nor agy emitted native reports during startup, a completed real turn, or exit. Their indicators correctly remained unknown with no native records or hook producer; this is an emitter limitation, not a successful native-status integration. No provider sign-ins or global model settings were changed. OpenCode and Pi used their existing Aperture configuration; agy's installed configuration had no model endpoint override.

## Deterministic transport and full app

`verify-program-status.ts --keep` passed 21 checks on an isolated server, including both launch paths, BEL reports, messages/progress, inherited child app, source precedence, TUI restart, prompt cleanup, terminal reset behavior, keyboard input/resizing, pane replacement, concurrent attachment, concurrent repositories, unrelated pipes, and deletion followed by late monitor exit.

`verify-program-status-app.ts --keep` passed four checks mounting the real `App`: persisted idle, child question through the watcher and refresh pipeline, authentication attention, and done while the issue remained open. Tracker/VCS providers used fixture data; status transport and rendering used production code.

AVA covers strict parsing, full replacement, all byte boundaries, exact complete-sequence limits, invalid text, record eviction, aggregation, source changes, stale generations, dead panes, corrupted snapshots, and asynchronous refresh races. Python tests cover hooks and the proxy. Deterministic transport and app checks run in CI; live Claude is opt-in.

## Repository checks

- TypeScript build, package dry run, repository Prettier/XO, and full AVA suite passed through `npm test`
- Python hook/proxy suite: 159 passed
- Session-launch shell suite: 25 passed, including shell-history isolation and a responsive login shell after Claude exits; companion command suite: 12 passed; session-name encoding: 8 passed
- Model/effort shell suite: 44 of 48 passed; four existing iTerm command-assembly assertions could not run because the unchanged AppleScript fails compilation with `Expected “,” but found class name. (-2741)`
- Shellcheck passed for the changed launch script

After rebasing onto main `1a0a6ba`, the build, full `npm test`, deterministic transport, full App checks, and session-launch/companion shell suites passed again. Both launch paths gate the initial command until monitoring is attached, and execute it through the proxy without typing it into shell history.

After rebasing onto PR #37 at `3f3fab8`, the build and full `npm test` passed on Node 22.22.3 (CI's Node major): formatting, XO, and 2,527 AVA checks. The deterministic transport checks (21), full App checks (4), generic agent-launch shell checks (46), shellcheck, and Python hook/proxy checks (189) also passed. The six live Codex workspace checks passed on Node 26.12.0. Node 26 full-suite runs still intermittently miss initial filesystem watcher events in tests; the targeted watcher suites passed five repeated runs on Node 22. The tests now yield before their first fixture write, and the native-status watcher test waits for actual publications instead of a fixed 150 ms sleep.
