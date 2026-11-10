import {
	setImmediate as nextTurn,
	setTimeout as delay,
} from 'node:timers/promises';
import test from 'ava';
import React from 'react';
import {useKeyboard} from '@opentui/react';
import {terminalView} from '../test/helpers/terminal-view.ts';

// RenderTui delivers a lone Escape early only in a tmux pane. Nothing here
// runs tmux, so the socket does not have to exist.
process.env['TMUX'] = '/nonexistent/tmux-socket,0,0';

const ESCAPE = '\u001B';
const PARSER_WAIT_MS = 20;

async function keyLog(t: {teardown: (fn: () => Promise<void>) => void}) {
	const keys: string[] = [];
	function KeyLog() {
		useKeyboard(key => {
			keys.push(key.meta ? `meta+${key.name}` : key.name);
		});
		return React.createElement('text', null, 'keys');
	}

	const view = await terminalView(React.createElement(KeyLog));
	t.teardown(async () => view.dispose());
	return {keys, stdin: view.stdin};
}

test.serial('a lone Escape is delivered on arrival, and only once', async t => {
	const {keys, stdin} = await keyLog(t);
	stdin.write(ESCAPE);
	await nextTurn();
	t.deepEqual(keys, ['escape']);
	await delay(PARSER_WAIT_MS * 3);
	t.deepEqual(keys, ['escape']);
});

test.serial('an escape sequence is left to the parser', async t => {
	const {keys, stdin} = await keyLog(t);
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	t.deepEqual(keys, ['up']);
});

test.serial(
	'an Escape at the end of other input is still delivered',
	async t => {
		const {keys, stdin} = await keyLog(t);
		stdin.write(ESCAPE);
		stdin.write('j');
		await delay(PARSER_WAIT_MS * 3);
		stdin.write(`a${ESCAPE}`);
		await delay(PARSER_WAIT_MS * 3);
		t.deepEqual(keys, ['escape', 'meta+j', 'a', 'escape']);
	},
);
