# STE-75: join the rail's agents divider to the rail frame

## Context

The rail draws its own rounded frame (`PaneFrame`, title "rail"). The divider between the agent spaces (sous-chef) and the workspace groups is a dim rule inside that frame with one blank cell of padding on each side, so it doesn't touch the frame:

```
╭─ rail ──────────────╮
│    ● sous-chef      │
│ ─────────────────── │
│ ▾ In Progress (3)   │
```

The goal is one connected line, with tees where the divider meets the frame:

```
╭─ rail ──────────────╮
│    ● sous-chef      │
├─────────────────────┤
│ ▾ In Progress (3)   │
```

Only the rail changes. The agent pane's frame and tmux's border column stay as they are. (The Jira prompt mentioned the agent frame and `├`; we agreed the join is inside the rail, with `├` on the left edge and `┤` on the right.)

## Decisions

- Rail only: no tmux options, no frame-host changes, no floating panes
- The divider takes the rail frame's color: dim when the rail is unfocused and normal when it is focused, matching the frame (`paintFrame` with `isDim: !isActive`). Today it is always dim
- Move `RailDivider` to its own `source/components/RailDivider.tsx`. STE-74 is reworking `RailGroupHeader.tsx` (sous-chef note), so its edits to that file only conflict on the removed block

## Approach

The divider row sits inside the frame's content box, one column in from each frame edge. OpenTUI calls a renderable's `renderAfter` in its own paint slot, and a parent's slot paints before its children's, so a child's `renderAfter` can draw over the frame's `│` cells on its row.

`RailDivider` becomes a one-row `<box>` with no text children and a `renderAfter` that draws `├` + `─`×width + `┤` from `this.x - 1` to `this.x + this.width`, using the same color and attributes as `paintFrame` (`BorderChars.rounded`, `textAttributes({dim: !isActive})`, default border color).

So the frame's look is defined in one place, add an exported helper to `source/components/frame-paint.ts` that paints a tee'd rule across a frame (`paintFrameRule(box, buffer, {style, isDim, borderColor?})`), reusing the existing `rule` color/attribute logic. `RailDivider` calls it, so the divider and the frame use the same glyphs and dimming.

`app.tsx` passes `isActive={isRailFocused}` to `RailDivider` (alongside the existing `width`).

If the test in step 1 shows the frame's `renderAfter` paints after the child (the opposite of the slot order read from `@opentui/core`), fall back to `PaneFrame` taking a `teeRows` prop and painting the tees itself, with `RailDivider` reporting its row through `onSizeChange`/layout. Use the fallback only if the red test requires it.

## Files

- `source/components/RailDivider.tsx` (new): the divider, moved from `RailGroupHeader.tsx`
- `source/components/RailGroupHeader.tsx`: remove `RailDivider` and its `dimText` import
- `source/components/frame-paint.ts`: add `paintFrameRule`, sharing color/attribute setup with `paintFrame`
- `source/app.tsx`: import from the new file, pass `isActive`
- `source/components/rail-divider.test.ts` (new): render test

## Steps

- [x] 1. Red test: `rail-divider.test.ts` renders `PaneFrame` (width 20, height 5) with a text row, a `RailDivider`, and a text row, using `test/helpers/render.ts` like `titled-box-dim.test.ts`. Assert the divider row reads `├──────────────────┤` and the rows above and below still start and end with `│`. Second test: the divider row's spans carry `TextAttributes.DIM` when `isActive` is false and not when it is true. Run `bun --bun ava source/components/rail-divider.test.ts` and see it fail
- [x] 2. Add `paintFrameRule` to `frame-paint.ts`
- [x] 3. Create `RailDivider.tsx` with the `renderAfter` box; remove the old component from `RailGroupHeader.tsx`
- [x] 4. Wire `app.tsx`: new import, `isActive={isRailFocused}`
- [x] 5. Green: the new tests pass; `bun run test` (prettier, xo, ava) and `bun run typecheck` pass
- [x] 6. Prove it in the running app (below)

## Validation

- Unit/render tests from step 1 (fail before, pass after)
- `bun run test` and `bun run typecheck`
- Running app: run the dev build of the rail in a scratch tmux session (or reload this Pappardelle via `tui_restart` after building), then `tmux capture-pane -p` on the rail pane:
  - divider row reads `├───…───┤`, joined to the frame on both sides
  - focus the agent pane and capture with `-e`: divider and frame both dim; focus the rail: both normal
  - resize the rail pane narrower and wider: the tees stay on the frame edges
  - search mode (no divider) and a rail with no agent spaces render as before
- /show-your-work: capture the rail pane before the change (now) and after, for the PR

## Risks

- The paint order comes from reading OpenTUI internals; step 1's render test confirms it before anything else depends on it
- Rebase with STE-74: conflicts limited to the `RailDivider` block removed from `RailGroupHeader.tsx` and the call site in `app.tsx`
