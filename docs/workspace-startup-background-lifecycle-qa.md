# Background deferral lifecycle QA

Passed against binary SHA `ecd9a2b3d8b35cd4e41a043fbacb6c17e7d49fdff2ab308922d34c2fd4ca6776` using an isolated Linux HOME/repository, real tmux, and dummy agent/companion programs. This is behavior evidence, not a timing measurement or macOS/Claude acceptance.

- Ten fixed repetitions passed normal launch, rapid selection changes, `q` exit and reopen while preserving exact main agent/companion shell and program PIDs
- Iterations 3, 6 and 9 sent SIGTERM to the owned TUI process after its initial pane split, then reopened successfully without replacing retained programs
- An attached PTY accepted `q`, exited, and restored the complete original termios attributes while preserving inner program PIDs
- Three alternating baseline/candidate pairs sent `q` as soon as the first outer pane appeared. Both builds ignored this pre-mount key in all three attempts; a second `q` after UI readiness exited successfully in every attempt. The comparison baseline was the preserved previous combined build, SHA `0d29663b`, rather than a newly rebuilt baseline
- Cleanup verified both isolated servers absent, every tracked shell/program PID absent, and zero processes carrying the fixture marker. The fixture directory and PTYs were removed

No introduced lifecycle defect found. Logs still contain raw-mode teardown errno5 after outer-session closure, already present in the preserved original baseline. Complete attached-PTY termios restoration passed. Keyboard handling before UI mount is not claimed; the early-quit comparison documents the existing limitation separately from startup SIGTERM recovery.

Captures, retained identities, terminal result, early-quit comparison and teardown logs. Replay scripts and raw terminal capture remain under `.show-your-work/background-lifecycle*` and `.show-your-work/background-early-quit*` for local audit. No fixture processes remain running.
