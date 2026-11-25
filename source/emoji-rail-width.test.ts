import {test, expect} from 'bun:test';
import {resolveEmojiSlot} from './emoji-rail-width.ts';

test('an unconfigured emoji removes the slot', () => {
	expect(resolveEmojiSlot(undefined)).toBe(null);
});

test('an empty configured emoji reserves two columns', () => {
	expect(resolveEmojiSlot('')).toStrictEqual({
		text: '  ',
		needsSeparator: true,
	});
});

test('configured glyphs retain their presentation and separator', () => {
	for (const emoji of ['✨', '⭐', '✅', '❤', '🍝', '⚙️', '👨‍🍳', '👍🏽']) {
		expect(resolveEmojiSlot(emoji)).toStrictEqual({
			text: emoji,
			needsSeparator: true,
		});
	}
});
