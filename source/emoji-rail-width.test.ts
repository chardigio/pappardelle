import test from 'ava';
import {resolveEmojiSlot} from './emoji-rail-width.ts';

test('an unconfigured emoji removes the slot', t => {
	t.is(resolveEmojiSlot(undefined), null);
});

test('an empty configured emoji reserves two columns', t => {
	t.deepEqual(resolveEmojiSlot(''), {text: '  ', needsSeparator: true});
});

test('configured glyphs retain their presentation and separator', t => {
	for (const emoji of ['✨', '⭐', '✅', '❤', '🍝', '⚙️', '👨‍🍳', '👍🏽']) {
		t.deepEqual(resolveEmojiSlot(emoji), {text: emoji, needsSeparator: true});
	}
});
