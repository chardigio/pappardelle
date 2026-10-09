# STE-37 acceptance verification

Verified locally on 2026-10-08 with Claude Code 2.1.295, Node 26.11.1, and tmux next-3.9.

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

Only parsed status events and fixture indicator frames are retained. Native auth, error, child records, and optional progress/title were not triggered; deterministic fixtures cover them. Released Codex 0.162.0 was not verified as an OSC 7501 emitter.

The initial raw `pipe-pane -IO` prototype received queries and returned replies, but tmux's DA response reached Claude first and disabled native reporting. The authorized PTY proxy replies before forwarding that DA probe. The deterministic fixture verifies this ordering on every run, and Python tests cover every split boundary and opaque-string preservation.

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
