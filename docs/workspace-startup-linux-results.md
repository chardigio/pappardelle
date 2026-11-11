# Linux startup changes — pappardelle-3wf

The final Linux candidate completes the 180-sample startup matrix and 40-sample CPU-contention comparison without readiness failures. The rail draws earlier, while combined rail/viewer readiness is mostly unchanged or faster. These fixtures do not establish real macOS or Claude startup performance.

The retained changes consolidate tmux geometry reads, avoid resizing panes already at their desired dimensions, and overlap independent session and viewer operations. Startup tracing is opt-in. Interactive shells, agent resume, the monitor startup gate, pane ownership and final renderer reconciliation remain in place.

## Current candidate after review fixes

Published QA evidence: [interaction transcript](workspace-startup-qa/review-fixes-qa-interaction.md), [lifecycle transcript](workspace-startup-qa/review-fixes-lifecycle.md), integration results, startup trace correlation, and restored rail capture.

Candidate SHA-256: `2302b230d0c5a75a9b298f9631082d0a1680afccb6c9dd5e50f537215afd83f5`, preserved with its runtime installation at `/tmp/pappardelle-3wf-review-fixes-vxzzofaq`. The 180-sample comparison covers five alternating pairs for each width, workspace count and shell/session case. Main plus three registered workspaces, clean shells, medians in milliseconds:

| Width | Sessions | Baseline rail | Candidate rail | Baseline all visible | Candidate all visible |
| ----- | -------- | ------------: | -------------: | -------------------: | --------------------: |
| 80    | Fresh    |         253.1 |          230.1 |                253.9 |                 231.1 |
| 100   | Fresh    |         260.3 |          209.8 |                262.4 |                 263.9 |
| 160   | Fresh    |         259.4 |          208.4 |                261.4 |                 260.8 |
| 80    | Retained |         232.0 |          209.0 |                232.0 |                 210.0 |
| 100   | Retained |         236.1 |          211.8 |                236.1 |                 215.3 |
| 160   | Retained |         236.5 |          213.6 |                236.5 |                 238.3 |

“All visible” is the per-sample maximum of rail and required viewer visibility, then summarized. Main-only wide fresh launches improved from 258–260 ms to 236 ms; narrow main-only launches were unchanged at about 231 ms. Injecting a one-second shell delay still delays agent visibility by approximately one second. Differences of a few milliseconds are below the launch observer's polling resolution.

The 40-sample contention comparison, with two busy workers sharing two CPUs, had all-visible medians of 463.9→439.4 ms and 456.3→406.1 ms for fresh 100/160-column launches. Retained medians were 387.3→374.5 ms and 410.7→381.3 ms. The candidate's slowest fresh 160-column sample was 540.7 ms versus baseline 506.7 ms; improved medians do not mean every launch is faster.

The stricter resize guard initially regressed the delayed-tmux diagnostic to 272–274 ms. Reusing already measured geometry when reconciliation performs no mutation removed the redundant query. The final delayed diagnostic passed all nine filter-return cycles across three launches: median 191.8 ms, range 185.5–195.0 ms, against the 250 ms diagnostic budget. This is synthetic delay evidence, not native latency.

Review fixes also clear attachment caches after partial failure, distinguish real resize/state changes from same-size resize notifications, scope monitor tracing to selected startup preparation, overlap independent TTY reads, and reuse measured geometry during orientation rebuilds. Obsolete layout helpers were removed. The full formatting/lint/unit gate passed 2,540 tests. All four program-status integrations and 24 compiled CLI smoke tests passed again after the review fixes; commands and results are recorded in `.show-your-work/review-fixes-integration-gates.json` and its log.

Current-build interaction QA passed ten filter round trips (including three immediate reopens), help, dragged widths, 80/100/160-column transitions, delayed-shell navigation, agent input and other-window targeting, with no warning/error logs. Evidence is in `.show-your-work/review-fixes-qa-interaction.md` and its JSON captures. Fixture servers, agents and directory were removed. Startup trace propagation/restart/subcommand verification also passed on this build; evidence is `.show-your-work/review-fixes-startup-correlation.json`.

Current-build lifecycle QA passed ten exit/reopen cycles preserving exact agent/companion process IDs, three startup SIGTERM/reopen cases, rapid selection, and full attached-PTY termios restoration. An initial early-quit assertion failed: `q` sent immediately after pane splits was ignored before input readiness. A controlled comparison reproduced this in five of five launches on both baseline and candidate; a second `q` after readiness exited all ten. The initial failure and comparison are preserved in `.show-your-work/review-fixes-lifecycle-first-attempt.*` and `.show-your-work/review-fixes-early-quit.json`. The final report is `.show-your-work/review-fixes-lifecycle.md`. Owned servers, processes and fixture directories were removed.

