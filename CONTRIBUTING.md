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

# Build the native executable and JavaScript fallback, then check types
bun run build
bun run typecheck

# Run tests (includes compiled-runtime tests)
bun run test
```

`bun run build` embeds production React, OpenTUI, and Bun startup bytecode in
`dist/pappardelle`. `bun run dev` keeps the source development workflow. Use
`bun scripts/build.ts --bundle-only` for a JavaScript-only production build;
compiled-runtime tests require the default build.

## Running tests

```bash
# Unit tests (ava)
bun --bun ava 'source/**/*.test.ts'

# Python hook tests
pip install pytest
pytest plugins/pappardelle/hooks/ -v
```

## Code style

- TypeScript source lives in `source/`
- Python hooks live in `plugins/pappardelle/hooks/`
- Prettier handles formatting (see `.prettierignore`)
- Keep changes focused — one logical change per PR

## Adding a built-in agent

`scripts/builtin-agents.json` holds the defaults each known agent CLI gets (model, effort and prompt flag templates, resume args, skill prefix), keyed by the command's basename, except that the claude entry follows Claude gating (`is_claude`). Both the TUI (`source/builtin-agents.ts`) and `idow` (`scripts/resolve-agent-config.sh`) read it, so supporting a new CLI is one entry there. If the CLI has hooks, `hooks/record-agent-session.py` can record its session id for `{session_id}`; see the agy and codex installers in `hooks/`.

## Questions?

Open an issue if you have questions or want to discuss a change before implementing it.
