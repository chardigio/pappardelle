import test from 'ava';
import {dialogWidth} from './dialog-width.ts';

test('fills the full pane width, edge to edge', t => {
	// Master's dialog is a plain bordered <Box> with no width, which Ink stretches
	// to the parent — 76 cols of terminal renders a 76-cell box. TitledBox needs an
	// explicit number, so this has to reproduce that exactly rather than approximate.
	t.is(dialogWidth(76, 80), 76);
	t.is(dialogWidth(120, 80), 120);
});

test('is never capped on a wide terminal', t => {
	t.is(dialogWidth(400, 80), 400);
});

test('prefers the caller-supplied pane width over stdout columns', t => {
	// Inside tmux, stdout.columns can still report the pre-split terminal width;
	// app.tsx passes the measured pane width, which has to win or the hand-drawn
	// top border runs past the pane edge and wraps onto its own line.
	t.is(dialogWidth(60, 200), 60);
});

test('falls back to stdout columns when no pane width is supplied', t => {
	t.is(dialogWidth(undefined, 100), 100);
});

test('falls back to 80 when nothing is measurable', t => {
	t.is(dialogWidth(undefined, undefined), 80);
});

test('ignores a nonsensical zero or negative measurement', t => {
	// A pane width of 0 would collapse the frame to two corner glyphs; treat it
	// as "unmeasured" and fall through rather than render a degenerate box.
	t.is(dialogWidth(0, 100), 100);
	t.is(dialogWidth(-5, 100), 100);
	t.is(dialogWidth(0, 0), 80);
});

test('narrow panes are honored rather than forced to a minimum', t => {
	// Master has no floor — it stretches to whatever the pane is. Forcing a
	// minimum here would push the border past the edge on a narrow pane, which
	// is strictly worse than a cramped box.
	t.is(dialogWidth(24, 80), 24);
});
