# STE-59: Pappardelle TUI design directions

## Context

STE-59 asks for a run-through of the pappardelle TUI and a design artifact with several directions for making it look deliberately designed, including whether animation is practical in a TUI. PR !58 (`damico-dev:migrate-opentui`, OpenTUI 0.8.2 + Bun) is assumed accepted, so all design work targets OpenTUI.

Deliverable: a published claude.ai Artifact. Implementing a chosen direction is a follow-up ticket.

### Decisions from alignment

| Decision        | Choice                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mockup fidelity | Real OpenTUI renders: each direction is built as OpenTUI components and run against fixture data. Frames are exported cell by cell into the artifact, and animations are captured as frame sequences       |
| Scope           | Artifact only (plus the preview tool). No changes under `source/`                                                                                                                                          |
| Color           | Two tiers. The ANSI base must work on the 16-color palette in light and dark themes. Truecolor is an opt-in layer that depends on `COLORTERM` and the detected theme (OSC 11), and the artifact shows both |
| Directions      | Quiet craft, Kitchen pass, Living rail                                                                                                                                                                     |
| OSC             | Deeper OSC 7501 integration (progress, message, title, tool), handled differently in each direction                                                                                                        |
| Surfaces        | Per direction: rail (with header and status line), new-session prompt, confirm and close dialogs, help and errors popups, tmux chrome                                                                      |
| Motion budget   | Explore freely. Label every effect with its trigger, fps and measured CPU cost                                                                                                                             |
| Preview code    | Committed under `design/` on STE-59, rebased onto `origin/migrate-opentui`                                                                                                                                 |

### What exists today (PR !58)

- Styling goes through `source/tui-style.ts`: `terminalColor()` maps ANSI names to `RGBA.fromIndex`, falls back to the default fg, and passes hex through. No backgrounds are set; every highlight uses `INVERSE`.
- Rows are built by `source/components/SpaceListItem.tsx`. Widths come from `source/list-view-sizing.ts`, emoji handling from `source/emoji-rail-width.ts`, and title truncation from `source/truncate-to-width.ts`.
- Status glyphs come from `source/program-status-display.ts`. Working is the 6-frame Claude spinner at 150 ms. Blocked rows blink as a whole-row red/blue inverse at 500 ms (`source/animation-clock.ts`).
- OSC 7501 reports carry `progress`, `msg`, `title` and `app`, and hooks carry `currentTool` and `lastUpdate`. None of these are rendered (`source/program-status.ts`, `source/claude-status.ts`).
- Rail width is 23–40 columns. At 28 columns a title gets about 8 cells.
- Known problems for the run-through to confirm:
  - selection inverse covers only the text width
  - every confirm uses a red double border, even Update
  - the help legend has no glyph for "working"
  - pending keys use `white`, which is risky on light themes
  - tmux chrome is generic (`colour238` / `cyan`)
  - viewer placeholders are bare `printf`
- OpenTUI 0.8.2 offers:
  - animation: `useTimeline`, `useAnimationTick` (one shared clock), `requestLive`, `translateX`/`translateY`, `opacity`
  - theme: `renderer.themeMode` and the `theme_mode` event
  - borders: `customBorderChars`, `title`/`bottomTitle` alignment
  - drawing: half-block and quadrant drawing, post-process filters
  - capture: `createTestRenderer().captureSpans()` returns spans with `RGBA`. The color intent (indexed, default or rgb) survives, so the artifact can re-theme ANSI frames.

## Approach

Everything lives in a new top-level `design/` directory. It imports from `source/` and never modifies it.

```
design/
  README.md               how to run preview, export, build-artifact
  tsconfig.json           extends root; includes design/ + source/
  fixtures.ts             fixture fleet + scripted scenes
  kit/
    frame.ts              captureSpans → compact frame JSON; ANSI (tmux capture) → same JSON via @xterm/headless
    motion.ts             pure time→value helpers (easing, pulse, sweep); components take `now` so export is deterministic
    color.ts              tier-aware tokens: ANSI index/default vs truecolor per themeMode; blend helper
  directions/
    current/              real components from source/ wrapped for side-by-side "before"
    quiet-craft/          tokens.ts, Rail.tsx, Prompt.tsx, Confirm.tsx, Popups.tsx, chrome.ts
    kitchen-pass/         same shape
    living-rail/          same shape
  primer/                 small animation demos for the "are animations a thing?" section
  preview.tsx             live terminal viewer
  export.ts               renders every direction × surface × tier × theme × width, plus scene sequences
  artifact/template.html  page shell + frame player
  build-artifact.ts       inlines exported frames into the template → design/out/*.html
```

The existing helpers are reused so each direction follows the same width rules as the app:

