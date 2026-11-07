import React from 'react';
import test from 'ava';
import {useKeyboard} from '@opentui/react';
import {render} from '../test/helpers/render.ts';
import {shortcutKey} from './tui-key.ts';

// Feed terminal bytes through the native parser and React hook, including the
// CSI-u sequences emitted by Kitty-capable terminals and tmux passthrough.
for (const [label, bytes, input, property] of [
	['uppercase shortcut', 'K', 'K', 'shift'],
	['Kitty uppercase shortcut', '\x1b[107;2u', 'K', 'shift'],
	['Kitty Escape', '\x1b[27u', '', 'escape'],
	['Kitty Ctrl+C', '\x1b[99;5u', 'c', 'ctrl'],
	['Alt+Right', '\x1b[1;3C', '', 'rightArrow'],
	['Shift+Tab', '\x1b[Z', '', 'tab'],
	['space', ' ', ' ', undefined],
] as const) {
	test.serial(`native shortcuts preserve ${label}`, async t => {
		const received: Array<ReturnType<typeof shortcutKey>> = [];
		function Listener() {
			useKeyboard(event => received.push(shortcutKey(event)));
			return React.createElement('text', {}, 'listening');
		}
		const view = await render(React.createElement(Listener));
		t.teardown(() => view.unmount());
		await view.stdin.write(bytes);
		t.is(received.length, 1);
		t.is(received[0]?.input, input);
		if (property) t.true(received[0]?.key[property]);
	});
}

test.serial('Kitty key releases do not repeat application actions', async t => {
	const received: string[] = [];
	function Listener() {
		useKeyboard(event => received.push(shortcutKey(event).input));
		return React.createElement('text', {}, 'listening');
	}
	const view = await render(React.createElement(Listener));
	t.teardown(() => view.unmount());
	await view.stdin.write('\x1b[106;1:1u\x1b[106;1:2u\x1b[106;1:3u');
	t.deepEqual(received, ['j', 'j']);
});
