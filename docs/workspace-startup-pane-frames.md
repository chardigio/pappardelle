# Startup after pane frames

Tracks `pappardelle-3wf` after the rebase onto `main` at `fd19896`, which merged the OpenTUI migration with per-pane frame hosts. Measurements use the isolated Linux fixture (`scripts/benchmarks/workspace-ready.py`): real tmux 3.8, dummy agent and companion programs, stubbed providers, three registered workspaces. They say nothing about macOS or a real agent's own start-up; `pappardelle-3wf.6` covers that.

## Where it stands

96 alternating launches of `main` (`fd19896`) and the branch at `38cfea4`, 5 ms polling, load average 2-3. Medians in milliseconds, range in brackets.

| Width / mode    | Rail main → branch                       | Viewers main → branch                     |
| --------------- | ---------------------------------------- | ----------------------------------------- |
| 80x52 fresh     | 231.8 [223.0-264.1] → 78.0 [76.3-100.1]  | 201.7 [189.9-240.3] → 128.5 [125.9-156.2] |
| 80x52 existing  | 217.0 [207.2-561.2] → 86.9 [79.4-116.6]  | 184.7 [181.1-547.9] → 117.8 [104.6-165.8] |
| 100x52 fresh    | 326.7 [304.4-635.3] → 101.8 [84.2-112.8] | 291.4 [278.6-609.5] → 151.5 [143.6-169.6] |
| 100x52 existing | 294.7 [292.0-329.8] → 88.7 [86.1-110.1]  | 257.5 [254.9-294.3] → 134.7 [131.0-149.1] |
| 160x52 fresh    | 335.4 [304.7-625.1] → 103.1 [98.5-125.8] | 302.4 [267.2-601.0] → 150.4 [145.2-189.4] |
| 160x52 existing | 297.4 [292.7-597.6] → 90.8 [86.2-107.6]  | 259.9 [256.4-561.6] → 134.2 [128.0-146.7] |

"Rail" is the main row and the last registered workspace visible in the list pane. "Viewers" is every viewer pane showing its program's ready marker. Both are observed by polling `capture-pane`, which adds roughly 10-15 ms; the application's own span for the first settled rail frame is about 87 ms at 100 columns. Cold-switch viewers went from 56-73 ms to 52-58 ms. Filter return is unchanged at 44-51 ms.

`main` paints the rail only after viewer attachment, attaches the two viewers one after the other, and loses 300 ms in a viewer whenever its color query stalls (below). Those three account for most of the difference.

## The harness needed a terminal

tmux 3.6 and later forward a pane's palette query to its client's terminal. The fixture's outer session had no client, so every frame host waited out the renderer's 300 ms probe and viewer timings were about 300 ms too high. Each launch now attaches a PTY client that answers OSC 4, 10, 11 and 12 queries and turns the status line off as the real launcher does. Numbers from before that change are not comparable with the ones here.

## Changes, in order

Each was measured against the build before it. Raw records are in the gitignored `benchmark-results/` directory of the checkout that produced them.

| Change                                                                                                                                | Evidence                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebased startup work: concurrent viewer attachment, geometry snapshots, lazy UI imports, rail painted before workspace details        | 60 launches against `main`: rail 114-153 ms against 221-631 ms, viewers 201-243 ms against 188-599 ms                                                                                                     |
| Frame host asks for colors itself, ending on a status report                                                                          | 96 launches: 20 of 48 stalled 300 ms before, 1 of 48 after; mean viewers 405 → 258 ms                                                                                                                     |
| Pane setup in four tmux calls instead of twelve to fifteen                                                                            | 96 launches: rail 9-35 ms earlier, viewers 2-31 ms earlier                                                                                                                                                |
| One git process for repo root and common directory                                                                                    | 20 traced launches each: configuration and repo bootstrap 7.2 → 2.0 ms                                                                                                                                    |
| One inner session listing for migration and reaping                                                                                   | 20 traced launches each: reaping pass 1.6 → 0.1 ms                                                                                                                                                        |
| Frame hosts start with their panes; first attachment signals them; the rail waits for a signal instead of polling for the client tty  | Viewer attachment 76 → 22 ms; 96 launches: viewers 13-40 ms earlier, rail about 5 ms later with two viewers                                                                                               |
| Status monitor installed in two tmux calls instead of five                                                                            | 20 traced launches each: installation 14.4 → 7.3 ms, viewers 7-10 ms earlier; the four program-status integration suites pass                                                                             |
| Pane setup as one asynchronous tmux command list, beside module loading                                                               | 32 traced launches each: module loading starts 10 ms earlier, first rail frame 13 ms earlier                                                                                                              |
| Registry and main-worktree reads started before the renderer mounts                                                                   | 20 traced launches each: attachment starts 6 ms earlier, first rail frame 3.5 ms earlier                                                                                                                  |
| Both viewer sessions set up in one tmux call; no client lookups for frames that have not started (after the table above was measured) | 48 traced launches each: viewer attachment 15.0 → 9.8 ms                                                                                                                                                  |
| Frame hosts may draw up to 120 frames a second instead of 60 (after the table above was measured)                                     | 96 launches: viewers 8-13 ms earlier in four of six cases, unchanged in two; costs up to twice the frame host's rendering work while a program streams output                                             |
| tmux commands from the TUI go over one control-mode client per server instead of a process each (after the table above was measured)  | 96 launches against the commit before it: viewers 9-13 ms earlier in five of six cases, cold-switch viewers 11 ms earlier at 80 columns, filter return up to 20 ms faster, rail unchanged or 9 ms earlier |