- `SpaceData`, `ProgramStatusInfo`
- `programStatusDisplay`
- `truncateToWidth`
- `rowPrefixWidth` / `railPrefixWidth` / `clipIssueKey`
- `resolveEmojiSlot`, `maybeStripSkinTones`
- `terminalColor`, `textAttributes`
- `getWorkflowStateColor`

`design/out/` is gitignored, since the output is regenerated.

### Directions (starting concepts, refined during build)

**Quiet craft.** Hierarchy comes from weight, spacing and dim text instead of borders and color.

- Status glyphs form one geometric family: `●` idle, rotating `◴◷◶◵` working, `◆` needs you, `✕` error, `○` unknown
- Selection is a full-width left bar `▌`. The truecolor layer adds a 6–8% accent background tint.
- Attention is a steady accent marker plus a header count instead of the blink. It pulses three times when the state changes, then stays steady.
- OSC: the selected row gets a detail line (`↳ Running tests · ▰▰▰▱▱ 12/30`) built from `msg` + `progress`, falling back to the hook `currentTool`
- Dialogs use one rounded border in dim default fg with a bold title. Destructive confirms put red only on the action keycap.

**Kitchen pass.** Builds on the pasta/kitchen theme that `sous-chef` already uses.

- Workspaces are tickets on the pass, with perforated dividers, ticket numbers and kitchen state names. Working is "firing", with an animated heat glyph `≋`; blocked is "service!"; done is "plated".
- The help legend pairs every state word with its plain meaning
- OSC: `msg` becomes the ticket note in italics, `progress` becomes courses `●●●○○`, and the ticket shows time in state
- Motion: tickets print in line by line, the title types in, a blocked agent gets a 300 ms "bell" nudge (translateX ±1) and then holds steady, and done gets a brief stamp
- Dialogs: a "New ticket" prompt with perforated custom borders, and close shown as a voided ticket

**Living rail.** Led by motion, with each animation tied to an event.

- Working agents breathe: a truecolor fade on the key, or a glyph cycle in ANSI
- New output (an OSC `msg` change or a hook event) runs a shimmer sweep across the title
- OSC `progress` fills the row background left to right in truecolor, or draws an eighth-block bar `▏▎▍▌▋▊▉█` in ANSI
- Attention is an eased pulse instead of a hard blink. If the blocked row is scrolled off, the header shows `↑ 1 needs you`.
- The selection pill glides at half-row resolution using `▀▄`
- Rows slide in when created and collapse with a fade when closed
- The header carries a fleet activity sparkline `▁▂▃▅▇`
- Dialogs open with a 120 ms expand and dim the rail behind them with an opacity scrim
- tmux: the active pane border takes the focused agent's state color

### Artifact sections

1. Toggles for terminal theme (dark/light reference palettes), color tier (16-color/truecolor), rail width (28/40) and layout (one/two-line)
2. Where it stands: before frames plus numbered run-through findings
3. "Are animations a thing in TUIs?": a primer on the motion vocabulary (glyph cycling, sub-cell blocks, half-block glide, color fades, shimmer, translate, opacity, typewriter). Each demo is a real OpenTUI frame sequence, with notes on cost and tmux caveats (truecolor needs `COLORTERM`, synchronized output).
4. What agents already report: the OSC/hook fields, what is shown today, and which fields each direction uses. Ideas that need new data (for example `stateSince`) are labeled as such.
5. One section per direction: concept, tokens for both tiers, rail at both widths and layouts, state legend, motion spec table (trigger, effect, duration, easing, fps, measured CPU) with playable scenes, prompt, confirms (destructive and neutral), help, errors, tmux chrome composite with a `tmux.conf` snippet, and OSC treatment
6. Comparison table, a recommendation, and which pieces can be mixed between directions
7. Notes for the follow-up implementation: which `source/` files change, and the risks

Frames are stored as interned rows, so a frame lists row ids and unchanged rows are not repeated. The page stays under 16 MB, and `build-artifact.ts` fails above 12 MB.

## Steps

### 1. Branch and baseline

- [x] Rebase STE-59 onto `origin/migrate-opentui` (fast-forward; STE-59 has no commits)
- [x] `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run test` pass on the base, and record the counts
- [x] Copy this plan to `plans/STE-59-tui-design-directions.md`

### Progress notes