All three requested review tracks completed. Nine Claude findings were fixed; Codex found no actionable regression; the spec review's cold-path coverage and final-measurement gaps were addressed. Standards and spec reviewers rechecked the fixes without remaining actionable findings. No commits or publication were performed. Real macOS/Claude validation remains open under `pappardelle-3wf.6`.

## Previously validated comparison

The final 180-sample comparison has no readiness failures. Five alternating pairs cover each of the 18 fixture cases. For main plus three registered workspaces and clean shells:

| Width | Session  | Baseline visible median (range) | Candidate visible median (range) |
| ----- | -------- | ------------------------------: | -------------------------------: |
| 80    | Fresh    |          230.3 (228.7–254.5) ms |           230.2 (229.1–230.3) ms |
| 100   | Fresh    |          261.0 (260.0–262.6) ms |           235.8 (235.7–237.4) ms |
| 160   | Fresh    |          260.4 (259.8–264.8) ms |           236.5 (235.2–264.8) ms |
| 80    | Retained |          208.3 (207.4–216.4) ms |           208.2 (207.1–210.2) ms |
| 100   | Retained |          211.6 (211.2–213.0) ms |           212.2 (211.4–212.5) ms |
| 160   | Retained |          212.0 (211.8–238.1) ms |           212.4 (212.0–213.3) ms |

Fresh wide visibility improves by about 24–25 ms. Narrow and retained visibility are effectively unchanged. At 100 columns, median agent readiness moves from 238.0 to 227.8 ms. The one-second shell delay still adds approximately one second to readiness; it is not bypassed. The candidate's 160-column fresh outlier remains in the range above.

Baseline SHA-256: `3362a6c678606e6953f39c881b5eb2a3b30a704144dfbbdf4004a9c8cabcc57b`. Candidate SHA-256: `acbc90e28fbb4094ad3ba096ad8e20a44207def1eff6cc1c810e1c19af71d697`. The compared installations are `/tmp/pappardelle-3wf-baseline-bipgmn76` and `/tmp/pappardelle-3wf-concurrency-5yad0v16`, each with matching runtime scripts and dependencies.

The final separate command trace contains 49 completed tmux calls versus the baseline's 63, eight Git calls, two incomplete long-lived viewer attaches, and two completed relayouts. It was collected during QA activity; its wall times are not performance evidence.

A 40-sample contention comparison also completed without readiness failures. The benchmark and two busy workers shared two CPUs; settings record this synthetic constraint. At 100 columns, fresh visible medians were 472.7 ms baseline and 422.0 ms candidate, but the candidate's slowest sample reached 520.4 ms versus 479.0 ms baseline. At 160 columns, fresh medians were 443.6 and 439.9 ms. Retained medians were 384.5→369.6 ms and 368.1→343.7 ms respectively. These small sets show successful operation under contention, not a guarantee that the candidate wins every launch or reproduces macOS scheduling.

## Measurement method

The [baseline report](workspace-startup-linux-before.md) describes fixture isolation and provenance. All comparisons use matching executable/runtime installations, alternate order within each case, and retain failed samples separately. No OS cache flushing is performed. The fixtures use real Git worktrees, persisted registry state and isolated tmux servers, with local provider stubs and dummy Python agents.

Visibility and client attachment use 20 ms polling plus observer subprocess overhead. Agent readiness is timestamped in the fixture process. These are separate milestones; their observations can appear out of order. Retained-session samples verify unchanged process IDs and original ready timestamps. They do not report those old timestamps as new launch durations.

Raw artifacts include executable hashes, installation roots, harness hash, environment, individual samples, ranges, provider calls, application logs and pane captures. Wrapped command traces are separate from native timing samples. Do not add overlapping span durations or compare wrapper-perturbed timings with native medians.

## Geometry stage

180 paired samples, five baseline/candidate pairs per case, completed without readiness failures. Cases cover 80/100/160 columns, 0/3 registered workspaces, fresh clean shells, fresh shells with an injected one-second delay, and retained inner sessions.

Main plus three workspaces, clean shell:

| Width | Session  | Baseline visible median | Geometry visible median | Baseline agent ready | Geometry agent ready |
| ----- | -------- | ----------------------: | ----------------------: | -------------------: | -------------------: |
| 80    | Fresh    |                230.3 ms |                230.4 ms |             226.7 ms |             225.8 ms |
| 100   | Fresh    |                259.9 ms |                235.7 ms |             234.3 ms |             226.8 ms |
| 160   | Fresh    |                261.5 ms |                234.9 ms |             237.2 ms |             228.8 ms |
| 80    | Retained |                208.1 ms |                208.8 ms |         Pre-existing |         Pre-existing |
| 100   | Retained |                211.4 ms |                212.0 ms |         Pre-existing |         Pre-existing |
| 160   | Retained |                211.2 ms |                212.6 ms |         Pre-existing |         Pre-existing |

Fresh wide visibility improved by 24–27 ms, with roughly 8 ms earlier agent readiness. The visibility difference crosses an observer polling interval; it is not an exact measure of CPU work saved. Narrow and retained results are effectively unchanged at this resolution.

One targeted `list-panes` response supplies window dimensions and measured pane sizes together. Post-split and post-mutation measurements remain authoritative, preserving tmux rounding and user drags. The reconciliation path skips resize commands when dimensions already match. A rail resize still forces companion reconciliation because changing one pane can change another.

The separate geometry command trace contains 50 completed tmux calls, down from 63 in the baseline trace. Both retain two incomplete long-lived viewer attach processes. Git counts were 7 versus 8 in these individual runs; that difference is not attributed to geometry. Both initial layout passes remain.

## Session and viewer concurrency

180 paired samples compare this stage with geometry alone and have no readiness failures. End-to-end medians do not establish a standalone visibility improvement. In particular, the narrow fresh case sometimes falls into the next visibility polling interval. The earlier session-only experiment also showed no consistent end-to-end improvement.

Twenty separately traced native samples, five pairs each for fresh and retained sessions at 100 columns with three registered workspaces, resolve the smaller internal difference:

| Span              | Geometry fresh | Concurrent fresh | Geometry retained | Concurrent retained |
| ----------------- | -------------: | ---------------: | ----------------: | ------------------: |
| Attachment        |       40.40 ms |         34.56 ms |          17.83 ms |            13.41 ms |
| Viewer attachment |       11.45 ms |          8.23 ms |          10.64 ms |             7.67 ms |

Agent and companion preparation now run independently. Their own creation, monitor-gate and launch ordering is unchanged. Viewer attachment shares one inner-client snapshot and overlaps operations on distinct, explicitly targeted panes. Every started branch settles before cancellation or failure releases the queue. Cached TTY/client state is published only after both viewers and title/focus complete. Deferred-operation tests exercise cancellation and failures with either sibling finishing last, then retry attachment.

The retained rationale is a repeatable reduction in internal attachment wait, not a claim that concurrency alone changes visible readiness by the same amount.

## Rejected experiments and remaining work

- Skipping the loading-time layout pass alone regressed fresh visibility by roughly 24–26 ms across all three widths in 60 paired samples. It moved reconciliation in front of attachment instead of overlapping discovery
- Starting main-worktree Git discovery before synchronous pane setup, passing its promise to the first refresh only, produced no consistent visible improvement in 60 paired samples
- Combining early discovery with the skipped pass likewise did not improve visibility in 20 paired samples: fresh medians 235.95 versus 236.60 ms; retained 212.56 versus 212.84 ms

Those experiments were removed. The original loading/workspace-count, resize and dialog requests remain. The first layout overlaps discovery; the final pass supplies measured renderer dimensions and settles the revision that allows the rail to paint. The geometry change removes redundant mutations inside those passes without dropping their settlement guarantees.

The geometry-stage native trace places roughly 84 ms before the CLI body, 9 ms in configuration/bootstrap, 3 ms in required cleanup/migration/reaping, 15 ms in pane setup, 5 ms in commit/version metadata, and 12 ms in renderer initialization. These are one-run observations, not additive exclusive profile totals. Imports and executable initialization are reported as unattributed; this investigation has not established how much could be removed by changing module loading. Commit metadata also identifies the running TUI build for restart, so it is not solely help text. Dependent pane splits need returned pane IDs. Chrome and focus keep their independent failure behavior. Monitor installation precedes agent launch so the first status report is captured.

