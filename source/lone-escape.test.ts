import {
	setImmediate as nextTurn,
	setTimeout as delay,
} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import React from 'react';
import {useKeyboard} from '@opentui/react';
import {terminalView} from '../test/helpers/terminal-view.ts';

// RenderTui delivers a lone Escape early only in a tmux pane. Nothing here
// runs tmux, so the socket does not have to exist.
process.env['TMUX'] = '/nonexistent/tmux-socket,0,0';

const ESCAPE = '\u001B';
const PARSER_WAIT_MS = 20;

async function keyLog(typedAhead = '', ready?: Promise<void>) {
	const keys: string[] = [];
	function KeyLog() {
		useKeyboard(key => {
			keys.push(key.meta ? `meta+${key.name}` : key.name);
		});
		return React.createElement('text', null, 'keys');
	}

	const view = await terminalView(React.createElement(KeyLog), {
		typedAhead,
		ready,
	});
	teardown(async () => view.dispose());
	return {keys, stdin: view.stdin};
}

test('a lone Escape is delivered on arrival, and only once', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(ESCAPE);
	await nextTurn();
	expect(keys).toStrictEqual(['escape']);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['escape']);
});

test('an escape sequence is left to the parser', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['up']);
});

test('a key typed right after an Escape keeps its meaning', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(ESCAPE);
	stdin.write('/');
	await delay(PARSER_WAIT_MS * 3);
	stdin.write(ESCAPE);
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['escape', '/', 'escape', 'up']);
});

test('two Escapes in quick succession are two keys', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(ESCAPE);
	stdin.write(ESCAPE);
	await delay(PARSER_WAIT_MS * 3);
	stdin.write(`${ESCAPE}[A`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['escape', 'escape', 'up']);
});

test('an Escape at the end of other input is still delivered', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(`a${ESCAPE}`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['a', 'escape']);
});

test('a focus report right after an Escape is not read as a key', async () => {
	const {keys, stdin} = await keyLog();
	const logged: unknown[][] = [];
	const logError = console.error;
	console.error = (...args: unknown[]) => logged.push(args);
	teardown(() => {
		console.error = logError;
	});
	stdin.write(ESCAPE);
	stdin.write(`${ESCAPE}[O`);
	await delay(PARSER_WAIT_MS * 3);
	stdin.write('a');
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['escape', 'a']);
	expect(logged).toStrictEqual([]);
});

test('keys typed before the app has mounted are delivered', async () => {
	const {keys} = await keyLog('jk');
	expect(keys).toStrictEqual(['j', 'k']);
});

test('Alt with a character outside ASCII typed before the renderer reads is not a control key', async () => {
	const {keys} = await keyLog(`j${ESCAPE}ăk${ESCAPE}č`);
	expect(keys).toStrictEqual(['j', 'k']);
});

test('an Escape typed while start-up keys are held keeps its place', async () => {
	const ready = Promise.withResolvers<void>();
	const {keys, stdin} = await keyLog('', ready.promise);
	for (const read of ['a', ESCAPE, 'b']) {
		stdin.write(read);
		await nextTurn();
	}

	expect(keys).toStrictEqual([]);
	ready.resolve();
	await nextTurn();
	expect(keys).toStrictEqual(['a', 'escape', 'b']);
});

test('Enter typed before the terminal is raw is still Enter', async () => {
	const {keys} = await keyLog('j\n');
	expect(keys).toStrictEqual(['j', 'return']);
});

test('Alt with a character that opens a sequence does not take the next key', async () => {
	const {keys, stdin} = await keyLog();
	stdin.write(`${ESCAPE}[`);
	stdin.write('A');
	stdin.write(`${ESCAPE}P`);
	stdin.write('b');
	await delay(PARSER_WAIT_MS * 3);
	expect(keys.filter(key => !key.startsWith('meta+'))).toStrictEqual([
		'a',
		'b',
	]);
});

test('Alt with a character outside ASCII is not read as a control key', async () => {
	const {keys, stdin} = await keyLog();
	// Their UTF-8 ends in 0x83, 0x8d and 0x88, which an 8-bit terminal
	// would send for Alt with Ctrl+C, Enter and Backspace.
	for (const character of ['ă', 'č', 'Ĉ', '🍝'])
		stdin.write(`${ESCAPE}${character}`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual([]);
	// The same when a busy app reads it together with the keys around it.
	stdin.write(`a${ESCAPE}ăb${ESCAPE}č`);
	await delay(PARSER_WAIT_MS * 3);
	expect(keys).toStrictEqual(['a', 'b']);
});
