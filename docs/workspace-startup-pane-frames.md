# Startup after pane frames

Tracks `pappardelle-3wf` after the rebase onto `main` at `fd19896`, which merged the OpenTUI migration with per-pane frame hosts. Measurements use the isolated Linux fixture (`scripts/benchmarks/workspace-ready.py`): real tmux 3.8, dummy agent and companion programs, stubbed providers, three registered workspaces. They say nothing about macOS or a real agent's own start-up; `pappardelle-3wf.6` covers that.

## Where it stands

96 alternating launches of `main` (`fd19896`) and the branch at `8bdf0b3`, 5 ms polling, load average about 2.6. Medians in milliseconds, range in brackets.

| Width / mode    | Rail main → branch                       | Viewers main → branch                     |
| --------------- | ---------------------------------------- | ----------------------------------------- |
| 80x52 fresh     | 237.3 [226.9-286.9] → 94.8 [89.4-119.2]  | 203.8 [193.8-274.3] → 145.8 [140.0-189.8] |
| 80x52 existing  | 226.8 [216.0-510.6] → 95.9 [90.1-121.2]  | 191.1 [182.1-488.9] → 134.2 [126.9-163.6] |
| 100x52 fresh    | 486.8 [336.5-652.9] → 118.2 [99.6-130.2] | 453.6 [294.7-626.6] → 190.5 [160.4-203.6] |
| 100x52 existing | 443.4 [292.1-644.2] → 119.9 [99.0-163.7] | 413.2 [255.0-617.0] → 166.1 [144.8-207.6] |
| 160x52 fresh    | 324.2 [306.6-724.3] → 110.4 [97.9-129.3] | 285.5 [271.4-692.8] → 173.4 [157.4-200.9] |
| 160x52 existing | 303.6 [289.5-940.4] → 110.7 [99.7-148.4] | 266.8 [252.6-913.5] → 151.0 [144.9-206.3] |

"Rail" is the main row and the last registered workspace visible in the list pane. "Viewers" is every viewer pane showing its program's ready marker. Both are observed by polling `capture-pane`, which adds roughly 10-15 ms; the application's own span for the first settled rail frame is about 88 ms at 100 columns. Cold-switch viewers (57-69 ms) and filter return (44-51 ms) are unchanged.

`main` paints the rail only after viewer attachment, attaches the two viewers one after the other, and loses 300 ms in a viewer whenever its color query stalls (below). Those three account for most of the difference.

## The harness needed a terminal

tmux 3.6 and later forward a pane's palette query to its client's terminal. The fixture's outer session had no client, so every frame host waited out the renderer's 300 ms probe and viewer timings were about 300 ms too high. Each launch now attaches a PTY client that answers OSC 4, 10, 11 and 12 queries and turns the status line off as the real launcher does. Numbers from before that change are not comparable with the ones here.

## Changes, in order

Each was measured against the build before it. Raw records are in the gitignored `benchmark-results/` directory of the checkout that produced them.

| Change                                                                                                                               | Evidence                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Rebased startup work: concurrent viewer attachment, geometry snapshots, lazy UI imports, rail painted before workspace details       | 60 launches against `main`: rail 114-153 ms against 221-631 ms, viewers 201-243 ms against 188-599 ms       |
| Frame host asks for colors itself, ending on a status report                                                                         | 96 launches: 20 of 48 stalled 300 ms before, 1 of 48 after; mean viewers 405 → 258 ms                       |
| Pane setup in four tmux calls instead of twelve to fifteen                                                                           | 96 launches: rail 9-35 ms earlier, viewers 2-31 ms earlier                                                  |
| One git process for repo root and common directory                                                                                   | 20 traced launches each: configuration and repo bootstrap 7.2 → 2.0 ms                                      |
| One inner session listing for migration and reaping                                                                                  | 20 traced launches each: reaping pass 1.6 → 0.1 ms                                                          |
| Frame hosts start with their panes; first attachment signals them; the rail waits for a signal instead of polling for the client tty | Viewer attachment 76 → 22 ms; 96 launches: viewers 13-40 ms earlier, rail about 5 ms later with two viewers |

### The color-query stall

The frame host read the terminal's colors through the renderer's `getPalette`, which asks for the 16 palette entries, the default foreground and background, and the cursor color, then waits up to 300 ms of silence for whatever is missing. tmux answers the cursor-color query only for a pane that has set one. A frame whose query reached tmux before its first drawn cursor therefore waited the full 300 ms before starting its program. A probe build showed 302 ms between renderer creation and child start in the stalled frames, with every query answered by the terminal.

The frame now writes the 18 color queries followed by a device status report (`CSI 5 n`). A terminal answers in order and tmux queues its own replies behind forwarded ones, so the status reply marks the end. The query takes 3-4 ms. The embedded terminal is created at the pane's size: at the default 80x24 a program that drew before the first layout was resized under and never redrew, which showed up as blank frames in 17 of 48 launches of an intermediate build.

### Frame hosts started with their panes

Starting a frame host costs about 45 ms: 22 ms for the process, 9 ms for the renderer, 4 ms for the colors, 9 ms for the child to publish its tty and start. That used to begin only after the sessions were prepared. The panes are now split with the frame host as their command, its child blocked on a tmux `wait-for` channel. The first attachment sets the program on a pane option and signals the channel. Later starts (a session that ended, a layout rebuild, a message) still respawn the pane.

Either kind of child signals a second channel as it publishes its tty, and the rail runs `wait-for` on that channel followed by the read, in place of polling every 25 ms. A signal nobody waited for stays set in tmux, so an empty answer waits once more.

The frame hosts now start while the rail does. Rail spans are each about a millisecond longer and the first rail frame is about 5 ms later at widths with two viewers.

## What one launch looks like now

Medians of 16 traced launches at 100 columns, application clock, milliseconds:

- 0-14: process start to the CLI body
- 14-20: configuration, repo bootstrap, session maintenance
- 20-32: pane setup (frame hosts start here)
- 32-49: renderer and application modules, renderer creation
- 49-57: first React commit and first layout request
- 57-80: workspace list loaded, list rendered, two layout passes
- 83-105: session preparation (22 ms, 13 of it the status monitor)
- 105-128: viewer attachment
- 88: first settled rail frame

One tmux call costs about 2.2 ms of wall time here, 0.5 ms of it blocking the TUI's thread. About 25 remain on the path to both viewers.

## Open

- `pappardelle-3wf.19`: batch the status-monitor installation calls
- `pappardelle-3wf.20`: overlap pane setup with renderer module loading
- `pappardelle-3wf.24`: a persistent tmux control-mode client instead of a process per command
- `pappardelle-3wf.25`: the 10 ms first list render
- `pappardelle-3wf.26`: load the workspace list before the renderer mounts
- `pappardelle-3wf.21`, `.22`: attribute the 14 ms before the CLI body; repeat the main-row deferral measurement
- `pappardelle-3wf.6`: macOS and a real agent
