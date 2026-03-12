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
npm install

# Run tests
npm test

# Build
npm run build
```

## Running tests

```bash
# Unit tests (ava)
npx ava 'source/**/*.test.ts'

# Python hook tests
pip install pytest
pytest hooks/ -v
```

## Code style

- TypeScript source lives in `source/`
- Python hooks live in `hooks/`
- Prettier handles formatting (see `.prettierignore`)
- Keep changes focused — one logical change per PR

## Questions?

Open an issue if you have questions or want to discuss a change before implementing it.
