import {test, expect} from 'bun:test';
import {keysFromStdin} from '../test/helpers/render.ts';
import {typedText} from './key-press.ts';

// Feed terminal bytes through the native parser and React hook, including the
// CSI-u sequences emitted by Kitty-capable terminals and tmux passthrough.
for (const [label, bytes, typed] of [
	['uppercase shortcut', 'K', 'K'],
	['Kitty uppercase shortcut', '\x1b[107;2u', 'K'],
	['Kitty Ctrl+C', '\x1b[99;5u', ''],
	['Ctrl+Q', '\x11', ''],
	['Alt+q', '\x1bq', ''],
	['space', ' ', ' '],
] as const) {
	test(`${label} types ${JSON.stringify(typed)}`, async () => {
		const keys = await keysFromStdin(bytes);
		expect(keys.map(key => typedText(key))).toStrictEqual([typed]);
	});
}

test('Kitty key releases do not repeat application actions', async () => {
	const keys = await keysFromStdin('\x1b[106;1:1u\x1b[106;1:2u\x1b[106;1:3u');
	expect(keys.map(key => typedText(key))).toStrictEqual(['j', 'j']);
});
