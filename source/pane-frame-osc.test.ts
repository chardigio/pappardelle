import test from 'ava';
import {OscScanner, type OutputPiece} from './pane-frame-osc.ts';

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
	t.deepEqual(events.passthrough, []);
	t.deepEqual(events.sizeQueries, []);
});

test('an unterminated title abandoned by a new escape is dropped', t => {
	const scanner = new OscScanner();
	t.is(
		scanner.feed(bytes('\u001B]2;broken\u001B[0m\u001B]2;ok\u0007')).title,
		'ok',
	);
});

test('window size queries are picked out, even split across reads', t => {
	const scanner = new OscScanner();
	t.deepEqual(scanner.feed(bytes('\u001B[18t\u001B[1')).sizeQueries, ['cells']);
	t.deepEqual(scanner.feed(bytes('4t')).sizeQueries, ['pixels']);
});

test('other window operations and CSI sequences are not size queries', t => {
	const scanner = new OscScanner();
	const events = scanner.feed(
		bytes('\u001B[22;0t\u001B[8;24;80t\u001B[?2026$p\u001B[18m'),
	);
	t.deepEqual(events.sizeQueries, []);
});

test('a bell passes through to the real terminal', t => {
	const scanner = new OscScanner();
	t.deepEqual(scanner.feed(bytes('done\u0007')).passthrough, ['\u0007']);
});

test('a BEL that ends a title is not a bell', t => {
	const scanner = new OscScanner();
	t.deepEqual(scanner.feed(bytes('\u001B]2;agent\u0007')).passthrough, []);
});

test('the keypad mode passes through, even split across reads', t => {
	const scanner = new OscScanner();
	t.deepEqual(scanner.feed(bytes('a\u001B=b\u001B')).passthrough, ['\u001B=']);
	t.deepEqual(scanner.feed(bytes('>c')).passthrough, ['\u001B>']);
});

const decoder = new TextDecoder();
// The output as text, with each graphics command shown as <keys>.
const shown = (output: OutputPiece[]) =>
	output
		.map(piece =>
			'screen' in piece
				? decoder.decode(piece.screen)
				: `<${piece.graphics.slice(3).split(';')[0]!.replace('\u001B\\', '')}>`,
		)
		.join('');

test('a Kitty graphics command is taken out of the screen, in its place', t => {
	const scanner = new OscScanner();
	const command = '\u001B_Ga=T,U=1,i=7,f=24,t=t;L3RtcA==\u001B\\';
	const events = scanner.feed(bytes(`a${command}b`));
	t.deepEqual(events.output, [
		{screen: bytes('a')},
		{graphics: command},
		{screen: bytes('b')},
	]);
	t.deepEqual(events.passthrough, []);
});

test('a Kitty graphics command split across reads comes out whole', t => {
	const scanner = new OscScanner();
	const reads = ['x\u001B', '_', 'Ga=d,d=I,i=7', ',q=2\u001B', '\\y'].map(
		read => scanner.feed(bytes(read)),
	);
	t.is(
		reads.map(events => shown(events.output)).join(''),
		'x<a=d,d=I,i=7,q=2>y',
	);
	t.deepEqual(
		reads.flatMap(events =>
			events.output.flatMap(piece =>
				'graphics' in piece ? [piece.graphics] : [],
			),
		),
		['\u001B_Ga=d,d=I,i=7,q=2\u001B\\'],
	);
});

test('an escape held at the end of a read reaches the screen with the next', t => {
	const scanner = new OscScanner();
	t.is(shown(scanner.feed(bytes('a\u001B')).output), 'a');
	t.is(shown(scanner.feed(bytes('[1mb')).output), '\u001B[1mb');
});

test('other APC strings stay on the screen', t => {
	const scanner = new OscScanner();
	const events = scanner.feed(bytes('\u001B_ladybird;reload\u001B\\'));
	t.deepEqual(events.passthrough, []);
	t.is(shown(events.output), '\u001B_ladybird;reload\u001B\\');
});

test('Unicode placeholder cells reach the screen untouched', t => {
	const scanner = new OscScanner();
	const cells = '\u001B[38;2;0;1;77m\u{10EEEE}\u0305\u0305\u{10EEEE}\u001B[39m';
	t.is(shown(scanner.feed(bytes(cells)).output), cells);
});
