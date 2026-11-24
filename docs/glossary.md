# Glossary

- **Invalid config**: a config file exists in some layer but can't be used: it fails validation, fails to parse or can't be read. Pappardelle never treats it as a missing config: whatever needs the config holds back or says why, and the rail shows `.pappardelle.yml is invalid: …` until it loads
- **Install**: the directory the `pappardelle` shim, `idow` and the agents' plugin run from: the snapshot for a local install, or `~/.pappardelle/repo` for the curl install
- **Missing config**: no config file in any layer (home, project, local), or not in a git repo. Pappardelle uses its built-in defaults
- **Local install**: `install.sh` run from a Pappardelle clone or worktree (`LOCAL_MODE`), as opposed to the curl install, which clones a release to `~/.pappardelle/repo`
- **Snapshot**: the copy of a local install's build, scripts and plugin at `~/.pappardelle/local` that the `pappardelle` shim, `idow` and the agents' plugin run from. Only the next `install.sh` replaces it; the one it replaces is kept at `~/.pappardelle/local.previous`
- **Inner server**: the `pappardelle_inner` tmux server that holds every space's agent and companion sessions. It runs with exit-empty, exit-unattached and destroy-unattached off, so it stays up when no space is open
- **Status snapshot**: a pane monitor's latest program status for one pane generation (`ProgramStatusSnapshot`). Not the install **Snapshot**
- **Pane generation**: the id of one monitor attach to one agent pane, a hash of the socket, pane id, pid and marker. Status snapshots and leases are filed under it
- **Forgotten generation**: a pane generation the status daemon was told to forget when its space closed or its pane was replaced. The daemon ignores status snapshots that arrive for it later
- **Composer**: the agent's input box: Claude's `❯` (`!` in shell mode) between two rules, Codex's `›`. Not read while a dialog is open
- **Unsubmitted send**: a send whose text showed in the composer and was still there after two Enters
