# Glossary

- **Invalid config**: a config file exists in some layer but can't be used: it fails validation, fails to parse or can't be read. Pappardelle never treats it as a missing config: whatever needs the config holds back or says why, and the rail shows `.pappardelle.yml is invalid: …` until it loads
- **Install**: the directory the `pappardelle` shim, `idow` and the agents' plugin run from: the snapshot for a local install, or `~/.pappardelle/repo` for the curl install
- **Missing config**: no config file in any layer (home, project, local), or not in a git repo. Pappardelle uses its built-in defaults
- **Local install**: `install.sh` run from a Pappardelle clone or worktree (`LOCAL_MODE`), as opposed to the curl install, which clones a release to `~/.pappardelle/repo`
- **Snapshot**: the copy of a local install's build, scripts and plugin at `~/.pappardelle/local` that the `pappardelle` shim, `idow` and the agents' plugin run from. Only the next `install.sh` replaces it; the one it replaces is kept at `~/.pappardelle/local.previous`
