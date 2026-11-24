# What the rail costs to render

Tracked as `pappardelle-lgat.1`. This is the baseline the rail rendering changes (`lgat.4`, `lgat.5`, `lgat.6`) are judged against, and the benchmark gate for the lgat follow-ups PR.

## What it measures

`scripts/benchmarks/rail-render.tsx` renders 40 real `SpaceListItem` rows inside the rail's frame, through `renderTui` with the rail's renderer settings, in a real 40x42 PTY. Row 4 is `working` (the spinner) and row 7 is `blocked` on a permission (the blink). Each run is a fresh process that goes through three phases:

- **idle**: no input; the spinner and the blink both run
- **burst**: `j` ten times then `k` ten times, repeated at 30 keys a second (a held key), so the selection sweeps across both animated rows
- **blink**: the working row is switched to idle, so only the 500 ms blink runs

It measures two frames:

- **pane-frame**: `PaneFrame`, as the app renders it
- **native-border**: the same box with OpenTUI's own titled border and no paint hook, which is what `PaneFrame`'s `renderAfter` hook costs

Every presented frame reads OpenTUI's `getNativeStats()`, which describes only the last frame, so each phase adds up per-frame values. The JSONL has an environment line, one line per run, phase and variant, and one summary line per metric with median, min, max, range and spread (range over median). Each summary line says whether the metric is a **gate** metric.

Gate metrics don't depend on whether a React commit runs inside the renderer's frame loop: frames per second, CPU per second, terminal output bytes, cells updated, `nativeRenderTime` and the `frameWork` counters. `frameTimeMs` is the renderer loop's own time. Today's spinner and key commits run outside that loop, but a commit from `useAnimationTick` (`lgat.6`) runs inside it, so frame time is diagnostic only. `nativeRenderTime` is in OpenTUI's native units (about 5 to 8 per frame here, against about 1 ms of whole frame time, so likely microseconds).

The run fails when the keys handled in the burst don't match the keys written, when idle draws no faster than blink (the spinner did not run), or when a frame event reads a stale stats snapshot.

Limit: with one working row this can't show `lgat.6`'s "20 spinners, one commit"; `claude-animation.test.ts` covers that.

## Command

```sh
bun scripts/benchmarks/rail-render.tsx                              # this checkout, 5 runs
bun scripts/benchmarks/rail-render.tsx --checkout ../base-checkout  # base and head, alternating in each run
```

`--checkout` copies the script into the other checkout's `scripts/benchmarks/` for the run, so it renders that checkout's components with that checkout's React, and removes it afterwards. That checkout needs `bun install`. Results go to `benchmark-results/rail-render.jsonl` (`--output`), with the markdown table on stdout. `--runs`, `--phase-ms` (idle and burst, default 3000) and `--blink-ms` (default 6000) set the length.

## Baseline

`c3343af` (`sd-lgat-followups`), AMD Ryzen 7 5800X 8-Core Processor, 16 threads, Linux 7.2.15-1-omarchy, Bun 1.4.4, 5 runs. Median (min-max) over runs.

The machine was busy: other agents were running test suites, with load averages between 4 and 29 across the runs. CPU per second has a 16-66% range across runs, against a target of 10%, because of a single outlier run in most phases. Phases of 8 s didn't narrow it (39-85%). Rerun this baseline on a quiet machine before using CPU as a gate. The counters, cells and bytes are close to deterministic (0-7%).

pane-frame:

| Metric                           | Idle             | Burst               | Blink            |
| -------------------------------- | ---------------- | ------------------- | ---------------- |
| `framesPerSecond`                | 8.66 (8.33-8.66) | 37.0 (37.0-37.3)    | 2.00 (2.00-2.00) |
| `cpuMsPerSecond`                 | 27.9 (26.2-44.1) | 109 (94.7-158)      | 10.4 (7.71-11.9) |
| `outputBytesPerSecond`           | 943 (935-943)    | 15722 (15705-16082) | 578 (578-578)    |
| `outputBytesPerFrame`            | 109 (109-112)    | 424 (421-435)       | 289 (289-289)    |
| `cellsUpdatedPerFrame`           | 9.31 (9.31-9.68) | 56.2 (55.7-57.8)    | 37.0 (37.0-37.0) |
| `nativeRenderTimePerFrame`       | 5.23 (4.96-8.92) | 5.98 (5.05-11.1)    | 6.25 (5.42-8.42) |
| `paintVisitsPerFrame`            | 764 (764-764)    | 764 (764-764)       | 764 (764-764)    |
| `membersPaintedPerFrame`         | 21.0 (21.0-21.7) | 34.9 (34.8-35.3)    | 21.0 (21.0-21.0) |
| `memberCellsPerFrame`            | 78.0 (78.0-81.1) | 138 (138-140)       | 78.0 (78.0-78.0) |
| `damageRowsPerFrame`             | 1.00 (1.00-1.04) | 1.77 (1.77-1.78)    | 1.00 (1.00-1.00) |
| `hostRequestsPerFrame`           | 1.00 (1.00-1.00) | 1.00 (1.00-1.00)    | 1.00 (1.00-1.00) |
| `fullPathFrames`                 | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) |
| `frameTimeMedianMs` (diagnostic) | 1.04 (1.00-3.07) | 0.78 (0.64-1.33)    | 0.73 (0.65-1.31) |

native-border:

| Metric                           | Idle             | Burst               | Blink            |
| -------------------------------- | ---------------- | ------------------- | ---------------- |
| `framesPerSecond`                | 8.66 (8.66-8.66) | 37.0 (36.7-37.0)    | 2.00 (2.00-2.00) |
| `cpuMsPerSecond`                 | 23.6 (22.5-38.0) | 90.0 (84.9-99.6)    | 7.13 (6.14-10.4) |
| `outputBytesPerSecond`           | 943 (935-943)    | 15770 (15696-15879) | 578 (578-578)    |
| `outputBytesPerFrame`            | 109 (108-109)    | 427 (425-433)       | 289 (289-289)    |
| `cellsUpdatedPerFrame`           | 9.31 (9.31-9.31) | 56.5 (56.2-57.4)    | 37.0 (37.0-37.0) |
| `nativeRenderTimePerFrame`       | 5.23 (5.19-10.1) | 6.37 (5.58-7.38)    | 6.17 (5.58-10.9) |
| `paintVisitsPerFrame`            | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) |
| `membersPaintedPerFrame`         | 21.0 (20.9-21.0) | 35.1 (34.9-35.2)    | 21.0 (21.0-21.0) |
| `memberCellsPerFrame`            | 78.0 (78.0-78.0) | 139 (138-140)       | 78.0 (78.0-78.0) |
| `damageRowsPerFrame`             | 1.00 (1.00-1.00) | 1.78 (1.77-1.79)    | 1.00 (1.00-1.00) |
| `hostRequestsPerFrame`           | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) |
| `fullPathFrames`                 | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) |
| `frameTimeMedianMs` (diagnostic) | 0.76 (0.75-1.72) | 0.56 (0.53-0.66)    | 0.53 (0.50-1.74) |

## Reading it

- **Gate**: on the same machine, run base and head together with `--checkout`. A gate metric whose head median is worse than base by more than the larger of the two ranges is a regression
- **The paint hook**: with `PaneFrame`, every frame makes one host request and 764 JS paint visits, which is every renderable in the rail. Without the hook it makes none. No frame takes OpenTUI's full path in either variant. Cells, bytes and damage rows are the same, so the hook costs CPU (idle median 27.9 against 23.6 ms/s, burst 109 against 90) but not output
- **The spinner**: idle minus blink is the spinner's cost: about 6.7 frames a second, about 9 cells and about 110 bytes a frame