### The color-query stall

The frame host read the terminal's colors through the renderer's `getPalette`, which asks for the 16 palette entries, the default foreground and background, and the cursor color, then waits up to 300 ms of silence for whatever is missing. tmux answers the cursor-color query only for a pane that has set one. A frame whose query reached tmux before its first drawn cursor therefore waited the full 300 ms before starting its program. A probe build showed 302 ms between renderer creation and child start in the stalled frames, with every query answered by the terminal.

The frame now writes the 18 color queries followed by a device status report (`CSI 5 n`). A terminal answers in order and tmux queues its own replies behind forwarded ones, so the status reply marks the end. The query takes 3-4 ms. The embedded terminal is created at the pane's size: at the default 80x24 a program that drew before the first layout was resized under and never redrew, which showed up as blank frames in 17 of 48 launches of an intermediate build.

### Frame hosts started with their panes

Starting a frame host costs about 45 ms: 22 ms for the process, 9 ms for the renderer, 4 ms for the colors, 9 ms for the child to publish its tty and start. That used to begin only after the sessions were prepared. The panes are now split with the frame host as their command, its child blocked on a tmux `wait-for` channel. The first attachment sets the program on a pane option and signals the channel. Later starts (a session that ended, a layout rebuild, a message) still respawn the pane.

Either kind of child signals a second channel as it publishes its tty, and the rail runs `wait-for` on that channel followed by the read, in place of polling every 25 ms. A signal nobody waited for stays set in tmux, so an empty answer waits once more.

The frame hosts now start while the rail does. Rail spans are each about a millisecond longer and the first rail frame is about 5 ms later at widths with two viewers.

## What one launch looks like now

Medians of 40 traced launches at 100 and 160 columns, application clock, milliseconds:

- 0-16: process start to the CLI body
- 16-24: configuration, repo bootstrap, session maintenance; the workspace reads start at 19
- 24-42: pane setup in tmux (frame hosts start here) beside renderer and application module loading
- 42-51: renderer creation
- 57: first layout request
- 76-82: attachment queued, then started
- 82-102: session preparation (20 ms, 9 of it the status monitor)
- 102-125: viewer attachment (22 ms)
- 87: first settled rail frame

One tmux call costs about 2.2 ms of wall time here, 0.5 ms of it blocking the TUI's thread.

### Control-mode clients

A `tmux` process per command costs about 2.1 ms here; the same command over a long-lived `tmux -C` client costs 0.06 ms. The TUI now keeps one such client per server and sends its asynchronous commands through it. Commands that would hold the client's queue (`wait-for` without a signal flag, anything that attaches or prompts), arguments containing a newline, and every one-shot subcommand still run as processes, and a client that closes or stops answering is not used again.

On the rail's own server the client joins the rail's session with `ignore-size,no-output`, so `tmux list-clients` shows one more client there. On the inner server it creates a session named `pappardelle-control-<pid>` running `tail -f /dev/null`, marked `destroy-unattached`; it is gone as soon as the TUI exits. tmux answers each command of a list separately and drops the rest of a list at its first failure, so every list sent ends with a `display-message` whose reply marks the end.

## Measured and not kept

- **Main row details after the first frame.** 80 traced launches: the first rail frame is 5 ms earlier (91.9 → 86.9 ms), attachment then takes 7 ms longer, and viewers move by -3.6 to +3.1 ms. The main row's status, dirty flag and emoji would arrive later for no viewer gain
- **A larger initial heap.** Every startup runs two garbage collections with 3-7 ms pauses because the initial allocation budget is 8 MB. `BUN_JSC_largeHeapSize` at 64 MB removes one and moves the first rail frame 3.8 ms earlier (80 traced launches). It can only be set through the environment before the process starts, and would be inherited by the shells in the panes
- **The process before the CLI body.** A compiled hello-world exits in 3.8 ms. Pappardelle's lightest entry point takes 15.4 ms and the CLI reaches its argument gate at 22 ms, so about 11 ms is loading the bundle and its bytecode whichever entry runs. Bytecode already saves 55-65 ms. The modern x64 target was slower than the baseline one for hello-world (6.7 against 3.9 ms), and minifying identifiers gained 0.3-0.6 ms
- **The first list render.** No application function stands out in a CPU profile. React work totals about 70 ms across startup; the 10-14 ms busy stretch after the list arrives is a pause inside the first re-render of `App`, which overlaps one of the collections above
- **Rail-published palette.** Having the rail read the terminal's colors once and leave them on its window did not help: the rail's own `getPalette` takes about 650 ms for the same cursor-color reason, so frames never found the value in time. The direct query replaced it

## Open

- `pappardelle-3wf.27`, closed: preparing the main worktree's sessions before the renderer mounts made viewers 1.5-4.9 ms earlier and the first rail frame 4.5 ms later, and was dropped
- `pappardelle-3wf.6`: macOS and a real agent
