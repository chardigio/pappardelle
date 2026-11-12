---
name: pappardelle-agent
description: >-
  What the Pappardelle MCP tools don't cover: how a workspace is laid out, the CLI behind the tools
  for agents without them, and updating or restarting Pappardelle. Load it when the user asks to
  update or restart Pappardelle, or when you need to work with Pappardelle and have no
  `companion_run` or `spaces_list` tool.
---

# Pappardelle agent

Pappardelle gives each issue a git worktree, an agent session (Claude, or the agent the space's profile runs), and a companion pane next to it. The user watches both. The pappardelle MCP server has tools for all of this, and says how to keep the companion showing your work.

## Where you are

- `PAPPARDELLE_SPACE` is the key of your space, such as `STA-696` or `pappardelle-dq9`. The main checkout's session has no `PAPPARDELLE_SPACE`; its key is `main`
- `PAPPARDELLE_MAIN_REPO_ROOT` is the main checkout. Worktrees live in `~/.worktrees/{repo}/{KEY}`
- Each space has two tmux sessions on the `pappardelle_inner` socket: `agent-{repo}-{key}` (the agent) and `companion-{repo}-{key}` (the companion). In the key, `_` becomes `__` and `.` becomes `_`, because tmux rejects `.` in session names
- Each companion split is a session of its own, `companion-{repo}-{key}~{name}`, which the TUI shows in a framed pane beside the companion. Splits show only in the TUI, not in the terminal launchers
- The TUI runs in the session `pappardelle-{repo}` on the default tmux server

Never drive tmux directly. The sessions are on another socket, and Pappardelle handles naming, exact-match targets, and quoting.

To talk to the agent in another space, use Claude Code's SendMessage and ListAgents. Sessions are named by space key, so the recipient is the key (`SendMessage({to: "STA-696", message: "..."})`; with `sous_chef: true` the main checkout's agent is `sous-chef`), and the message carries who sent it and can be answered. `space_send` types into that agent's TUI as if the user did; use it when the user asks for it.

## Without the MCP tools

If you don't have the tools, either the repo's config doesn't set `workspace_aware_agents: true`, or your agent doesn't have the server: `pappardelle mcp install` adds it to Codex, OpenCode, Antigravity and Pi. Every tool is also a `pappardelle` command. Run them from the repo or any of its worktrees. `pappardelle --help` and `pappardelle companion --help` have the details.

| Tools                        | Command                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `companion_*`                | `pappardelle companion run\|keys\|read\|resize\|close\|list\|width`      |
| `spaces_list`                | `pappardelle spaces [--json]`                                            |
| `space_read`                 | `pappardelle read KEY [--turns N] [--json]`                              |
| `space_highlight`            | `pappardelle highlight KEY [--focus]`                                    |
| `space_send`                 | `pappardelle send KEY`, with the text on stdin                           |
| `space_press_keys`           | `pappardelle send KEY --keys Escape`                                     |
| `space_open`                 | `pappardelle [--resume\|--no-resume] [--wait] [--profile NAME] -- INPUT` |
| `space_screen`               | `pappardelle screen KEY [--companion [--pane NAME]] [--lines N]`         |
| `space_state`                | `pappardelle state KEY --json`, `--tabs` for `space_question_tabs`       |
| `space_wait`                 | `pappardelle wait KEY --until STATE [--timeout S] --json`                |
| `space_watch`                | `pappardelle watch [KEY...] [--until STATE...] [--since CURSOR] --json`  |
| `space_answer`               | `pappardelle answer KEY --option N...`, `--text T` or `--keys K`         |
| `space_queue`                | `pappardelle queue KEY`, with the text on stdin                          |
| `space_schedule*`            | `pappardelle schedule\|schedules\|unschedule`                            |
| `tui_panes`, `tui_focus_log` | `pappardelle tui panes\|focus-log`                                       |
| `space_close`                | `pappardelle close KEY --yes`                                            |
| `tui_restart`                | `pappardelle restart`                                                    |
| `link_pr`                    | `pappardelle link-pr URL [--workspace ROOT]`, from the source repository |

Keep the companion showing your work there too: what a decision depends on before you ask, what to review before you ask for a review, and the app or a test watcher in a split instead of a background task.

## Supervising another space

To keep an agent in another space moving, wait on it instead of checking it over and over:

1. `space_wait` with `until: ready` returns when the agent stops working: idle, at a prompt or question, at a Codex usage limit, or with a draft in its composer. It returns after 50 seconds either way; call it again
2. At `permission`, the state has the command. `space_answer` with the option approves a Bash command once only when it passes the hard refusals (push, PR changes, `--force`, rm outside QA scratch) and a model check that it publishes nothing, deletes nothing outside the worktree or scratch, and sends no secrets. Anything else comes back refused, with the reason, with the command: ask the user, and don't retry it another way
3. At `question`, `space_question_tabs` reads every question of a multi-question dialog. Answer it with the user's choice: `option` for one, `options` for every tick on a multi-select question, or `text` for a typed answer in its free-text row. A multi-question dialog takes one `space_answer` per question, then `option: 1` on its review step. An answer the dialog didn't take fails with the step it got stuck on
4. At `usage_limit`, `space_schedule` with `after_limit` sends `continue` once it resets. `keep_going` checks every interval, continues after limits, and nudges an agent that sits idle twice in a row
5. `space_send` refuses while a prompt is up, and over a draft unless `force`

To supervise several spaces, loop on `space_watch` instead. With `until: [blocked]` it returns every space waiting on a person, each with its prompt, question or dialog. Handle them, then call it again with the `cursor` it returned: a space that changed while you were busy comes back at once, and one still on a prompt you already saw doesn't. `result: timed_out` means nothing changed; call it again with the same cursor. Two identical prompts in a row look unchanged, so after answering a space, check it with `space_state` if `space_watch` stays quiet.

Every send, answer, schedule and reported watch change is logged in `~/.pappardelle/repos/{repo}/supervise.jsonl`.

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
