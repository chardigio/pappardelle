# Rail interaction QA

Isolated real app fixture; no performance claims.

- PASS fresh startup: rail lists workspaces and both viewers report QA_READY
- PASS dummy agent receives literal viewer input
- PASS 10 filter round trips, including 3 immediate reopens; rail returns with correct workspace rows
- PASS help dialog zoom/unzoom
- PASS rail44 and companion50 drags survive zoom/unzoom
- PASS width transition to 80: required viewers ready
- PASS width transition to 100: required viewers ready
- PASS width transition to 160: required viewers ready
- PASS rail drag persists after narrow/wide reconstruction
- PASS rapid selection with delayed shell initialization ends with both viewers attached to qa-3
- PASS return to main restores both viewers
- PASS filter layout targets original window while another400-column window is selected
- Log scan: 0 warning/error lines
- Cleanup: owned fixture servers stopped and fixture directory removed
