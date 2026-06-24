import test from 'ava';
import widestLine from 'widest-line';
import {
	inkRenderPad,
	inkRenderWidth,
	railEmojiIsInkPadded,
} from './emoji-rail-width.ts';

// The bug class: single-BMP default-emoji-presentation symbols. Ink's layout
// reserves 2 cells (widest-line), but its writer draws them as 1 → Ink pads.
const inkPaddedEmoji = ['✨', '⭐', '✅', '⚡'];

// Emoji Ink draws at the exact width its layout reserved (no pad):
//   - astral surrogate pairs (value.length === 2): 🍝 🐝 🎸
//   - VS16-qualified BMP symbols (trailing U+FE0F is a second cell): ⚙️ ❤️
//   - text-default symbols Ink lays out as a single cell: ❤ U+2764, ✂ U+2702
const wellBehavedEmoji = ['🍝', '🐝', '🎸', '🔥', '⚙️', '🖲️', '❤️', '❤', '✂'];

test('inkRenderWidth counts bare BMP default-emoji as a single cell', t => {
	for (const emoji of inkPaddedEmoji) {
		t.is(inkRenderWidth(emoji), 1, `${emoji} should render as 1 cell in Ink`);
		// …while Ink's layout reserves 2 — that gap is the whole bug.
		t.is(widestLine(emoji), 2, `${emoji} layout width should be 2`);
	}
});

test('inkRenderWidth counts astral and VS16 emoji as two cells', t => {
	for (const emoji of ['🍝', '🐝', '🎸', '⚙️', '❤️']) {
		t.is(inkRenderWidth(emoji), 2, `${emoji} should render as 2 cells in Ink`);
	}
});

test('inkRenderWidth handles the blank-slot placeholder and plain text', t => {
	t.is(inkRenderWidth('  '), 2); // reserved-but-empty emoji slot
	t.is(inkRenderWidth(''), 0);
	t.is(inkRenderWidth('AB'), 2);
});

test('railEmojiIsInkPadded flags exactly the bug class', t => {
	for (const emoji of inkPaddedEmoji) {
		t.true(railEmojiIsInkPadded(emoji), `${emoji} should be Ink-padded`);
	}
});

test('inkRenderPad is the trailing-space gap Ink appends', t => {
	// One pad cell per bare-BMP default-emoji symbol…
	for (const emoji of inkPaddedEmoji) {
		t.is(inkRenderPad(emoji), 1, `${emoji} should pad by 1`);
	}

	// …and never a positive pad for emoji Ink draws at (or past) full width.
	// 🖲️ (astral + VS16) Ink actually over-counts, so its pad is negative — the
	// caller's `> 0` guard ignores that, which is what we want.
	for (const emoji of wellBehavedEmoji) {
		t.true(inkRenderPad(emoji) <= 0, `${emoji} should not pad`);
	}

	t.is(inkRenderPad('a ✨ b'), 1); // pad is additive across a string
	t.is(inkRenderPad('✨⭐✅'), 3);
	t.is(inkRenderPad('plain text'), 0);
	t.is(inkRenderPad(''), 0);
});

test('railEmojiIsInkPadded leaves well-behaved emoji alone', t => {
	for (const emoji of wellBehavedEmoji) {
		t.false(railEmojiIsInkPadded(emoji), `${emoji} should not be Ink-padded`);
	}

	// The blank slot ('  ') and an empty string both reserve exactly what they
	// draw — no pad, so the explicit separator is kept (rows still line up).
	t.false(railEmojiIsInkPadded('  '));
	t.false(railEmojiIsInkPadded(''));
});
