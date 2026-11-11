# Linux startup baseline — pappardelle-3wf

Measured on 2026-11-05 before changing application startup code. The final matrix has 90 successful readiness samples and no failed samples: five runs of 18 cases. Every sample completed two post-setup relayouts. These results establish a baseline, not an optimization result.

## Results

Main plus three registered workspaces, clean shell, milliseconds from outer-session launch:

| Width × height | Sessions | Required viewers attached, median | Ready markers visible, median | Visible range |
| -------------- | -------- | --------------------------------: | ----------------------------: | ------------: |
| 80 × 52        | Fresh    |                             227.3 |                         230.3 |   229.5–230.7 |
| 80 × 52        | Retained |                             205.2 |                         208.0 |   207.0–210.9 |
| 100 × 52       | Fresh    |                             231.4 |                         261.1 |   259.9–262.7 |
| 100 × 52       | Retained |                             208.3 |                         212.7 |   210.9–212.8 |
| 160 × 52       | Fresh    |                             233.3 |                         262.3 |   259.4–262.9 |
| 160 × 52       | Retained |                             210.0 |                         213.9 |   212.5–240.0 |

The 80-column layout requires only the agent viewer. Wider layouts require both agent and companion viewers. Attachment and visibility are independent observations, so their sampled ordering can differ. Polling occurs every 20 ms plus observer subprocess time; changes around that scale need more samples and internal spans.

At 100 columns with three registered workspaces, fresh agent readiness was 238.1 ms. Adding one second to the fixture's interactive `.bashrc` moved median agent readiness to 1,237.4 ms and marker visibility to 1,255.8 ms; viewer attachment remained 231.6 ms. Shell readiness is distinct from attachment. Dummy Python readiness does not measure Claude initialization or resume.

All 30 retained-session samples verified unchanged process IDs and ready timestamps, including after the observation window. Their readiness is reported as pre-existing, with no launch-relative readiness duration. The preparation TUI exits and all previous viewer clients detach before the measured launch begins. Inner sessions and fixture files remain alive until explicit teardown.

The raw matrix also includes main alone and the delayed-shell cases at all three widths. It retains every sample, minimum, median, maximum, provider invocation, application log event, and final pane transcript:

- Final raw matrix
- Separate subprocess trace
- Alternating identical-build check

## Command trace and investigation targets

The separate instrumented sample uses a fresh 100 × 52 layout with three registered workspaces. It records 63 completed tmux calls and 8 Git calls. Two long-lived viewer attach commands remain incomplete at capture time and are listed separately in the raw artifact. Observer commands and fixture Git setup are excluded.

There are 29 `display-message` calls. These include geometry, TTY, monitor and version queries; they are not all geometry queries. The trace shows:

- Separate initial width and height queries, followed by separate post-split window and side-pane measurements
- An initial reconciliation before session creation, then a second reconciliation after viewer attachment
- Sequential agent and companion session preparation
- Sequential viewer TTY queries, client queries, respawns and post-respawn TTY queries
- Version and commit lookups before renderer initialization

All 90 untraced samples also log two completed relayouts. Code inspection shows the first layout and attachment share a serialized task queue, while discovery can run independently. The React layout effect depends on loading and workspace count as well as dialog state. Startup spans must establish which requests each pass serves before removing either pass; renderer dimension reconciliation and the settled revision are correctness requirements.

Python command wrappers materially perturb timing. Use this trace for counts and ordering, not native per-call costs. Overlapping command durations must not be summed. This Linux run does not reproduce the reported macOS latency.

## Fixture and provenance

- Source commit: `66d8e7d2a1b687ef937e19b958a3dbc1e4624fbb`
- Preserved executable SHA-256: `3362a6c678606e6953f39c881b5eb2a3b30a704144dfbbdf4004a9c8cabcc57b`
- Baseline installation: `/tmp/pappardelle-3wf-baseline-bipgmn76`, containing matching `dist`, `source`, `scripts`, `hooks`, assets and package files, with the existing dependency symlink
- All 841 preserved file hashes matched the manifest before and after measurement
- Git metadata points at the unchanged source worktree so installation metadata lookup remains comparable
- Linux x86-64, Bun 1.4.4, tmux `next-3.9`, Python 3.15.2, Git 2.56.0, Bash 5.3.20
- Each sample gets isolated HOME, XDG directories, repo, registry and tmux socket directory; inherited tmux variables and credentials are absent
- Beads and GitHub are explicit local stubs; unused provider/agent CLIs are blocked by stubs; update checks are skipped in local mode with a primed cache
- No user agents or workspaces are used; OS caches are not flushed
- The harness hash, executable paths, tool versions and settings are embedded in the final artifact

The two executables in the alternating check have identical hashes and equivalent runtime layouts. Five paired fresh and retained samples each passed (20 total). Median visible readiness was 260.4 versus 260.2 ms fresh, and 212.1 versus 212.1 ms retained. A fresh outlier reached 303.2 ms; retain such variation when assessing later improvements. This check preceded the final preparation-process exit wait and is not an optimized candidate comparison.

## Measurement corrections and validation

Pilot artifacts remain under `.show-your-work/`. The first provider stubs did not handle the current `bd --id=…` and GitHub repository lookup schemas; those pilots are superseded. A first full run stopped during fixture deletion because a pipe-pane monitor completed a final write after tmux exited. Cleanup now retries only `ENOTEMPTY`, for at most two seconds, outside the measured interval.

The second matrix reached all readiness milestones but included preparation-TUI terminal shutdown errors in reopened launches' log windows. The final matrix waits for that process to exit before timing and contains no warning/error log records. Forced fixture teardown is not a test of graceful terminal restoration.

Validation covered the final 90-sample matrix, the separate traced launch, the 20-sample identical-build comparison, Python compilation and diff whitespace checks. An intentional 10 ms timeout produced a failed sample, an empty successful-timing summary and exit status 1. Historical benchmark artifacts were not overwritten. Application code and the preserved binary are unchanged; the application's full correctness/QA suite belongs to the subsequent implementation phase.

## Reproduction

Use a new output path; the harness rejects existing files:

```sh
python3 scripts/benchmarks/workspace-ready.py --binary /tmp/pappardelle-3wf-baseline-bipgmn76/dist/pappardelle --runs 5 --trace --output /tmp/startup-baseline-new.json
```

After building a candidate with its matching runtime files, alternate the same cases between installations:

```sh
python3 scripts/benchmarks/workspace-ready.py --binary /tmp/pappardelle-3wf-baseline-bipgmn76/dist/pappardelle --candidate dist/pappardelle --runs 5 --output /tmp/startup-comparison-new.json
```

`--trace` records a separate representative baseline sample; invoke it separately with the candidate as `--binary` for candidate command evidence. Opt-in application spans, optimization, stress/interactive QA and macOS reproduction remain outstanding under the approved v2 plan.