- Published: https://claude.ai/artifact/CZAQ7bC1PZbAAE49BW1x7u
- Fidelity: 0 differing cells for every direction, tier and surface (rail, prompt, confirm, help, errors, the 150×34 tmux window). Capture uses `-N` so trailing tinted cells survive
- Final suite: 2496 passed (2492 + 4 new frame tests), same 2 pre-existing failures; xo 0 errors, 22 warnings (19 on the base + 3 `max-params`); prettier and both typechecks clean
- `package.json`: the xo override that disables `promise-function-async` for `source/**/*.tsx` now also covers `design/**/*.tsx`
- Bench (warm, % of one core over 10 s): today 1.5; Quiet 2.8/3.3; Kitchen 3.2/5.0; Living 4.6/7.3 (16 colors / truecolor, fleet at rest with working agents)

- Baseline on PR !58 (macOS): prettier clean; xo 0 errors / 19 warnings; AVA 2492 passed, 2 failed. The failures are pre-existing on PR !58: `native-input` Unicode backspace and `emoji-row-width` ❤️ picker row
- The run-through used an isolated `HOME`, `TMUX_TMPDIR`, `BEADS_DIR` and `PATH`. mise shims break under a fake `HOME`. Raw captures are kept in `design/captures/`
- OSC 7501 could not be driven live because fixture spaces have no agent sessions. OSC fields are covered by fixtures instead; the rail ignores them today anyway
- `kit/frame.ts` parses tmux SGR itself instead of using `@xterm/headless`, whose default Unicode tables count emoji as 1 cell. tmux carries SGR state across lines in captures
- Fidelity check: `bun design/fidelity.ts --direction current --frame calm --surface <s>` gives 0 differing cells for rail, confirm, confirm-neutral, help and errors
- Added at the user's request mid-build: Solarized Dark and Ghostty's default as terminal themes for every frame (`design/artifact/palettes.ts`), each with its own truecolor washes
- `kit/panel.tsx` draws borders from text cells so they can use `dim`: ANSI gray is the background on Solarized Dark
- PR !58 bug found: VS16 emoji (`🛠️`, `❤️`) are measured as 2 cells by `string-width`, but OpenTUI lays them out as 1. Rows with those profile emoji overflow by a cell; this is the macOS `emoji-row-width ❤️` failure. Design fixtures use `🔧` to avoid it
- PR !58 bug found: blocked rows in the blink-on phase are emitted as `7;38;5;N;48;5;N` (fg = bg under inverse), so the row is a solid bar with no text half the time

### 2. Run-through and before capture (/show-your-work before state)

- [x] Fixture repo in the scratchpad: beads tracker with ~10 issues, `.pappardelle.yml`, isolated `HOME` and `PAPPARDELLE_STATUS_DIR`. Run in a separate tmux server (`tmux -L ste59-design`) so the user's sessions are untouched.
- [x] Drive each state:
  - hook status files: working, tool, compacting, idle, blocked question/permission, error
  - OSC 7501 reports with `progress`/`msg` printed in agent panes
- [x] Capture with `tmux capture-pane -e` at 100, 120 and 160 columns and in the vertical layout (<100): rail, search, the `n` prompt, and the update banner if it can be triggered
- [x] Popups don't show in pane captures, so render `HelpOverlay`, `ErrorDialog`, `ConfirmDialog` and `CloseSpaceDialog` offscreen via `directions/current/`
- [x] Write the numbered findings that feed artifact section 2

### 3. Capture pipeline spike (fidelity check, blocks later steps)

- [x] `kit/frame.ts`: `captureSpans` to JSON with color intent (indexed/default/rgb), attributes and cell widths, and the same JSON from ANSI via `@xterm/headless`
- [x] Unit test (AVA) for the intent and attribute mapping: indexed vs default vs rgb, inverse, dim, wide graphemes
- [x] Minimal HTML frame renderer that draws one real `SpaceListItem` row set
- [x] Fidelity check: render a direction frame live in tmux (`preview.tsx --static`), capture it, convert it, and diff it cell by cell against the offscreen export. The rest of the work starts only when chars, attrs and intents are identical.

### 4. Shared kit, fixtures, preview and export

- [x] `fixtures.ts` covers:
  - every program state, the pending rows and the main row
  - every pipeline state, comments and conflict
  - Linear hex, Jira hex and beads ANSI state colors
  - emoji and blank emoji slots
  - OSC `progress`/`msg`/`title`
- [x] Scenes (scripted event timelines): working, then blocked, then idle; OSC progress 0 to 100 with `msg` changes; create row; close row; move selection; open dialog
- [x] `kit/motion.ts` and `kit/color.ts`, with components as pure functions of `now`
- [x] `preview.tsx`:
  - `bun design/preview.tsx <direction> [--surface] [--width] [--tier] [--theme] [--static t] [--bench]`
  - keys switch direction, surface and tier, play scenes, and move selection with j/k
  - live time comes from `useAnimationTick`
- [x] `--bench`: plays each scene for 10 s with the real renderer and reports `process.cpuUsage` while idle and while animating. These numbers fill the CPU column of the motion tables.
- [x] `export.ts` writes `design/out/frames.json`

