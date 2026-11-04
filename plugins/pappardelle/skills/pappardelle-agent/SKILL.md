---
name: pappardelle-agent
description: >-
  Inspect and change the Pappardelle workspace this agent runs in, or another space in the same
  repo: run, type into, read, resize and close companion panes, set the companion width, list
  spaces, read another space's conversation, prompt or press keys in another space's agent, open,
  resume or close spaces, and update or restart Pappardelle. Load it at the start of any session inside
  a Pappardelle space (PAPPARDELLE_SPACE is set), and whenever the user asks about their
  workspaces, companion pane, or Pappardelle itself.
---

# Pappardelle agent

You are running in a Pappardelle workspace. Pappardelle gives each issue a git worktree, an agent session (Claude, or the agent the space's profile runs), and a companion pane next to it. The user watches both. This skill is how you see and change that workspace.

## Where you are

- `PAPPARDELLE_SPACE` is the key of your space, such as `STA-696` or `pappardelle-dq9`. The main checkout's session has no `PAPPARDELLE_SPACE`; its key is `main`
- `PAPPARDELLE_MAIN_REPO_ROOT` is the main checkout. Worktrees live in `~/.worktrees/{repo}/{KEY}`
- Each space has two tmux sessions on the `pappardelle_inner` socket: `agent-{repo}-{key}` (the agent) and `companion-{repo}-{key}` (the companion). In the key, `_` becomes `__` and `.` becomes `_`, because tmux rejects `.` in session names
- The TUI runs in the session `pappardelle-{repo}` on the default tmux server

Never drive tmux directly. The sessions are on another socket, and the commands below handle naming, exact-match targets, and quoting. Run `pappardelle` commands from the repo or any of its worktrees.

## Show your work in the companion pane

The companion is the user's view of what you are doing. Keep it showing that, all session:

1. Before you ask the user a question, put what the decision depends on in the companion: the diff, the file, the log, the doc. Then ask
2. Run the app, a dev server, or a test watcher in a companion split instead of a background task, so the user can watch it start: `pappardelle companion run --pane app --split right -- npm run dev`. Read its output with `pappardelle companion read --pane app`
3. Before you ask the user to review something, set the companion up for that review: `pappardelle companion hunk diff`, the running app, the rendered page
4. As the work moves on, change what the companion shows to match, and close splits that no longer help
5. Use named splits for short-lived views. Change `main` only when it is the right place; the user may be in the middle of something there
6. When the user says what they want in the companion, do that instead

## Companion panes

Every verb targets your own space unless you pass `--space KEY`. Only the companion session is touched, never an agent session.

Shortcut for your own space: `pappardelle companion <command...>` runs the command in your companion's `main` pane, replacing what runs there.

```bash
pappardelle companion hunk diff --watch
pappardelle companion 'make test 2>&1 | less -R'   # one argument runs as a shell line
```

Panes have names. The pane the companion starts with is `main`.

| Command                                                                                    | Does                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pappardelle companion run [--pane NAME] [--split right\|down] [--size N\|N%] -- <cmd...>` | Runs a command in pane NAME (default `main`). An existing pane restarts with the new command; a missing one is split off `main` (default `down`). Running it again with the same NAME replaces the pane instead of adding one |
| `pappardelle companion keys [--pane NAME] [--no-enter] <text>`                             | Types text into a running program and presses Enter. Text on stdin works when no text is given                                                                                                                                |
| `pappardelle companion keys [--pane NAME] --keys q --keys Escape`                          | Presses tmux key names, in order, with no Enter                                                                                                                                                                               |
| `pappardelle companion read [--pane NAME] [--lines N]`                                     | Prints the last N lines of the pane (default 50)                                                                                                                                                                              |
| `pappardelle companion resize NAME [--width N\|N%] [--height N\|N%]`                       | Resizes a pane                                                                                                                                                                                                                |
| `pappardelle companion close NAME`                                                         | Closes a pane. `main` can't be closed; `run` something else in it                                                                                                                                                             |
| `pappardelle companion list [--json]`                                                      | Lists panes: name, pane id, command, size, active                                                                                                                                                                             |
| `pappardelle companion width <N\|N%\|reset>`                                               | Sets this space's companion column width in the TUI. It applies only while this space is selected and survives a TUI restart                                                                                                  |

Verb names are reserved: a command that starts with `run`, `keys`, `read`, `resize`, `close`, `list` or `width` needs `pappardelle companion run -- <cmd>`. One command argument is a shell line, so pipes and redirects work; several arguments are quoted one by one.

`companion width` prints whether the TUI applied it: `Applied ... N columns` (the TUI may clamp it to fit), `applies when KEY is selected`, `applies when the companion pane is showing` (the window is too narrow for one), `applies when the open dialog closes`, or `applies when Pappardelle next launches`. It exits 1 when the TUI couldn't apply it or didn't answer.

A companion verb fails with "No companion session" when the space hasn't been selected in the TUI since its sessions stopped. Tell the user to select it.

## Other spaces

| Command                                     | Does                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pappardelle spaces [--json]`               | Every open space: Claude status, minutes since the last update, issue title, PR URL, commits ahead and diff size against the base branch, pipeline and unresolved comments, recap |
| `pappardelle read KEY [--turns N] [--json]` | The last N turns of a space's conversation (default 5). A turn is a user prompt and the assistant text that answered it                                                           |
| `pappardelle highlight KEY`                 | Selects the space in the TUI                                                                                                                                                      |

To talk to the agent in another space, use Claude Code's SendMessage and ListAgents. Sessions are named by space key, so the recipient is the key (`SendMessage({to: "STA-696", message: "..."})`), and the message carries who sent it and can be answered.

## Driving a space's agent as the user would

`pappardelle send` types into a space's agent TUI as if the user did. Use it when the user asks for it, not to message another agent.

```bash
pappardelle send STA-696 'run the failing test again'
pappardelle send STA-696 <<'MSG'
don't touch the migrations
MSG
pappardelle send STA-696 --keys Escape
```

- Pass the text in single quotes. If it contains a single quote or starts with `-`, send it on stdin instead
- `send` clears the input line, types the text literally, then presses Enter, so the prompt is submitted and not left as a newline
- `--keys` presses tmux key names without clearing or submitting. Repeat it for several keys, in order

Useful keys in Claude Code's TUI:

| Key      | Does                                                     |
| -------- | -------------------------------------------------------- |
| `Escape` | Interrupts the current turn                              |
| `S-Tab`  | Cycles the permission mode (default, accept edits, plan) |
| `C-c`    | Clears the input; twice in a row exits Claude            |
| `Enter`  | Submits what is typed                                    |

Slash commands are prompts: `pappardelle send STA-696 /compact`.

`send` exits 1 with "No active session" when the space's agent session isn't running; the space needs reopening with `pappardelle --resume --wait KEY`.

## Opening, resuming and closing spaces

```bash
pappardelle STA-696
pappardelle -- 'fix the auth bug'
pappardelle --profile mobile -- 'fix the auth bug'
pappardelle --resume --profile mobile STA-696
pappardelle --resume --wait STA-696
pappardelle --no-resume STA-696
pappardelle close STA-696 --yes
```

Use `pappardelle` rather than `idow`: a successful run saves the space in the registry the TUI and `pappardelle spaces` read.

- Opening an existing worktree by issue key resumes it without sending the configured initialization prompt again
- `--resume` skips that prompt for any input, including a URL or description, and brings back a space whose session is gone
- `--no-resume` sends the prompt even for an existing space
- `--wait` holds, after the space opens, until its agent starts (up to 60s), and exits 3 if it isn't confirmed. Use it before `send` to a space you just reopened: a failed launch leaves a shell in the pane, which would run the text as a command. A Codex profile always exits 3, since Codex doesn't report its status
- `--profile <name>` takes the profile's key in `.pappardelle.yml`, not its display name
- A bare number such as `696` takes the profile's or the repo's team prefix. Prefer the full key when you know it

A nonzero exit means setup or registration failed; report the message. If setup finished but registration failed, the worktree may exist without showing in the TUI. Don't repeat a description that could create a second issue.

A description files a new issue. Put it in single quotes after `--`, so one starting with `-` isn't read as a flag.

`close` is `x` in the TUI: it runs the space's `pre_workspace_deinit` hooks, ends its agent and companion sessions, and removes it from the board. It leaves the issue's state alone, and needs `--yes` with no terminal to confirm on. Closing your own space ends this session, so say so and wait for the go.

## Updating and restarting Pappardelle

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
