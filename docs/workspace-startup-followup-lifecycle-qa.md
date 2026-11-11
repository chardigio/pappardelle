# Startup follow-up lifecycle QA

Passed against binary SHA `0d29663b776f20cd670fbf8703665742a74fcc9bad6868b0755b2954b5718570` using an isolated Linux HOME/repository, real tmux, and dummy agent/companion programs. This is behavior evidence, not a timing measurement or macOS/Claude acceptance.

- Ten fixed repetitions: fresh start/reopen, rapid selection changes, `q` exit, and retained main agent/companion shell and program PIDs
- Iterations 3, 6 and 9 also sent SIGTERM to the owned TUI process during startup, then reopened successfully without replacing retained programs
- An attached PTY accepted `q`, exited, and restored the complete original termios attributes while preserving inner program PIDs
- Both isolated tmux servers and all tracked fixture processes were absent after cleanup; the fixture directory and PTYs were removed

No introduced lifecycle defect found. Logs still contain `setRawMode failed with errno: 5` after outer-session teardown, also recorded in the preserved original baseline (`.show-your-work/qa-lifecycle-baseline.json`). This does not indicate a new regression; the attached PTY restoration check passed. Startup SIGTERM is tested separately from keyboard readiness: this test does not claim that `q` is handled before the UI mounts.

Captures, retained identities, terminal result and teardown logs. Replay script and raw terminal capture remain under `.show-your-work/startup-followup-lifecycle*` for local audit; no fixture processes remain running.
