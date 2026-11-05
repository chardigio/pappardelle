# Main-workspace startup: successor handoff

The OpenTUI migration improves renderer/process startup, but main-workspace
readiness still takes seconds on the user's Mac. This handoff measures the
remaining path; it does not implement startup optimizations.

## Evidence and scope

- [Observed macOS timeline](workspace-startup-macos.json): 2,163 ms from the
  last app-import start message to both sessions being created; layout activity
  continues through 3,518 ms. The earlier 13-second gap belongs to a separate
  `pappardelle restart --hard` invocation and must not be counted.
- [Local raw samples](workspace-startup-benchmark.json): five runs per case,
  alternating order, compiled Bun bytecode binary, real tmux 3.5a, Linux x64,
  100×52 terminal. Source commit and executable SHA-256 are recorded in the JSON.
- [Subprocess trace](workspace-startup-benchmark.trace.json): load in Perfetto
  (`ui.perfetto.dev`) or a Chrome trace viewer. Includes completed Git/tmux calls,
  application-log milestones, and readiness observations. Raw commands are also
  embedded in the benchmark JSON.
- [Reproduction harness](../scripts/benchmarks/workspace-ready.py): isolated HOME,
  tiny Git repository, unique tmux socket directory, fresh outer/inner servers,
  and dummy Python agent/companion programs. It does not touch existing sessions,
  invoke Claude, or intentionally contact remote services. OS caches are **not**
  flushed. This is session-cold, not disk-cache-cold or a full user configuration.

The earlier 66.58 ms result in the migration report measures a `main` placeholder
with `--no-layout`. It excludes this path and is not workspace readiness.

## Local results

Times are milliseconds from launching a fresh outer tmux server, including its
startup. Medians of five runs; no warmup sample was discarded.

| Milestone                                  | Clean shell | 1-second shell-init delay |
| ------------------------------------------ | ----------: | ------------------------: |
| Dummy agent reaches its ready marker       |       239.6 |                   1,227.3 |
| Dummy companion reaches its ready marker   |       243.9 |                   1,233.0 |
| Both inner clients observed attached       |       278.4 |                     266.9 |
| Both ready markers visible in viewer panes |       289.8 |                   1,239.8 |

Readiness-file timestamps use a monotonic clock inside each dummy process.
Attachment and visible-marker observations are sampled independently, every
20 ms plus observer subprocess time. Their observed order can therefore differ:
a visible pane may be sampled before the next client-list check. These are
upper bounds at polling resolution, not frame-presentation latency. Dummy Python
startup is included. Neither marker means a real Claude session is ready.

The injected delay is `sleep 1` in the isolated `.bashrc`. Pappardelle intentionally
starts agent/companion commands through `$SHELL -ic`. This controlled experiment
separates shell readiness from client attachment; it does **not** prove the user's
shell is responsible for their observed latency. No user shell files were read.

## Trace findings

Tracing is a **separate run**, excluded from every median. Python wrappers around
Git/tmux add substantial process overhead: both markers became visible at
1,499.7 ms in the traced run versus the untraced 289.8 ms median. Use it for call
structure and ordering, not as an unbiased wall-time profile or a direct
comparison with macOS. Spans cover the underlying subprocess, excluding wrapper
initialization; gaps also contain wrapper overhead. Overlapping spans must not
be summed into a total startup duration.

The captured window includes readiness plus 300 ms of follow-up activity:

- 60 completed tmux invocations and 7 completed Git invocations.
- 29 `tmux display-message` calls, 1 `select-pane`, 5 `set-option`, 4
  `resize-pane`, and 2 each of `new-session`, `respawn-pane`, and `split-window`.
- Two relayout passes following initial layout creation, matching the pattern
  in the user's log. Equal window dimensions do not establish identical desired
  pane geometry; determine whether the second pass is necessary before removing it.