A ten-run separately compiled import probe used the same native bytecode/minification settings. Its median intervals were 40.4 ms before the probe entry point, 19.9 ms loading OpenTUI core, 1.3 ms loading its React integration, 5.8 ms for remaining App dependencies, and 4.3 ms for CLI argument dependencies. React itself added less than 0.1 ms. The probe deliberately imports sequentially, so these are attribution clues rather than the production CLI's exact import order. Most of the interval belongs to native process initialization and the renderer required for the TUI; lazily moving App imports would retain those dependencies before first render. No module-loading change was retained.

This is a finite investigation, not evidence of an absolute optimum. Real macOS startup, user shell initialization, Claude initialization and resume remain separate acceptance work under `pappardelle-3wf.6`.

## Rail first paint and filter return

The benchmark now observes the main row plus the first visible registered workspace, independently of agent readiness and viewer visibility. It also sends `/`, waits for the filter prompt, sends Escape, and captures the restored workspace list. Interaction polling is 5 ms plus observer overhead; launch polling remains 20 ms plus overhead.

The slow-tmux reproduction failed a diagnostic 250 ms rail-return budget: about 671 ms after Escape. Each wrapped tmux invocation includes an injected 20 ms delay and Python startup overhead. These times expose serialized work; they are neither native Linux timings nor a macOS simulation.

Temporary instrumentation found three layout passes after Escape. Zoom/unzoom resize notifications queued further requests while the current pass was running. A generation guard suppressed readiness for each completed pass even though the desired zoom state and dialog revision had not changed. Event-loop lag during these waits was mostly below 1 ms: the rail was waiting for asynchronous layout completion rather than continuously blocking the UI thread.

Publishing confirmed geometry for the current dialog revision, while still running the pending final pass, reduced the intermediate median to about 272 ms. Consolidating zoom, direction, layout and final dimensions into targeted geometry snapshots reduced it to 193 ms median, 217 ms maximum, with all three cycles passing the diagnostic budget. A regression test covers a resize arriving during unzoom; existing tests still cover reopening dialogs, cancellation and final geometry. The real tmux test covers another selected window, preserved dragged widths, zoom and orientation rebuilds.

The 36-sample native pilot had no readiness failures. Filter return remained approximately 45 ms on this machine. That pilot included the experimental renderer/preparation gate described below, so its startup timings do not isolate the rail fix. Temporary rail probes were removed after diagnosis. The benchmark retains terminal captures, interaction timings and the optional delayed-tmux diagnostic.

The clean 60-sample comparison compares the previously validated concurrency stage with the rail changes, without simultaneous builds or tests. There were no readiness failures. Medians in milliseconds:

| Width | Sessions | Earlier rail | Current rail | Earlier both visible | Current both visible |
| ----- | -------- | -----------: | -----------: | -------------------: | -------------------: |
| 80    | Fresh    |        230.2 |        205.6 |                254.6 |                255.3 |
| 100   | Fresh    |        258.5 |        207.8 |                258.5 |                260.6 |
| 160   | Fresh    |        260.1 |        207.9 |                260.1 |                261.2 |
| 80    | Retained |        232.7 |        207.4 |                232.7 |                208.4 |
| 100   | Retained |        236.6 |        212.6 |                236.6 |                237.2 |
| 160   | Retained |        237.2 |        210.9 |                237.2 |                237.7 |

“Both visible” is calculated for each sample as the later of rail visibility and required viewer visibility, then summarized. Earlier rail display has a cost: fresh agent readiness is 10–15 ms later, and wide viewer visibility can be about 24 ms later. Most combined medians are effectively unchanged at this polling resolution. This favors earlier workspace-list display rather than claiming every startup milestone improves. A 100-column candidate outlier reached 331 ms visible readiness and remains in the raw results.

That pre-review executable SHA-256 is `771921c1f909c3f06e6e0434729ac4947501775f10f5ce9058410c1433b47c22`, preserved at `/tmp/pappardelle-3wf-rail-first-paint-t7dostly`. Its table records an intermediate stage; the current candidate is measured above. The simpler original attachment queue is retained; speculative preparation queues and background timers are not.

The first rail render also invoked a synchronous tmux version query even for text containing no skin-tone modifiers. The no-op path now returns without querying tmux; tests retain the exact bare-3.6 workaround. A 12-sample pilot was noisy and does not establish a general startup gain. Rendering an actual skin-tone modifier can still invoke the synchronous probe; its asynchronous replacement remains part of `pappardelle-p9s`.

## Additional orchestration experiments

