# Popup open and close

Tracked as `pappardelle-3wf.34`. Every dialog the rail opens (help, errors, confirmations, the new-space prompt) is a tmux popup when the rail runs in tmux. tmux runs a shell in the popup that reports its tty, and the rail draws the dialog into that tty with a second renderer. Neither opening nor closing had been measured.

## What was wrong

Dismissing a popup destroyed its renderer, waited for the renderer to finish shutting down, and only then told tmux to remove the popup. The shutdown takes about 21 ms, nearly all of it inside OpenTUI after `destroy()` returns.

## What changed

Dismissing now tells tmux to remove the popup first (`dismiss` in `source/popup/terminal.ts`) and shuts the renderer down behind it. The popup's terminal is still released only after the renderer has closed, as before. tmux closing a popup under its renderer was already a handled case.

Ctrl+C in a popup is handled by the renderer itself and still waits for the shutdown.

## Measurements

Isolated Linux fixture (`scripts/benchmarks/workspace-ready.py --popup-cycles 3`), 12 alternating launches per build at 80, 100 and 160 columns, 36 help popups per build. Before is the branch at `51da0d6`. `?` and Escape are written to the client's terminal, and the times are read from what the client draws, since `capture-pane` does not show a popup. Medians in milliseconds with the range in brackets.

| Step                                    | Before            | After             |
| --------------------------------------- | ----------------- | ----------------- |
| `?` to the help text drawn              | 20.8-23.8 [17-30] | 20.7-23.3 [17-26] |
| Escape to the covered panes drawn again | 35.4-36.0 [35-38] | 12.7-13.7 [13-16] |

## What is left

- 10 ms of the close is the `escape-time` of the tmux server the rail runs in, as for every Escape typed there
- Opening was not taken apart. It covers `display-popup` starting a shell, the shell reporting its tty through a file, and the second renderer's first frame
