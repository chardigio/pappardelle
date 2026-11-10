# Rail search

`/` filters the workspace list by key or title; Enter selects the highlighted match and Escape cancels. Tracked as `pappardelle-3wf.29`.

## What was wrong

`/` zoomed the rail pane to the whole window. The zoom is a tmux layout change queued behind any workspace attachment in progress, and the search input was not drawn until it settled. Three things followed:

- Opening and closing waited on tmux, and on every viewer pane redrawing at its new size
- Text typed before the zoom settled was dropped, because no input existed to take it. Keys in the same input write as the `/` were dropped on purpose, Enter included
- Enter pressed after that write but before the zoom settled was handled with an empty query, which confirms the first row of the unfiltered list. This is read from the code; the fixture's zoom settles in about 14 ms, too fast to land a key in

Enter also read the match list from the last render. A character and Enter arriving in one input write selected from the list as it was before that character.

## What changed

- Search stays in the rail: the search row replaces the status row (or the header row in a rail too short for one) and the list filters below it. The window is never zoomed
- Search keys act on the current query and highlight instead of the last render, so several keys in one write each see what the previous one did. Text typed before the search row is drawn is added to the query
- Enter selects the highlighted workspace by name, not by a row index translated around the pending row
- Every word of the query must appear in the key or title, in any order. `fix login` now matches "Fix the login redirect"; before, the query had to appear as one unbroken string

## Measurements

Isolated Linux fixture (`scripts/benchmarks/workspace-ready.py --search typed burst --filter-cycles 2`), three workspaces, 24 alternating launches per build at 80, 100 and 160 columns. Before is the branch at `f8e56c5`. Medians in milliseconds with the range in brackets; each includes about 10 ms of observer overhead (a `send-keys` process and `capture-pane` polling).

| Step                                                | Before        | After         |
| --------------------------------------------------- | ------------- | ------------- |
| `/` to search row visible                           | 25 [24-27]    | 11 [10-12]    |
| Four typed characters to the single match shown     | 15 [14-17]    | 15 [14-19]    |
| Window zoomed while searching                       | 24 of 24      | 0 of 24       |
| `/`, query and Enter sent at once selects the match | 0 of 24       | 24 of 24      |
| Escape to list restored                             | 31-44 [30-49] | 30 [30-37]    |
| Enter to the selected workspace's programs visible  | 41-47 [40-49] | 48-53 [47-59] |

The fixture's panes hold programs that redraw instantly, so the zoom cost here (about 14 ms on opening) is a floor. With real agents each zoom resizes every viewer pane and waits for them to redraw.

The last row is not a regression in what the user sees. Before, the programs were drawn into panes still hidden behind the zoomed rail, which `capture-pane` reports as visible. After, the figure matches an ordinary `j` switch on the same build (46-49 ms).

## What is left

- Escape takes about 30 ms: tmux holds a lone Escape for its `escape-time` (10 ms by default) and the renderer's input parser holds it for another 20 ms to tell it from the start of an escape sequence. The parser's wait is fixed inside OpenTUI
- Enter immediately after a typed character waits for the rail's next frame, up to 16 ms at its 60 frames a second. The fixture presses Enter the moment the match appears and measures 17 ms; with an 80 ms pause before Enter it measures 11 ms, the observer's floor