- Preparing inner sessions while outer layout runs was measured in 60 paired samples and 20 native traced samples. Only about 4 ms of layout queue wait was available to overlap, and competing preparation took about 2 ms longer. End-to-end results were inconclusive
- Starting preparation alongside dynamic renderer imports made the dummy agent ready about 41 ms earlier in a 20-sample pilot, but did not make its output visible earlier. It also gated rendering on preparation. Removing that gate in 20 paired samples moved fresh rail visibility from 239.0 to 209.4 ms while visible workspace readiness stayed around 263 ms. The gate and its initial-workspace handoff were removed
- A 20-sample queue-removal experiment had large fresh-start outliers and does not conclusively establish a benefit or regression. Focused tests overlapped its first samples. All samples are preserved; the final candidate comparison above provides the clean follow-up
- A temporary 500 ms deferral moved status/detail reads, provider polling and skill discovery after initial visibility. In 20 paired samples, fresh rail medians were 209.2 versus 209.8 ms, and visible readiness 262.8 versus 261.3 ms. Agent readiness improved 247.5→239.1 ms, but retained rail and viewer medians became about 4–5 ms slower. The prototype was removed because it did not improve visible readiness enough to justify delaying status information
- Making initial readiness wait for all pending layout requests, while retaining early readiness after dialog close, did not recover earlier agent visibility in 20 paired samples. This special case was removed

These experiments preserve their installation roots and executable hashes in the raw artifacts. They do not replace the final correctness checks or real-configuration macOS measurements.

## Startup trace

Run with `PAPPARDELLE_STARTUP_TRACE=1`. Structured debug records appear in the normal Pappardelle log under `[startup]`. They contain launch ID, PID, span identity, elapsed time, category, outcome and allowlisted layout inputs; no raw commands, environment values, prompts or terminal output are included.

The first record uses process uptime and explicitly preserves the interval before tracing starts. `Pappardelle starting` now marks actual TUI startup in the CLI, rather than importing `app.tsx`; historical marker-relative timings therefore have a different origin.

An outside-tmux launcher passes tracing and its parent correlation through explicit session environment arguments. It finishes as `delegated`; each child and restart gets a new launch ID and PID. The child's launch ID is never embedded in the persisted restart command. `integration-tests/verify-startup-trace.py` verifies this against a server created before tracing was enabled, including the real restart command and subcommand isolation.

Monitor spans cover selected startup preparation only; background workspace-status probes do not consume the startup trace budget. Tracing ends after attachment, pending work and a 300 ms quiet observation interval. A 30-second cap and 512-record bound produce an explicit incomplete result. Disabled tracing allocates no spans and writes no trace records. Failure/cancellation records use debug logging and do not populate the error overlay.

The trace overhead comparison has 20 alternating trace-disabled/enabled samples. Host variation (fresh visible ranges of roughly 236–364 ms) exceeds any observable tracing difference; it does not justify claiming zero overhead. Performance claims above use trace-disabled samples. Native traced spans are labeled separately.

## Earlier-stage validation and boundaries

The implementation passed locked dependency installation, build, typecheck, all four program-status integrations, and 24 compiled CLI smoke tests. The monitor integrations ran with isolated HOME/config/state/socket directories and explicitly targeted cleanup. The final rebuild is byte-for-byte identical to the measured candidate executable.

Independent interactive QA exercised the built TUI with real persisted fixture state:

- Agent input delivery; help zoom/unzoom; preservation of 44-column rail and 50-column companion drags
- 160→80→100→160 transitions, rapid selection during a 300 ms interactive-shell delay, and correct targeting while another 400-column window was selected
- Ten exit/reopen cycles preserving exact agent and companion PIDs, including three shutdown-during-startup cases
- Attached-terminal exit restoring all termios attributes

No new defect was found. Interactive layout/input logs had no warning/error entries. The lifecycle run logged a raw-mode teardown `errno 5` diagnostic when quit killed the outer session before renderer teardown; a preserved-baseline run reproduced the same diagnostic, and terminal modes were restored. This existing behavior is not changed here.

QA reports and transcripts are saved locally as `.show-your-work/qa-interaction.*` and `.show-your-work/qa-lifecycle.*`; before/after pane captures are `.show-your-work/before-startup.txt` and `.show-your-work/after-startup.txt`. Both QA fixture servers, their agents and fixture directories were removed.

No commit, push or new PR is part of this work. The parent issue remains open for macOS validation and the review/shipping decisions required by the approved plan.
