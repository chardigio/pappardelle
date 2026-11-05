# TUI design directions (STE-59)

Prototypes of four directions for the rail and its dialogs, built as real
OpenTUI components on top of the OpenTUI migration (PR !58). Nothing here is
imported by the app; it reads from `source/` and never changes it.

Published page: https://claude.ai/artifact/CZAQ7bC1PZbAAE49BW1x7u

## Run a direction in your terminal

```sh
bun design/preview.tsx quiet-craft    # or kitchen-pass, living-rail, mission-control, current
```

| Key     | Does                                                         |
| ------- | ------------------------------------------------------------ |
| ← / →   | switch direction                                             |
| Tab     | cycle surfaces: rail, prompt, confirms, help, errors, chrome |
| t       | toggle 16 colors and truecolor                               |
| l       | cycle themes: dark, light, Solarized Dark, Ghostty default   |
| o       | toggle one- and two-line rows                                |
| j / k   | move the selection (when no scene is playing)                |
| Space   | play the next scene                                          |
| q / Esc | quit                                                         |

Flags:

- `--surface`, `--width` (15–40), `--tier`, `--theme`, `--layout`, `--scene`
- `--static <ms>`: render one instant and hold it
- `--frame still|calm`: the resting fleet; `calm` has nothing animating
- `--bench`: measure CPU per scene (used by `bench.ts`)

Things to know when judging what you see:

- Truecolor needs `COLORTERM=truecolor` (or `24bit`). Without it the
  terminal gets 256-color approximations, and the status bar warns about it.
- Rails taller than the terminal are cut off at the bottom, the way a
  scrolled rail would be.
- The theme only changes the colors the directions compute (washes, tints).
  Text in the default color is still your terminal's, so pick the theme that
  matches your terminal.
- `current` is the shipped component on its own timers and ANSI colors.
  Tier, theme and `--static` don't apply to it.

## Rebuild the page

The scripts run from any directory.

```sh
bun design/bench.ts            # CPU per direction and scene, ~19 min, needs tmux
bun design/export.ts           # every frame a page element can show -> design/out/frames.json
bun design/build-artifact.ts   # -> design/out/pappardelle-tui-directions.html
```

- `bench.ts` sets the old `bench.json` aside and puts it back if a run fails,
  so the page never mixes numbers from two passes. A failed run exits
  non-zero and prints what its pane showed.
- `export.ts` stops, naming the frame, when a rendered row's cells don't add
  up to the canvas width. Emoji with VS16, skin tones or ZWJ do that, since
  `Bun.stringWidth` and OpenTUI measure them differently.
- `build-artifact.ts` embeds only the frames the template references, with
  `{variant}`, `{width}` and `{layout}` expanded over the toolbar's buttons,
  and stops if one of them is missing from `frames.json`.

`bun design/fidelity.ts` renders a surface live in a tmux pane and offscreen,
then compares them cell by cell. Flags: `--direction` (repeatable, default
`current`), `--surface` (default `rail`), `--tier`, `--theme`, `--width`
(rails only) and `--frame still|calm`. `current` runs its spinner and blink on
the wall clock, so it is compared on the `calm` frame unless `--frame` says
otherwise. Each case should report 0 differing cells.

## Layout

- `fixtures.ts`: the fixture fleet and the animated scenes
- `kit/`: frame capture, colors per tier and theme, motion helpers, shared drawing
- `directions/`: `current` wraps today's components; one folder per direction
- `primer/`: the animation technique demos
- `captures/`: raw `tmux capture-pane -e` output from the PR !58 run-through
- `artifact/`: page template, frame player and reference terminal palettes
