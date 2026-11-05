import test from 'ava';
import {OscScanner} from './pane-frame-osc.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

test('a window title ending in BEL or ST names the frame', t => {
	const scanner = new OscScanner();
	t.is(
		scanner.feed(bytes('\u001B]2;agent · STE-59\u0007')).title,
		'agent · STE-59',
	);
	t.is(scanner.feed(bytes('x\u001B]0;companion\u001B\\y')).title, 'companion');
});

test('a sequence split across reads is still recognized', t => {
	const scanner = new OscScanner();
	t.is(scanner.feed(bytes('\u001B')).title, undefined);
	t.is(scanner.feed(bytes(']2;age')).title, undefined);
	t.is(scanner.feed(bytes('nt\u001B')).title, undefined);
	t.is(scanner.feed(bytes('\\')).title, 'agent');
});

test('the last title in a read wins', t => {
	const scanner = new OscScanner();
	t.is(
		scanner.feed(bytes('\u001B]2;first\u0007\u001B]2;second\u0007')).title,
		'second',
	);
});

test('a clipboard write passes through to the outer terminal', t => {
	const scanner = new OscScanner();
	const events = scanner.feed(bytes('text\u001B]52;c;aGVsbG8=\u001B\\more'));
	t.deepEqual(events.passthrough, ['\u001B]52;c;aGVsbG8=\u0007']);
	t.is(events.title, undefined);
});

test('other sequences and plain escapes are ignored', t => {
	const scanner = new OscScanner();
	const events = scanner.feed(
		bytes(
			'\u001B[1;31mred\u001B[0m\u001B]8;;https://x\u001B\\link\u001B]1;icon\u0007',
		),
	);
	t.deepEqual(events, {passthrough: []});
});

test('an unterminated title abandoned by a new escape is dropped', t => {
	const scanner = new OscScanner();
	t.is(
		scanner.feed(bytes('\u001B]2;broken\u001B[0m\u001B]2;ok\u0007')).title,
		'ok',
	);
});
