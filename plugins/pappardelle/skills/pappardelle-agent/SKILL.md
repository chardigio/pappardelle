---
name: pappardelle-agent
description: >-
  What the Pappardelle MCP tools don't cover: how a workspace is laid out, the CLI behind the tools
  for agents without them, and updating or restarting Pappardelle. Load it when the user asks to
  update or restart Pappardelle, or when you need to work with Pappardelle and have no
  `companion_run` or `spaces_list` tool.
---

# Pappardelle agent

Pappardelle gives each issue a git worktree, an agent session (Claude, or the agent the space's profile runs), and a companion pane next to it. The user watches both. In Claude Code, the pappardelle MCP server has tools for all of this, and its instructions say how to keep the companion showing your work.

## Where you are

- `PAPPARDELLE_SPACE` is the key of your space, such as `STA-696` or `pappardelle-dq9`. The main checkout's session has no `PAPPARDELLE_SPACE`; its key is `main`
- `PAPPARDELLE_MAIN_REPO_ROOT` is the main checkout. Worktrees live in `~/.worktrees/{repo}/{KEY}`
- Each space has two tmux sessions on the `pappardelle_inner` socket: `agent-{repo}-{key}` (the agent) and `companion-{repo}-{key}` (the companion). In the key, `_` becomes `__` and `.` becomes `_`, because tmux rejects `.` in session names
- The TUI runs in the session `pappardelle-{repo}` on the default tmux server

Never drive tmux directly. The sessions are on another socket, and Pappardelle handles naming, exact-match targets, and quoting.

To talk to the agent in another space, use Claude Code's SendMessage and ListAgents. Sessions are named by space key, so the recipient is the key (`SendMessage({to: "STA-696", message: "..."})`), and the message carries who sent it and can be answered. `space_send` types into that agent's TUI as if the user did; use it when the user asks for it.

## Without the MCP tools

Every tool is a `pappardelle` command, for agents the plugin doesn't reach, such as Codex. Run them from the repo or any of its worktrees. `pappardelle --help` and `pappardelle companion --help` have the details.

| Tools              | Command                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `companion_*`      | `pappardelle companion run\|keys\|read\|resize\|close\|list\|width`      |
| `spaces_list`      | `pappardelle spaces [--json]`                                            |
| `space_read`       | `pappardelle read KEY [--turns N] [--json]`                              |
| `space_highlight`  | `pappardelle highlight KEY`                                              |
| `space_send`       | `pappardelle send KEY`, with the text on stdin                           |
| `space_press_keys` | `pappardelle send KEY --keys Escape`                                     |
| `space_open`       | `pappardelle [--resume\|--no-resume] [--wait] [--profile NAME] -- INPUT` |
| `space_close`      | `pappardelle close KEY --yes`                                            |
| `tui_restart`      | `pappardelle restart`                                                    |

Keep the companion showing your work there too: what a decision depends on before you ask, what to review before you ask for a review, and the app or a test watcher in a split instead of a background task.

## Updating and restarting Pappardelle

`update` and `restart --hard` stay commands, not tools, so that they take a deliberate step. The plain restart is also the `tui_restart` tool.

| Command                                | Does                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pappardelle update --no-restart-tuis` | Installs the latest release and leaves running TUIs on the old build                                                                                                                                                    |
| `pappardelle update --restart-tuis`    | Installs the latest release and restarts every running TUI in place. Exits 1 if one doesn't come back                                                                                                                   |
| `pappardelle restart`                  | Restarts this repo's TUI on the build that ran the command and confirms it came up. Agent sessions keep running                                                                                                         |
| `./install.sh && pappardelle restart`  | From a Pappardelle checkout: builds it, points `pappardelle` and every agent's plugin at it, moves this repo's TUI onto it. Removing that worktree later drops the plugin until `install.sh` runs from another checkout |
| `pappardelle restart --hard --yes`     | Ends every agent and companion session, this one included, then restarts every TUI                                                                                                                                      |

1. Always pass a flag to `update`. There is no terminal here, so without one it never restarts TUIs
2. A nonzero exit after a successful install means a TUI isn't confirmed on the new build. Relay the line naming the TUI and the reason
3. Use `pappardelle restart` when the TUI looks frozen or stale. If it exits nonzero, relay its reason
4. `install.sh` installs the checkout it runs from. Run it from the worktree whose build the user wants
5. `--help` on `restart` or `update` changes nothing. Both reject unknown flags with exit 2
6. Run `restart --hard --yes` only when the user explicitly asks to reset every session. Say first that it ends every agent session including yours, and wait for the go. Your reply won't arrive after it runs
