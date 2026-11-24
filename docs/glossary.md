# Glossary

- **Local install**: `install.sh` run from a Pappardelle clone or worktree (`LOCAL_MODE`), as opposed to the curl install, which clones a release to `~/.pappardelle/repo`
- **Snapshot**: the copy of a local install's build, scripts and plugin at `~/.pappardelle/local` that the `pappardelle` shim, `idow` and the agents' plugin run from. Only the next `install.sh` replaces it; the one it replaces is kept at `~/.pappardelle/local.previous`
