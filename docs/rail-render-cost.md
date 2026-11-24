# What the rail costs to render

The benchmark that changes to rail rendering are judged against.

## What it measures

`scripts/benchmarks/rail-render.tsx` renders 40 real `SpaceListItem` rows inside the rail's frame, through `renderTui` with the rail's renderer settings, in a real 40x42 PTY. Row 4 is `working` (the spinner) and row 7 is `blocked` on a permission (the blink). Each run is a fresh process that goes through three phases:

- **idle**: no input; the spinner and the blink both run
- **burst**: `j` ten times then `k` ten times, repeated at 30 keys a second (a held key), so the selection sweeps across both animated rows
- **blink**: the working row is switched to idle, so only the 500 ms blink runs

It measures two frames:

- **pane-frame**: `PaneFrame`, as the app renders it
- **native-border**: the same box with OpenTUI's own titled border and no paint hook, which is what `PaneFrame`'s `renderAfter` hook costs

Every presented frame reads OpenTUI's `getNativeStats()`, which describes only the last frame, so each phase adds up per-frame values. The JSONL has an environment line, one line per run, phase and variant, and one summary line per metric with median, min, max, range and spread (range over median). Each summary line says whether the metric is a **gate** metric.

Gate metrics are rates per second: frames, CPU, terminal output bytes, cells updated, `nativeRenderTime` and the `frameWork` counters, plus `fullPathFrames`. Per-frame figures are diagnostic, because when animations share frames there are fewer frames that each carry more, so a per-frame figure rises while the terminal receives less. `frameTimeMs` is the renderer loop's own time. Since `1eded02` the spinner and blink commit inside that loop, from the renderer's animation tick, so frame time is diagnostic too. `nativeRenderTime` is in OpenTUI's native units (about 5 to 8 per frame here, against about 1 ms of whole frame time, so likely microseconds).

The spinner (150 ms) and the blink (500 ms) tick on multiples of their interval on the renderer's clock. Each phase starts 75 ms past a multiple of 1500 ms on that clock, between two spinner ticks, and lasts a multiple of 1500 ms, so no tick falls on either edge of a phase or in the 30 ms the parent waits for output still in flight, and every run sees the same ticks against the same keys. The child starts the next phase's setup only after the parent has counted the last phase's bytes. Before this a blink frame could land in that 30 ms tail (one 251-byte frame more in some runs), and the burst's cells took one of several values from run to run, depending on where the blink toggles fell in the selection sweep.

The run fails when the keys handled in the burst don't match the keys written, when idle draws no faster than blink (the spinner did not run), or when a frame event reads a stale stats snapshot.

Limit: with one working row this can't show that 20 spinners take one commit a tick; `source/components/claude-animation.test.ts` covers that.

## Command

```sh
bun scripts/benchmarks/rail-render.tsx                              # this checkout, 5 runs
bun scripts/benchmarks/rail-render.tsx --checkout ../base-checkout  # base and head, alternating in each run
```

`--checkout` copies the script into the other checkout's `scripts/benchmarks/` for the run, so it renders that checkout's components with that checkout's React, and removes it afterwards. That checkout needs `bun install`. Results go to `benchmark-results/rail-render.jsonl` (`--output`), with the markdown table on stdout. `--runs`, `--phase-ms` (idle and burst, default 3000) and `--blink-ms` (default 6000) set the length; the two lengths must be multiples of 1500.

## Baseline

`c3343af`, measured before the gate moved to rates per second, AMD Ryzen 7 5800X 8-Core Processor, 16 threads, Linux 7.2.15-1-omarchy, Bun 1.4.4, 5 runs. Median (min-max) over runs.

The machine was under load, with load averages between 4 and 29 across the runs. CPU per second has a 16-66% range across runs, against a target of 10%, because of a single outlier run in most phases. Phases of 8 s didn't narrow it (39-85%). Rerun this baseline on a quiet machine before using CPU as a gate. The counters, cells and bytes are close to deterministic (0-7%).

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

## Rows as text with spans

