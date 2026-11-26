# Contributing to Pappardelle

Contributions are welcome! Whether it's bug fixes, new features, documentation improvements, or suggestions — we'd love your help.

## How to contribute

1. **Fork** this repository
2. **Create a branch** for your change
3. **Make your changes** and add tests if applicable
4. **Open a pull request** against `main`

## What happens when your PR is merged

When your PR is merged into `main`, a sync-back workflow automatically applies your changes to the upstream monorepo where Pappardelle is developed. Your **git author attribution is preserved** — your name and email will appear on the commit in the monorepo, not ours.

## Development setup

```bash
# Clone the repo
git clone https://github.com/chardigio/pappardelle.git
cd pappardelle

# Install dependencies
bun install --frozen-lockfile

# Build the native executable, then check types
bun run build
bun run typecheck

# Run tests (includes compiled-runtime tests)
bun run test
```

`install.sh` runs `bun run typecheck` before `bun run build`, since `bun build` doesn't typecheck; run from a clone, it installs a copy of the build to `~/.pappardelle/local/`.

`bun run typecheck` checks the source the build ships. `bun run typecheck:test` checks it together with the tests, `test/helpers`, `scripts` and `integration-tests` (`tsconfig.test.json`), since bun strips types without checking them; `bun run test` runs it.

`bun run build` embeds production React, OpenTUI, and Bun startup bytecode in
`dist/pappardelle`, the only file it builds besides its source map. `bun run dev`
keeps the source development workflow.

## Running tests

```bash
# Unit tests (bun test, through scripts/unit-tests.ts)
bun run test:unit

# One file, or several
bun run test:unit source/config.test.ts

# Python hook tests
pip install pytest
test/helpers/tmux-guard-run.sh pytest plugins/pappardelle/hooks/ -v
```

State can live in JSON files or, with `experimental.sqliteState`, in SQLite with the files kept beside it. With the flag on, hook status and program status are stored nowhere: they go through the status daemon, which keeps them in memory. CI runs every suite both ways. `PAPPARDELLE_SQLITE_STATE=1` selects the second for a run, and each test process then gets a database and a status socket of its own, never yours:

```bash
PAPPARDELLE_SQLITE_STATE=1 bun run test:unit
PAPPARDELLE_SQLITE_STATE=1 test/helpers/tmux-guard-run.sh pytest plugins/pappardelle/hooks/ -v
```

The hook tests need `bun` on `PATH` for that run: the CLI creates the database they write to.

`scripts/unit-tests.ts` runs `bun test --parallel`: test files spread across worker processes, each file in a fresh global with its own copy of every module, and the tests within a file one after another. Run the unit tests through it, not with a bare `bun test`: `test/helpers/test-guard.ts`, preloaded into every test file by `bunfig.toml`, stops any file that runs outside the environment it sets up.

A run gets a **run tmpdir** of its own (`/tmp/ptr-*`) as `TMPDIR` for every test, removed when the run ends. Its **leak check** fails a run that otherwise passed when anything is still in the run tmpdir, a tmux server still listens on a socket under it, or a process still names it, and lists what it found. Make temp dirs in tests with `tempDir(prefix)` from `test/helpers/temp-dir.ts`, which removes the dir when the test ends, and undo anything else with `teardown()` from `test/helpers/teardown.ts`, which runs last-registered first when the test ends, pass or fail.

The run also gets a **throwaway HOME** (`/tmp/ph-*`), so nothing a test starts writes to your `~/.pappardelle` or `~/.claude.json`. Bun reads `HOME` once at startup, so `scripts/unit-tests.ts` sets it before the workers start, along with `ZDOTDIR`, and drops the XDG config directories that would bring your zsh and tmux config back. `scripts/test-start-agent-session.sh` runs under a throwaway HOME of its own, with a `claude` shim in place of the real one.

Every run also gets the test tmux guard: the unit tests and the shell tests that start tmux run with a private `TMUX_TMPDIR`, no `TMUX`, and a `tmux` on PATH that refuses any socket in your live tmux directory, where the inner server holding every agent session lives. A refused call fails the run and is listed at the end, even when the test swallowed the error. Fix such a test by giving it the run's `TMUX_TMPDIR` or a `-S` socket of its own.

The suites outside the unit tests that start tmux get the same guard from `test/helpers/tmux-guard-run.sh`. `bun run test:integration` runs each integration check CI runs through it, under a throwaway HOME. `scripts/test-start-agent-session.sh` and `scripts/test-workspace-launchers.sh` put themselves under it. Run the Python hook tests through it yourself:

```bash
test/helpers/tmux-guard-run.sh pytest plugins/pappardelle/hooks/ -v
```

It fails on a refusal, and fails a suite that passed but left a tmux server running in its `TMUX_TMPDIR`. A refusal counts wherever the guard logged it: in the run's own log, or in the shared log under `/tmp/pappardelle-test-tmux-<uid>` that a process which lost the run's environment, such as a systemd timer's, writes to. The integration checks and the hook tests that start tmux refuse to run without the guard.

## Code style

- TypeScript source lives in `source/`
- Python hooks live in `plugins/pappardelle/hooks/`
- Prettier handles formatting (see `.prettierignore`)
- Keep changes focused — one logical change per PR

## Adding a built-in agent

`scripts/builtin-agents.json` holds the defaults each known agent CLI gets (model, effort and prompt flag templates, resume args, skill prefix, and `rules_args`, the flag that hands it the companion rules at launch), keyed by the command's basename. An entry holds only what its CLI has, so pi's has just `rules_args`. The claude entry follows Claude gating (`is_claude`). Both the TUI (`source/builtin-agents.ts`) and `idow` (`scripts/resolve-agent-config.sh`) read it, so supporting a new CLI is one entry there. If the CLI has hooks, `plugins/pappardelle/hooks/record-agent-session.py` can record its session id for `{session_id}`; register it from `source/plugin-install.ts`, in the plugin the way `.antigravity-plugin/` does for agy, or in the CLI's own hooks file the way Codex gets it when the CLI trusts plugin hooks by the whole plugin's contents.

## Questions?

Open an issue if you have questions or want to discuss a change before implementing it.
