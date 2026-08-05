import test from 'ava';
import stringWidth from 'string-width';
import widestLine from 'widest-line';
import {
	inkRenderPad,
	inkRenderWidth,
	normalizeRailEmoji,
	railEmojiIsInkPadded,
	resolveEmojiSlot,
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

// ============================================================================
// resolveEmojiSlot — the three-state slot shared by the rail and the picker
// ============================================================================

test('resolveEmojiSlot returns null when the user has no emoji configured at all', t => {
	t.is(resolveEmojiSlot(undefined), null);
});

test('resolveEmojiSlot reserves a blank two-cell slot for an empty string', t => {
	t.deepEqual(resolveEmojiSlot(''), {
		text: '  ',
		needsSeparator: true,
		overflowCells: 0,
	});
});

test('resolveEmojiSlot emits its own separator for emoji Ink does not pad', t => {
	// None of these is padded, so STA-1861's normalization leaves every one of
	// them exactly as configured — `normalizeRailEmoji` in the expectation is
	// the identity here, and pins that it stays that way.
	for (const emoji of wellBehavedEmoji) {
		t.deepEqual(resolveEmojiSlot(emoji), {
			text: normalizeRailEmoji(emoji),
			needsSeparator: true,
			overflowCells: 0,
		});
	}
});

test('resolveEmojiSlot widens the bug class and lets Ink’s pad separate it', t => {
	for (const emoji of inkPaddedEmoji) {
		t.deepEqual(resolveEmojiSlot(emoji), {
			text: emoji + '️',
			needsSeparator: false,
			overflowCells: 0,
		});
	}
});

test('resolveEmojiSlot agrees with railEmojiIsInkPadded for every sample', t => {
	for (const emoji of [...wellBehavedEmoji, ...inkPaddedEmoji]) {
		// The predicate is asked about the glyph the slot actually renders, not
		// the raw config value — those differ for anything normalization touched.
		const slot = resolveEmojiSlot(emoji)!;
		t.is(slot.needsSeparator, !railEmojiIsInkPadded(slot.text));
	}
});

test('the normalized glyph still measures 2 cells to `string-width` too', t => {
	// `SpaceListItem` budgets the ticket-rail title with the npm `string-width`
	// package — a different width table from the `widest-line`/`ansi-tokenize`
	// pair everything else here measures with, and one this file's own header
	// warns disagrees with Ink's bundled copy for exactly this symbol class. The
	// normalized glyph has to read as 2 cells to *both* or the rail's title
	// budget silently drifts a column. Pinned so a `string-width` bump that
	// starts counting U+FE0F as its own cell fails here rather than in the rail.
	for (const emoji of inkPaddedEmoji) {
		t.is(stringWidth(resolveEmojiSlot(emoji)!.text), 2, `${emoji} normalized`);
	}

	// The blank slot holds the same two columns.
	t.is(stringWidth(resolveEmojiSlot('')!.text), 2);
});