Each row line is a box with two texts holding spans, instead of a box or text per styled run: 3 renderables for a single-line row (19 before for the benchmark's row) and 6 for a two-line row (23). Base `338f8a0` against the change, `--checkout`, same machine under load, 5 runs, gate metrics, median (min-max).

pane-frame:

| Metric                      | Idle base        | Idle head        | Burst base          | Burst head          | Blink base       | Blink head       |
| --------------------------- | ---------------- | ---------------- | ------------------- | ------------------- | ---------------- | ---------------- |
| `framesPerSecond`           | 8.00 (8.00-8.00) | 8.00 (8.00-8.00) | 36.6 (35.5-36.6)    | 36.3 (36.3-36.7)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `cpuMsPerSecond`            | 28.8 (25.9-44.3) | 23.6 (22.7-28.2) | 108 (104-156)       | 83.6 (81.7-122)     | 6.34 (6.14-6.65) | 4.97 (4.64-5.22) |
| `outputBytesPerSecond`      | 926 (926-926)    | 926 (926-926)    | 15873 (15800-15881) | 15861 (15857-15888) | 578 (578-578)    | 578 (578-578)    |
| `cellsUpdatedPerSecond`     | 80.6 (80.6-80.6) | 80.6 (80.6-80.6) | 2127 (2121-2127)    | 2126 (2125-2128)    | 74.0 (74.0-74.0) | 74.0 (74.0-74.0) |
| `nativeRenderTimePerSecond` | 47.0 (41.0-68.3) | 45.0 (44.7-60.0) | 222 (221-343)       | 232 (210-354)       | 11.7 (11.0-13.3) | 12.0 (11.5-12.5) |
| `paintVisitsPerSecond`      | 6111 (6110-6111) | 992 (992-992)    | 27743 (26902-27997) | 4503 (4499-4546)    | 1528 (1528-1528) | 248 (248-248)    |
| `membersPaintedPerSecond`   | 180 (180-180)    | 50.0 (50.0-50.0) | 1296 (1290-1297)    | 307 (306-308)       | 42.0 (42.0-42.0) | 12.0 (12.0-12.0) |
| `memberCellsPerSecond`      | 676 (676-676)    | 676 (676-676)    | 5145 (5119-5145)    | 5141 (5119-5147)    | 156 (156-156)    | 156 (156-156)    |
| `damageRowsPerSecond`       | 8.66 (8.66-8.66) | 8.66 (8.66-8.66) | 66.0 (65.6-66.0)    | 65.9 (65.6-66.0)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `rowsDiffedPerSecond`       | 8.66 (8.66-8.66) | 8.66 (8.66-8.66) | 64.0 (63.6-64.0)    | 63.9 (63.6-64.0)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `yogaSolvesPerSecond`       | 6.67 (6.66-6.67) | 6.66 (6.66-6.66) | 6.66 (6.64-6.66)    | 6.66 (6.66-6.67)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |
| `layoutRoundsPerSecond`     | 8.00 (8.00-8.00) | 8.00 (8.00-8.00) | 36.6 (35.5-36.6)    | 36.3 (36.3-36.7)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `hostRequestsPerSecond`     | 8.00 (8.00-8.00) | 8.00 (8.00-8.00) | 36.6 (35.5-36.6)    | 36.3 (36.3-36.7)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `fullPathFrames`            | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |

native-border:

| Metric                      | Idle base        | Idle head        | Burst base          | Burst head          | Blink base       | Blink head       |
| --------------------------- | ---------------- | ---------------- | ------------------- | ------------------- | ---------------- | ---------------- |
| `framesPerSecond`           | 8.00 (8.00-8.00) | 8.00 (8.00-8.00) | 36.6 (36.3-36.6)    | 36.6 (36.3-36.6)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `cpuMsPerSecond`            | 23.7 (22.9-25.0) | 19.3 (18.8-22.6) | 90.7 (85.3-95.1)    | 67.5 (65.3-103)     | 5.91 (5.82-9.64) | 3.85 (3.74-5.52) |
| `outputBytesPerSecond`      | 926 (926-926)    | 926 (926-926)    | 15872 (15862-15882) | 15881 (15835-15882) | 578 (578-578)    | 578 (578-578)    |
| `cellsUpdatedPerSecond`     | 80.6 (80.6-80.6) | 80.6 (80.6-80.6) | 2127 (2126-2127)    | 2127 (2124-2127)    | 74.0 (74.0-74.0) | 74.0 (74.0-74.0) |
| `nativeRenderTimePerSecond` | 45.0 (42.7-47.0) | 45.3 (44.0-58.3) | 237 (226-254)       | 246 (226-850)       | 11.8 (11.0-18.3) | 12.8 (12.0-16.8) |
| `paintVisitsPerSecond`      | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |
| `membersPaintedPerSecond`   | 180 (180-180)    | 50.0 (50.0-50.0) | 1296 (1290-1297)    | 308 (304-308)       | 42.0 (42.0-42.0) | 12.0 (12.0-12.0) |
| `memberCellsPerSecond`      | 676 (676-676)    | 676 (676-676)    | 5145 (5119-5145)    | 5145 (5113-5145)    | 156 (156-156)    | 156 (156-156)    |
| `damageRowsPerSecond`       | 8.66 (8.66-8.66) | 8.66 (8.66-8.66) | 66.0 (65.6-66.0)    | 66.0 (65.6-66.0)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `rowsDiffedPerSecond`       | 8.66 (8.66-8.66) | 8.66 (8.66-8.66) | 64.0 (63.6-64.0)    | 64.0 (63.6-64.0)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `yogaSolvesPerSecond`       | 6.66 (6.66-6.66) | 6.66 (6.66-6.66) | 6.66 (6.66-6.66)    | 6.66 (6.66-6.66)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |
| `layoutRoundsPerSecond`     | 8.00 (8.00-8.00) | 8.00 (8.00-8.00) | 36.6 (36.3-36.6)    | 36.6 (36.3-36.6)    | 2.00 (2.00-2.00) | 2.00 (2.00-2.00) |
| `hostRequestsPerSecond`     | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |
| `fullPathFrames`            | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00)    | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) |

Cells and output bytes per run are the same on both sides: 242 cells and 2779 bytes in every idle run, 444 and 3468 in every blink run, and 6383-6384 cells and 47563-47670 bytes in burst runs on both sides (a key frame more or less with 109 or 110 frames). Paint visits fall from 764 to 124 a frame and members painted from 22.5 to 6.25 a frame in idle; the cells they paint are the same.

## Reading it

- **Gate**: on the same machine, run base and head together with `--checkout`. A gate metric (a rate per second) whose head median is worse than base by more than the larger of the two ranges is a regression. A base from before `1eded02` runs its animations on timers started at mount, not on the renderer's clock, so its burst cells still vary from run to run
- **The paint hook**: with `PaneFrame`, every frame makes one host request and one JS paint visit per renderable in the rail: 764 when a row was a box or text per styled run, 124 since a row line is text with spans. Without the hook it makes none. No frame takes OpenTUI's full path in either variant. Cells, bytes and damage rows are the same, so the hook costs CPU (idle median 27.9 against 23.6 ms/s, burst 109 against 90) but not output
- **The spinner**: idle minus blink is the spinner's cost: about 6 frames a second (6.7 ticks, one in three shared with the blink since `1eded02`) and about 350 bytes a second
