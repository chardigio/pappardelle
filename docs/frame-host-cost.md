# What a frame host costs

Tracked as `pappardelle-3wf.32`. Each viewer pane runs a frame host: a Pappardelle process that draws the rounded, titled frame and runs the pane's `tmux attach` inside an embedded terminal. The program's output is therefore interpreted three times on its way to the screen (inner tmux, the embedded terminal, outer tmux). This measures that against a pane running `tmux attach` directly.

## Measurements

`scripts/benchmarks/frame-cost.py dist/pappardelle`, Linux, tmux 3.8, three runs that agree to within a percentage point. A program in the inner session prints 96-character lines at a fixed rate into a 100x52 pane; CPU is the share of one core over six seconds.

| Lines a second | Direct: outer tmux | Frame: frame host | Frame: outer tmux | Frame: total |
| -------------- | ------------------ | ----------------- | ----------------- | ------------ |
| 50             | 1%                 | 4.5%              | 1.5%              | 6%           |
| 500            | 8-10%              | 9%                | 3.5%              | 12.5%        |
| 5000           | 72-73%             | 14%               | 4%                | 18%          |

The inner server's share is the same either way (0.3%, 2% and 13%).

- **CPU**: at the rate an agent usually prints, a frame costs about 5% of a core more than a bare pane. Under a flood it costs less in total: the frame host redraws at most 120 times a second and sends the outer server only the cells that changed, where a bare pane makes the outer server interpret every line
- **Memory**: a frame host holds 100-110 MB; a bare `tmux attach` holds 1.5 MB. Two viewer panes are about 200 MB, beside the rail's own 150 MB
- **Typing**: a letter typed into a framed pane is echoed in about 2 ms (`docs/agent-pane-input.md`)
- **Startup**: a frame host takes about 45 ms to start (`docs/workspace-startup-pane-frames.md`); they start with their panes, beside the rail

## What it suggests

The frame host is not a CPU or latency problem. Its cost is memory, and that is the size of a second and third copy of the runtime, not of the frame.

The rail already draws popups into a tty that a small shell reports to it, with a second renderer in its own process. Viewer frames could be drawn the same way, which would remove both frame host processes: about 200 MB, and their start-up. It would also put the rail and both terminals on one thread, so a busy agent pane and the rail would wait on each other, and a crash would take all three. Not tried; `pappardelle-3wf.40`.
