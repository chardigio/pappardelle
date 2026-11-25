import {test, expect} from 'bun:test';
import {OscScanner, type OutputPiece} from './pane-frame-osc.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

test('a window title ending in BEL or ST names the frame', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('\u001B]2;agent · STE-59\u0007')).title).toBe(
		'agent · STE-59',
	);
	expect(scanner.feed(bytes('x\u001B]0;companion\u001B\\y')).title).toBe(
		'companion',
	);
});

test('a sequence split across reads is still recognized', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('\u001B')).title).toBe(undefined);
	expect(scanner.feed(bytes(']2;age')).title).toBe(undefined);
	expect(scanner.feed(bytes('nt\u001B')).title).toBe(undefined);
	expect(scanner.feed(bytes('\\')).title).toBe('agent');
});

test('the last title in a read wins', () => {
	const scanner = new OscScanner();
	expect(
		scanner.feed(bytes('\u001B]2;first\u0007\u001B]2;second\u0007')).title,
	).toBe('second');
});

test('a clipboard write passes through to the outer terminal', () => {
	const scanner = new OscScanner();
	const events = scanner.feed(bytes('text\u001B]52;c;aGVsbG8=\u001B\\more'));
	expect(events.passthrough).toStrictEqual(['\u001B]52;c;aGVsbG8=\u0007']);
	expect(events.title).toBe(undefined);
});

test('other sequences and plain escapes are ignored', () => {
	const scanner = new OscScanner();
	const events = scanner.feed(
		bytes(
			'\u001B[1;31mred\u001B[0m\u001B]8;;https://x\u001B\\link\u001B]1;icon\u0007',
		),
	);
	expect(events.passthrough).toStrictEqual([]);
	expect(events.sizeQueries).toStrictEqual([]);
});

test('an unterminated title abandoned by a new escape is dropped', () => {
	const scanner = new OscScanner();
	expect(
		scanner.feed(bytes('\u001B]2;broken\u001B[0m\u001B]2;ok\u0007')).title,
	).toBe('ok');
});

test('window size queries are picked out, even split across reads', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('\u001B[18t\u001B[1')).sizeQueries).toStrictEqual([
		'cells',
	]);
	expect(scanner.feed(bytes('4t')).sizeQueries).toStrictEqual(['pixels']);
});

test('other window operations and CSI sequences are not size queries', () => {
	const scanner = new OscScanner();
	const events = scanner.feed(
		bytes('\u001B[22;0t\u001B[8;24;80t\u001B[?2026$p\u001B[18m'),
	);
	expect(events.sizeQueries).toStrictEqual([]);
});

test('a bell passes through to the real terminal', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('done\u0007')).passthrough).toStrictEqual([
		'\u0007',
	]);
});

test('a BEL that ends a title is not a bell', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('\u001B]2;agent\u0007')).passthrough).toStrictEqual(
		[],
	);
});

test('the keypad mode passes through, even split across reads', () => {
	const scanner = new OscScanner();
	expect(scanner.feed(bytes('a\u001B=b\u001B')).passthrough).toStrictEqual([
		'\u001B=',
	]);
	expect(scanner.feed(bytes('>c')).passthrough).toStrictEqual(['\u001B>']);
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

test('a Kitty graphics command is taken out of the screen, in its place', () => {
	const scanner = new OscScanner();
	const command = '\u001B_Ga=T,U=1,i=7,f=24,t=t;L3RtcA==\u001B\\';
	const events = scanner.feed(bytes(`a${command}b`));
	expect(events.output).toStrictEqual([
		{screen: bytes('a')},
		{graphics: command},
		{screen: bytes('b')},
	]);
	expect(events.passthrough).toStrictEqual([]);
});

test('a Kitty graphics command split across reads comes out whole', () => {
	const scanner = new OscScanner();
	const reads = ['x\u001B', '_', 'Ga=d,d=I,i=7', ',q=2\u001B', '\\y'].map(
		read => scanner.feed(bytes(read)),
	);
	expect(reads.map(events => shown(events.output)).join('')).toBe(
		'x<a=d,d=I,i=7,q=2>y',
	);
	expect(
		reads.flatMap(events =>
			events.output.flatMap(piece =>
				'graphics' in piece ? [piece.graphics] : [],
			),
		),
	).toStrictEqual(['\u001B_Ga=d,d=I,i=7,q=2\u001B\\']);
});

test('an escape held at the end of a read reaches the screen with the next', () => {
	const scanner = new OscScanner();
	expect(shown(scanner.feed(bytes('a\u001B')).output)).toBe('a');
	expect(shown(scanner.feed(bytes('[1mb')).output)).toBe('\u001B[1mb');
});

test('other APC strings stay on the screen', () => {
	const scanner = new OscScanner();
	const events = scanner.feed(bytes('\u001B_ladybird;reload\u001B\\'));
	expect(events.passthrough).toStrictEqual([]);
	expect(shown(events.output)).toBe('\u001B_ladybird;reload\u001B\\');
});

test('Unicode placeholder cells reach the screen untouched', () => {
	const scanner = new OscScanner();
	const cells = '\u001B[38;2;0;1;77m\u{10EEEE}\u0305\u0305\u{10EEEE}\u001B[39m';
	expect(shown(scanner.feed(bytes(cells)).output)).toBe(cells);
});
