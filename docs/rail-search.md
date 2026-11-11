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
- The query is matched the way the agent and profile popups match theirs (`rankByFuzzyMatch`): its characters must appear in order in the key or in the title, spaces ignored, and the tightest match is listed first, a key or title typed in full ahead of longer ones that start with it. `fx lgn` finds "Fix the login redirect". Before, the query had to appear as one unbroken string and matches kept the rail's order
- Escape is acted on as it arrives. The renderer's input parser holds a lone Escape byte for 20 ms in case an escape sequence follows, and the wait is a literal inside OpenTUI. tmux has already made that call and writes each key to a pane whole, so inside tmux a read of just the Escape byte skips the parser and is delivered as the key (`source/lone-escape.ts`)

## Measurements

Isolated Linux fixture (`scripts/benchmarks/workspace-ready.py --search typed burst --filter-cycles 2`), three workspaces, 24 alternating launches per build at 80, 100 and 160 columns. Before is the branch at `f8e56c5`, after is `78d13b6`. Medians in milliseconds with the range in brackets; each includes about 10 ms of observer overhead (a `send-keys` process and `capture-pane` polling).

| Step                                                | Before        | After         |
| --------------------------------------------------- | ------------- | ------------- |
| `/` to search row visible                           | 25 [24-26]    | 11 [10-12]    |
| Four typed characters to the single match shown     | 15 [14-16]    | 15 [14-16]    |
| Window zoomed while searching                       | 24 of 24      | 0 of 24       |
| `/`, query and Enter sent at once selects the match | 0 of 24       | 24 of 24      |
| Escape to list restored                             | 31-44 [30-45] | 17 [10-19]    |
| Enter to the selected workspace's programs visible  | 41-46 [35-53] | 47-52 [46-57] |

The fixture's panes hold programs that redraw instantly, so the zoom cost here (about 14 ms on opening) is a floor. With real agents each zoom resizes every viewer pane and waits for them to redraw.

The last row is not a regression in what the user sees. Before, the programs were drawn into panes still hidden behind the zoomed rail, which `capture-pane` reports as visible. After, the figure matches an ordinary `j` switch (46-49 ms, measured at `f137f5c`).

## What is left

- A key pressed just after the rail drew a frame waited for the next one, up to 16 ms at 60 frames a second, which is where the 17 ms for Escape and Enter above came from. The rail and the popups may now draw 120 frames a second (`pappardelle-3wf.37`). 18 alternating launches per build against `c8bd654`: Escape to list restored 17 → 10 ms, Enter to search closed 17 → 10 ms, Enter to the selected workspace's programs visible 47-51 → 40-46 ms, startup unchanged. 10 ms is the observer's floor
- The fixture sends keys with `send-keys`, which skips tmux's `escape-time`. A real Escape keypress first waits that out in the server the rail runs in (10 ms by default); `set -s escape-time 0` in the user's tmux configuration removes it
