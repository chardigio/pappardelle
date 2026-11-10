import {
	setImmediate as nextTurn,
	setTimeout as delay,
} from 'node:timers/promises';
import test from 'ava';
import React from 'react';
import {useKeyboard} from '@opentui/react';
import {terminalView} from '../test/helpers/terminal-view.ts';
import {deliverHeldKeysAtOnce} from './lone-escape.ts';

// RenderTui delivers a lone Escape early only in a tmux pane. Nothing here
// runs tmux, so the socket does not have to exist.
process.env['TMUX'] = '/nonexistent/tmux-socket,0,0';

const ESCAPE = '\u001B';
const PARSER_WAIT_MS = 20;

async function keyLog(
	t: {teardown: (fn: () => Promise<void>) => void},
	typedAhead = '',
) {
	const keys: string[] = [];
	function KeyLog() {
		useKeyboard(key => {
			keys.push(key.meta ? `meta+${key.name}` : key.name);
		});
		return React.createElement('text', null, 'keys');
	}

	const view = await terminalView(React.createElement(KeyLog), {typedAhead});
	t.teardown(async () => view.dispose());
	return {keys, stdin: view.stdin, renderer: view.renderer};
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

test.serial('a key typed right after an Escape keeps its meaning', async t => {
	const {keys, stdin} = await keyLog(t);
	stdin.write(ESCAPE);
	stdin.write('/');
	await delay(PARSER_WAIT_MS * 3);
	stdin.write(ESCAPE);
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	t.deepEqual(keys, ['escape', '/', 'escape', 'up']);
});

test.serial('two Escapes in quick succession are two keys', async t => {
	const {keys, stdin} = await keyLog(t);
	stdin.write(ESCAPE);
	stdin.write(ESCAPE);
	await delay(PARSER_WAIT_MS * 3);
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	t.deepEqual(keys, ['escape', 'escape', 'up']);
});

test.serial(
	'an Escape at the end of other input is still delivered',
	async t => {
		const {keys, stdin} = await keyLog(t);
		stdin.write(`a${ESCAPE}`);
		await delay(PARSER_WAIT_MS * 3);
		t.deepEqual(keys, ['a', 'escape']);
	},
);

test.serial(
	'a focus report right after an Escape is not read as a key',
	async t => {
		const {keys, stdin} = await keyLog(t);
		const logged: unknown[][] = [];
		const logError = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		t.teardown(() => {
			console.error = logError;
		});
		stdin.write(ESCAPE);
		stdin.write(`${ESCAPE}[O`);
		await delay(PARSER_WAIT_MS * 3);
		stdin.write('a');
		await delay(PARSER_WAIT_MS * 3);
		t.deepEqual(keys, ['escape', 'a']);
		t.deepEqual(logged, []);
	},
);

test.serial('keys typed before the app has mounted are delivered', async t => {
	const {keys} = await keyLog(t, 'jk');
	t.deepEqual(keys, ['j', 'k']);
});

test.serial(
	'Alt with a character that opens a sequence does not take the next key',
	async t => {
		const {keys, stdin} = await keyLog(t);
		stdin.write(`${ESCAPE}[`);
		stdin.write('A');
		stdin.write(`${ESCAPE}P`);
		stdin.write('b');
		await delay(PARSER_WAIT_MS * 3);
		t.deepEqual(
			keys.filter(key => !key.startsWith('meta+')),
			['a', 'b'],
		);
	},
);

test.serial(
	'a read the parser would hold or split goes to the program whole',
	async t => {
		const {stdin, renderer} = await keyLog(t);
		const delivered: string[] = [];
		deliverHeldKeysAtOnce(renderer, stdin, bytes => delivered.push(bytes));
		for (const bytes of [
			ESCAPE,
			`${ESCAPE}P`,
			`${ESCAPE}é`,
			`${ESCAPE}[A`,
			'a',
		]) {
			stdin.write(bytes);
			// eslint-disable-next-line no-await-in-loop
			await nextTurn();
		}

		t.deepEqual(delivered, [ESCAPE, `${ESCAPE}P`, `${ESCAPE}é`]);
	},
);