### 5. Quiet craft

- [x] Tokens for both tiers; rail at 28/40 columns in one- and two-line layouts; header and status line; OSC detail line
- [x] Prompt, confirm (destructive and neutral), help, errors
- [x] tmux chrome composite + snippet
- [x] Scenes exported; bench numbers recorded

### 6. Kitchen pass

- [x] Same checklist as step 5 (rail, dialogs, chrome)

### 7. Living rail

- [x] Same checklist as step 5 (rail, dialogs, chrome)

### 8. Primer demos

- [x] Glyph cycle, eighth-block progress, half-block glide, truecolor fade vs ANSI fallback, shimmer, translate slide, opacity scrim, typewriter, each as a short exported sequence with a bench number

### 9. Artifact

- [x] Run the Artifact quickstart (`intent: other`) and load the `artifact-design` skill before writing the template
- [x] `artifact/template.html` + `build-artifact.ts`: frame player (play/pause, scrub), the toggles, light and dark page themes, phone width with no page-level horizontal scroll (frames scroll inside their own container)
- [x] Write the copy for sections 2–7 and deslop it
- [x] Publish privately and record the URL in the plan file and the README

### 10. Validation

- [x] Fidelity diff from step 3 re-run against one frame per direction
- [x] Live look in tmux for each direction under these conditions (done by the qa-preview agent; its captures were checked in the QA rounds rather than committed):
  - `COLORTERM` unset and `COLORTERM=truecolor`
  - `--theme light` and `--theme dark`
  - captures saved
- [x] agent-browser over the artifact:
  - screenshots at desktop and 390 px width, in both page themes
  - every toggle and the player exercised
  - no console errors, size under the cap
- [x] `bun run typecheck`, `bun --bun tsc -p design/tsconfig.json --noEmit`, prettier, xo, and `bun run test` with the same counts as the base plus the new frame test
- [x] /qa-time
  - Four QA agents (preview, render, page, pipeline) reported 78 defects
  - User decisions on the judgment calls:
    - narrow rails (15–22 columns) follow a shared drop order: age, then comments, then pipeline, until the title has 6 cells; Mission control drops its title before its readout
    - Living rail keeps tracker colors on keys, held to 4.5:1
    - 16-color chips use default-color inverse
    - every row with a detail shows its detail line, so selection never reflows
    - dialogs at small sizes are noted, not fixed; Kitchen pass tickets slide between stations (250 ms)
  - Render fixes done in `design/`; the pipeline (16) and page (17) fixes were made by two fix agents
  - qa-preview re-verified its fixes; its leftovers (glide dip, j/k order in Kitchen pass, ring vs done glyph, `--static` clip, flag parsing) are fixed
  - Two more app-relevant emoji width findings were sent to the main session (`pappardelle send main`)
  - Re-verification rounds (preview, render, page, pipeline) until every item held; further user decisions:
    - Mission control keeps its title exception (title goes before the pipeline glyph and readout)
    - pipeline glyphs (✗ ↯) outrank the title minimum, so widening a rail never hides a failure
  - Bench: scenes now render on scripted events (fixtures `events`) instead of a 4 fps fallback; the first measured phase read 10-25% high, so runBench measures two full passes and reports the second
  - Final bench, export, build and republish done (artifact v4)

### 11. Mission control (added after QA at the user's request)

- [x] Fourth direction, `design/directions/mission-control/`: dense instrument panel. Fleet composition bar and counts in the header; per-row telemetry readout (OSC progress %, tool, or a 4-letter state code) and an activity sparkline; rows with telemetry carry gauges (progress bar, message, time in state); master-caution alert when an agent needs you
- [x] Same surfaces as the others: rail, prompt (launch console), confirms, help (keymap), errors (fault log), tmux chrome + snippet
- [x] Register it and re-run fidelity for its surfaces (0 differing cells on all 7, both tiers)
- [x] Direction 4 section, comparison and OSC columns on the page
- [x] Bench, export, rebuild and republish

## Out of scope

- Changing `source/` or the app's behavior
- Choosing the final direction; that is the user's call after the artifact
- OSC protocol changes. The artifact can propose them, labeled as needing new data.

## Risks

- PR !58 may change before merge, which would force a rebase of STE-59. `design/` only reads from `source/`, so conflicts are limited to the helpers' signatures.
- An HTML grid drifts from real terminals on emoji and box-drawing widths. Mitigation: per-cell widths taken from the spans, a fixed web mono font, and the step 3 fidelity diff.
- Post-process filters corrupt wide graphemes (OpenTUI docs). Directions avoid them on rows that contain emoji.
