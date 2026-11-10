# Layout after a terminal resize

Tracked as `pappardelle-3wf.36`.

When the terminal changes size, tmux scales every pane at once and the rail then puts its own layout back: the list at its width, one viewer or two. The rail waited for 150 ms without another resize before asking for that, so every resize showed tmux's scaled layout for 150 ms first. A tiling window manager resizes the terminal once each time a window opens or closes beside it.

## What changed

The rail asks for its layout on the first resize it sees. Resizes that follow within 150 ms, as a drag sends, are laid out once more when they pause.

## Measurements

Isolated Linux fixture (`scripts/benchmarks/workspace-ready.py --resize-cycles 2`), 12 alternating launches per build at 80, 100 and 160 columns. Each cycle widens the client's terminal by 20 columns and restores it, 16 resizes per build at each width. Before is the branch at `bb7fbdf`. The time is from the resize to the last change in pane widths, read by polling `list-panes`. Medians in milliseconds with the range in brackets.

| Resize                              | Before            | After         |
| ----------------------------------- | ----------------- | ------------- |
| 80 ↔ 100 columns (one viewer ↔ two) | 156-157 [155-159] | 6.8-7.9 [6-9] |
| 100 ↔ 120 columns                   | 153-154 [152-156] | 3.4-3.5 [3-8] |
| 160 ↔ 180 columns                   | 153 [152-156]     | 3.4-3.6 [3-5] |

The final pane widths are the same in both builds, and so is the number of width changes on the way (two to four).

## What is left

Each pane's program is still resized twice, once by tmux's scaling and once by the rail's layout. A tmux `window-resized` hook that sets the list's width inside the server would remove the first, but the choice between one viewer and two is made in the rail.