- Observation commands use the real tmux binary and are excluded from the trace.
  Wrappers record on subprocess completion, so long-lived attach processes killed
  during teardown are not represented. Counts are completed calls, not all spawns.

The branch advanced during this investigation. These final samples were rebuilt
and rerun after rebasing onto `0b516ec` (source recorded as `4cd82f7`, whose added
files are benchmark artifacts only). Earlier exploratory samples are not pooled.

## Where to investigate

1. `source/cli.tsx`: pre-render `cleanupOrphanedOuterSessions`, legacy-session
   migration, inner-session reaping, and `setupPappardellLayout`. Startup logs
   currently lack PID/launch correlation. `Pappardelle starting` is emitted at
   module import in `app.tsx`, even for non-TUI CLI commands.
2. `source/tmux.ts`: `setupPappardellLayout` performs synchronous command sequences;
   batch compatible operations and consolidate dimension queries. Keep failures
   observable and retain exact session targets and per-window scoping.
3. `attachToSpace`: agent session creation, companion session creation, TTY lookup,
   and viewer attachment are largely sequential. Investigate concurrency only
   where operations are independent; preserve cancellation and partial-attachment
   recovery, and never leave a live session without its agent command.
4. `ensureAgentSession` / `attachStatusMonitor`: preserve the monitor startup gate
   so an agent's first native status report cannot be lost. Do not remove the gate
   or weaken ownership/lease checks to make a benchmark faster.
5. `source/app.tsx`: renderer readiness, dimension reconciliation, and
   `relayoutPanes` effects. Coalesce equivalent initial layout work if measurements
   prove it redundant. Preserve pane dragging, zoom, resizing, and narrow layouts.
6. `buildShellLaunchArgs`: measure user shell initialization and actual agent
   readiness separately. Do not bypass users' interactive shell configuration or
   change resume semantics as an unreviewed optimization.

The macOS sample has three registered workspaces and real Claude; the local
fixture has neither. Background status probes and rail queries can contend with
startup, but the supplied timestamps do not prove they block attachment. Update
checking was skipped (`LOCAL_MODE`) and is not implicated by this observation.

## Reproduce and validate improvements

Requires Python 3.11+, Git, tmux, and Bun 1.4.4+ for building. Run from repository
root. Use the same executable, terminal geometry, and sample count for comparisons.

```sh
bun install --frozen-lockfile
bun run build
python3 scripts/benchmarks/workspace-ready.py --runs 5 --trace \
  --output docs/workspace-startup-benchmark.json
```

Each sample destroys only its own uniquely isolated servers. A timeout fails the
benchmark instead of becoming a successful timing sample. The trace JSON is
written beside the metrics JSON using the suffix `.trace.json`.

Related existing bead: `pappardelle-p9s` covers other synchronous input paths and
the initial tmux-version probe. Coordinate overlapping changes without expanding
this startup investigation into unrelated PR-lookup or keyboard fixes.

Successor acceptance criteria:

- Add opt-in startup correlation (PID and launch ID) and spans for pre-render
  setup, main-worktree discovery, session creation, and viewer attachment. Log
  command categories rather than secret-bearing environments or arbitrary prompts.
- Reproduce on macOS with real configuration, including a 100×52 terminal and
  three registered workspaces. Capture shell/Claude readiness separately from
  application attachment. Do not claim Linux dummy-process timings explain all
  of the Mac's 3.5-second interval.
- Publish before/after medians and raw samples for fresh and existing sessions,
  at narrow and wide widths. Include completed command counts and residual
  relayouts. Do not substitute the first placeholder frame for a usable workspace.
- Demonstrate reduced application orchestration cost without weakening monitor
  capture, cancellation, session ownership, resume, or terminal restoration.
- Run the affected tmux attachment/geometry tests, native relocation smoke test,
  and all four program-status integration suites; validate on macOS and Linux.

No startup optimization or user-machine trace collection has been performed in
this handoff. The macOS evidence is the user-supplied log; the command trace is
from the isolated Linux fixture.
