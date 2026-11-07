# Lifecycle QA

Fixed 10 repetitions against isolated fixture; no performance claims.

PASS repetition 1: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 2: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 3: outer exit, retained main agent/companion PIDs, reopen, rapid selection; startup shutdown

PASS repetition 4: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 5: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 6: outer exit, retained main agent/companion PIDs, reopen, rapid selection; startup shutdown

PASS repetition 7: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 8: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS repetition 9: outer exit, retained main agent/companion PIDs, reopen, rapid selection; startup shutdown

PASS repetition 10: outer exit, retained main agent/companion PIDs, reopen, rapid selection

PASS attached PTY: q exits, complete termios attributes restored, inner program PIDs preserved

Fixture servers stopped with qkill; fixture directory retained until evidence review/cleanup

Binary SHA-256: 2302b230d0c5a75a9b298f9631082d0a1680afccb6c9dd5e50f537215afd83f5. Retained identities: {"agent-repo-main": {"shellPid": 2422796, "agentPid": 2422826}, "companion-repo-main": {"shellPid": 2422797, "agentPid": 2422808}}.

Initial attempt failed an early-q assertion at iteration3; preserved in review-fixes-lifecycle-first-attempt.md/.json and first-failure logs. Controlled five-pair baseline/candidate comparison found q immediately after splits ignored5/5 on each build; second q after readiness exited10/10. This is input-readiness timing, not a new shutdown regression. Raw timing/captures: review-fixes-early-quit.json.

Final fixed10-cycle pass uses owned-pane PID SIGTERM at startup on iterations3/6/9, followed by explicit owned outer cleanup and successful reopen. All10 ordinary q exits/reopens retained exact main program PIDs, rapid selection passed, and attached PTY restored complete termios attributes.

Cleanup verified: both servers absent, all retained shell/program and signalled startup PIDs absent, owned fixture directory removed. Only reports, captures and replay scripts remain in .show-your-work.
