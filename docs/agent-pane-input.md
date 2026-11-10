# Keys typed into an agent pane

Tracked as `pappardelle-3wf.31` and `pappardelle-3wf.39`.

A key typed at the terminal passes four programs before the agent reads it: the outer tmux server (the user's own), the frame host in the viewer pane, the frame's `tmux attach` client, and the inner tmux server. What the agent prints comes back the same way. None of this had been measured.

## What was wrong

A lone Escape was held three times, each program waiting in case the rest of an escape sequence followed:

- The outer tmux server, for its `escape-time` (10 ms by default)
- The frame host's input parser, for 20 ms. The wait is a literal inside OpenTUI
- The inner tmux server, for its `escape-time`: 10 ms by default, 500 ms before tmux 3.5

Only the first is needed. tmux writes each key to a pane whole, and so does the frame host to its client, so past the outer server a read of just the Escape byte is the key.

## What changed

- The frame host treats a read of just the Escape byte as the key and drops the parser's late copy, as the rail and the popups do (`source/lone-escape.ts`). A key typed while the parser still holds that Escape comes out of the parser joined to it; the Escape is dropped there and the key delivered as itself
- The first attachment sets `escape-time` to 0 on the inner server, which is Pappardelle's own

## Measurements

Isolated Linux fixture (`scripts/benchmarks/workspace-ready.py --agent-keys 3`), 12 alternating launches per build at 80, 100 and 160 columns, 36 keys of each kind per build. Before is the branch at `c34e1d0`. The keys are written to the client's terminal, as a keyboard's are, and the fixture agent leaves its terminal in line mode, so the kernel echoes each key and the time is the path there and back. Medians in milliseconds with the range in brackets.

| Key    | Before            | After             |
| ------ | ----------------- | ----------------- |
| Letter | 1.8-8.5 [1.7-9.4] | 2.1-5.3 [1.7-8.8] |
| Escape | 42.3-43.0 [42-49] | 15.2-15.3 [14-16] |

A letter is echoed in about 2 ms, or about 8.5 ms when it lands just after the frame host drew a frame; the change does not touch that path, and which of the two a case's median shows is chance. The frame host adds little to an ordinary key.

## The harness's terminal

The first measurement read 537 ms for Escape. tmux 3.8 holds a lone Escape typed at a client for 500 ms, instead of its `escape-time`, while any query it sent that client's terminal is unanswered: device attributes, version, synchronized output, window size, foreground and background color, or a pane's forwarded palette query. The fixture's stand-in terminal answered only the color queries. It now answers the rest, as a terminal emulator does, and startup medians stayed in the same range (rail 79-87 ms, viewers 116-133 ms).

A terminal that never answers one of those queries would see the 500 ms on every Escape, in any tmux session.

## What is left

- The outer server's `escape-time` is the 10 ms that remains. It belongs to the user's tmux configuration; `set -s escape-time 0` removes it
- What the frame host costs in memory and under streaming output is `pappardelle-3wf.32`
