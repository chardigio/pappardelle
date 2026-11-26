import {Buffer} from 'node:buffer';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {until} from '../test/helpers/wait.ts';
import {EmbeddedTerminalRenderable, type TerminalColors} from '@opentui/core';
import {createTestRenderer, ManualClock} from '@opentui/core/testing';
import {
	type ColorSource,
	followTerminalColors,
	paletteSequences,
	queryPalette,
	rendererColorSource,
} from './pane-frame-palette.ts';

const SOLARIZED_CYAN = '#2aa198';
const SOLARIZED_FOREGROUND = '#839496';

function colors(): TerminalColors {
	const palette: Array<string | null> = Array.from({length: 16}, () => null);
	palette[6] = SOLARIZED_CYAN;
	return {
		palette,
		defaultForeground: SOLARIZED_FOREGROUND,
		defaultBackground: '#002b36',
	} as unknown as TerminalColors;
}

const hex = ({r, g, b}: {r: number; g: number; b: number}) =>
	'#' +
	[r, g, b]
		.map(channel =>
			Math.round(channel * 255)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('');

test('an embedded terminal paints palette and default colors from the outer terminal', async () => {
	const setup = await createTestRenderer({width: 20, height: 2});
	teardown(async () => setup.dispose());
	const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
		width: 20,
		height: 2,
	});
	setup.renderer.root.add(terminal);

	terminal.write(paletteSequences(colors()));
	terminal.write('\u001B[36mcyan\u001B[0m plain');
	await setup.renderOnce();

	const {spans} = setup.captureSpans().lines[0]!;
	const cyan = spans.find(span => span.text.startsWith('cyan'))!;
	const plain = spans.find(span => span.text.includes('plain'))!;
	expect(hex(cyan.fg)).toBe(SOLARIZED_CYAN);
	expect(hex(plain.fg)).toBe(SOLARIZED_FOREGROUND);
});

const RESET_DEFAULTS = '\u001B]110\u001B\\\u001B]111\u001B\\';
const RESET_PALETTE = '\u001B]104\u001B\\';

function defaults(
	defaultForeground: string | null,
	defaultBackground: string | null,
): TerminalColors {
	return {
		...colors(),
		defaultForeground,
		defaultBackground,
	} as unknown as TerminalColors;
}

test('a black-on-black refresh after a switch to light mode leaves the text legible', async () => {
	const setup = await createTestRenderer({width: 20, height: 2});
	teardown(async () => setup.dispose());
	const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
		width: 20,
		height: 2,
	});
	setup.renderer.root.add(terminal);

	terminal.write(paletteSequences(colors()));
	// What tmux reported to the frame once macOS switched to light mode
	// while Ghostty, with no theme, stayed dark.
	terminal.write(paletteSequences(defaults('#000000', '#000000')));
	terminal.write('\u001B[36mcyan\u001B[0m plain');
	await setup.renderOnce();

	const {spans} = setup.captureSpans().lines[0]!;
	const cyan = spans.find(span => span.text.startsWith('cyan'))!;
	const plain = spans.find(span => span.text.includes('plain'))!;
	expect(hex(cyan.fg)).toBe(SOLARIZED_CYAN);
	expect(hex(plain.fg)).toBe('#ffffff');
	expect(hex(plain.bg)).toBe('#000000');
});

test('default colors too close to read are reset, not copied', () => {
	const sequences = paletteSequences(defaults('#1a1a1a', '#000000'));
	expect(sequences.endsWith(RESET_DEFAULTS)).toBe(true);
	expect(sequences.includes('\u001B]10;')).toBe(false);
	expect(sequences.includes('\u001B]11;')).toBe(false);
});

test('a foreground too dark for the built-in background is reset', () => {
	expect(
		paletteSequences(defaults('#000000', null)).endsWith(RESET_DEFAULTS),
	).toBe(true);
	expect(
		paletteSequences(defaults(null, '#ffffff')).endsWith(RESET_DEFAULTS),
	).toBe(true);
});

test('a real light theme still copies its dark-on-light defaults', () => {
	const sequences = paletteSequences(defaults('#000000', '#ffffff'));
	expect(sequences.includes('\u001B]10;rgb:00/00/00\u001B\\')).toBe(true);
	expect(sequences.includes('\u001B]11;rgb:ff/ff/ff\u001B\\')).toBe(true);
});

test('an unreported default color resets the stale one in the embedded terminal', () => {
	const sequences = paletteSequences(defaults('#839496', null));
	expect(sequences.includes('\u001B]10;rgb:83/94/96\u001B\\')).toBe(true);
	expect(sequences.endsWith('\u001B]111\u001B\\')).toBe(true);
	expect(
		paletteSequences(defaults(null, '#002b36')).includes('\u001B]110\u001B\\'),
	).toBe(true);
});

function fakeTerminal() {
	let osc = (_sequence: string) => {};
	let handlers: Array<(sequence: string) => boolean> = [];
	const written: string[] = [];
	const themeListeners: Array<() => void> = [];
	const terminal: ColorSource = {
		themeMode: 'dark',
		on(_event, listener) {
			themeListeners.push(listener);
		},
		write(sequence) {
			written.push(sequence);
		},
		subscribeOsc(handler) {
			osc = handler;
			return () => {
				osc = () => {};
			};
		},
		prependInputHandler(handler) {
			handlers.unshift(handler);
		},
		removeInputHandler(handler) {
			handlers = handlers.filter(candidate => candidate !== handler);
		},
	};
	return {
		terminal,
		written,
		color(sequence: string) {
			osc(sequence);
		},
		input: (sequence: string) => handlers.some(handler => handler(sequence)),
		flipTheme() {
			for (const listener of themeListeners) listener();
		},
	};
}

test('the status reply ends a palette query with the colors reported before it', async () => {
	const fake = fakeTerminal();
	const query = queryPalette(fake.terminal, 60_000);
	expect(fake.written[0]!.endsWith('\u001B[5n')).toBe(true);
	fake.color('\u001B]4;6;rgb:2a2a/a1a1/9898\u001B\\');
	fake.color('\u001B]4;1;rgb:dc/32/2f\u0007');
	fake.color('\u001B]10;rgb:8383/9494/9696\u001B\\');
	expect(fake.input('\u001B[A')).toBe(false);
	expect(fake.input('\u001B[0n')).toBe(true);
	const {colors, timedOut} = await query;
	expect(timedOut).toBe(false);
	expect(colors.palette[6]).toBe(SOLARIZED_CYAN);
	expect(colors.palette[1]).toBe('#dc322f');
	expect(colors.palette[0]).toBe(null);
	expect(colors.defaultForeground).toBe(SOLARIZED_FOREGROUND);
	expect(colors.defaultBackground).toBe(null);
	expect(fake.input('\u001B[0n')).toBe(false);
});

test('a terminal that reports no colors still ends the query at once', async () => {
	const fake = fakeTerminal();
	const query = queryPalette(fake.terminal, 60_000);
	fake.input('\u001B[0n');
	const {colors} = await query;
	expect(colors.palette.every(color => color === null)).toBe(true);
	expect(paletteSequences(colors)).toBe(RESET_PALETTE + RESET_DEFAULTS);
});

test('a palette query without a status reply gives up with what arrived', async () => {
	const fake = fakeTerminal();
	const clock = new ManualClock();
	const query = queryPalette(fake.terminal, 1000, clock);
	fake.color('\u001B]11;rgb:0000/2b2b/3636\u0007');
	clock.advance(1000);
	const {colors, timedOut} = await query;
	expect(timedOut).toBe(true);
	expect(colors.defaultBackground).toBe('#002b36');
	fake.color('\u001B]10;rgb:ffff/ffff/ffff\u0007');
	expect(colors.defaultForeground).toBe(null);
});

const DARK = [
	'\u001B]10;rgb:8383/9494/9696\u001B\\',
	'\u001B]11;rgb:0000/2b2b/3636\u001B\\',
];
const LIGHT = [
	'\u001B]10;rgb:2020/2020/2020\u001B\\',
	'\u001B]11;rgb:fafa/fafa/fafa\u001B\\',
];
const DARK_REPLY = DARK.join('');
const LIGHT_REPLY = LIGHT.join('');
const STATUS = '\u001B[0n';

// tmux 3.8 forwards an OSC 4 query to its client and queues every reply after
// it until the client answers or the request expires.
function tmuxWithSilentClient(fake: ReturnType<typeof fakeTerminal>) {
	for (const query of fake.written.join('').split('\u0007')) {
		if (query.startsWith('\u001B]4;')) return;
		if (query === '\u001B]10;?')
			fake.color('\u001B]10;rgb:8383/9494/9696\u001B\\');
		if (query === '\u001B]11;?')
			fake.color('\u001B]11;rgb:0000/2b2b/3636\u001B\\');
	}
}

test('a client that never answers palette queries still yields the default colors', async () => {
	const fake = fakeTerminal();
	const clock = new ManualClock();
	const query = queryPalette(fake.terminal, 1000, clock);
	tmuxWithSilentClient(fake);
	clock.advance(1000);
	const {colors} = await query;
	expect(colors.defaultForeground).toBe(SOLARIZED_FOREGROUND);
	expect(colors.defaultBackground).toBe('#002b36');
});

test('a palette entry the terminal stops reporting goes back to the built-in color', async () => {
	const setup = await createTestRenderer({width: 20, height: 2});
	teardown(async () => setup.dispose());
	const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
		width: 20,
		height: 2,
	});
	setup.renderer.root.add(terminal);

	terminal.write(paletteSequences(colors()));
	terminal.write(paletteSequences(defaults(SOLARIZED_FOREGROUND, '#002b36')));
	terminal.write('\u001B[36mcyan\u001B[0m');
	await setup.renderOnce();
	const before = hex(setup.captureSpans().lines[0]!.spans[0]!.fg);

	terminal.write(
		paletteSequences({
			...defaults(SOLARIZED_FOREGROUND, '#002b36'),
			palette: Array.from({length: 16}, () => null),
		}),
	);
	terminal.invalidate();
	await setup.renderOnce();
	const after = hex(setup.captureSpans().lines[0]!.spans[0]!.fg);

	expect(before).toBe(SOLARIZED_CYAN);
	expect(after).not.toBe(SOLARIZED_CYAN);
});

async function rendererSource() {
	const setup = await createTestRenderer({width: 20, height: 2});
	const written: string[] = [];
	const source = rendererColorSource(setup.renderer, sequence => {
		written.push(sequence);
	});
	const reply = (sequence: string) => {
		(setup.renderer as unknown as {stdin: NodeJS.EventEmitter}).stdin.emit(
			'data',
			Buffer.from(sequence, 'latin1'),
		);
	};

	return {setup, written, source, reply};
}

test('the startup color reply does not count as a theme switch', async () => {
	const {setup, written, source, reply} = await rendererSource();
	teardown(async () => setup.dispose());
	const applied: string[] = [];

	const following = followTerminalColors(
		source,
		(_report, reason) => applied.push(reason),
		1000,
	);
	reply(DARK_REPLY + STATUS);
	await following;
	await new Promise(resolve => {
		setTimeout(resolve, 50);
	});

	expect(written.length).toBe(1);
	expect(applied).toStrictEqual(['start']);
});

test('text already on screen repaints in the colors of a dark-to-light switch', async () => {
	const {setup, written, source, reply} = await rendererSource();
	teardown(async () => setup.dispose());
	const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
		width: 20,
		height: 2,
	});
	setup.renderer.root.add(terminal);
	let applies = 0;
	const following = followTerminalColors(
		source,
		({colors}) => {
			applies++;
			terminal.write(paletteSequences(colors));
			terminal.invalidate();
		},
		1000,
	);
	reply(DARK_REPLY + STATUS);
	await following;
	terminal.write('\u001B[2;3mthinking\u001B[0m');

	// The renderer learns of a switch from its own color query's answer; the
	// test renderer can't send that query, so the answer comes unasked.
	reply(DARK_REPLY);
	reply(LIGHT_REPLY);
	await until(() => written.length === 2, {what: 'the second color query'});
	reply(LIGHT_REPLY + STATUS);
	await until(() => applies === 2, {what: 'the light palette to apply'});
	await setup.renderOnce();

	const thinking = setup.captureSpans().lines[0]!.spans[0]!;
	expect(thinking.text.trim()).toBe('thinking');
	expect(hex(thinking.fg)).toBe('#202020');
	expect(hex(thinking.bg)).toBe('#fafafa');
});

async function settle() {
	await new Promise(resolve => {
		setImmediate(resolve);
	});
}

test('a theme switch during a query waits for it, then queries again', async () => {
	const fake = fakeTerminal();
	const applied: Array<string | null> = [];
	const following = followTerminalColors(
		fake.terminal,
		({colors}) => applied.push(colors.defaultBackground),
		60_000,
	);
	for (const sequence of DARK) fake.color(sequence);
	fake.input(STATUS);
	await following;

	fake.flipTheme();
	fake.flipTheme();
	expect(fake.written.length).toBe(2);
	// Answered before the terminal had finished switching.
	for (const sequence of DARK) fake.color(sequence);
	fake.input(STATUS);
	await settle();
	expect(fake.written.length).toBe(3);
	for (const sequence of LIGHT) fake.color(sequence);
	fake.input(STATUS);
	await settle();

	expect(applied).toStrictEqual(['#002b36', '#002b36', '#fafafa']);
});

test('a theme switch during the startup query queries again after it', async () => {
	const fake = fakeTerminal();
	const applied: Array<[string, string | null]> = [];
	const following = followTerminalColors(
		fake.terminal,
		({colors}, reason) => applied.push([reason, colors.defaultBackground]),
		60_000,
	);
	fake.flipTheme();
	for (const sequence of DARK) fake.color(sequence);
	fake.input(STATUS);
	await following;
	await settle();
	expect(fake.written.length).toBe(2);
	for (const sequence of LIGHT) fake.color(sequence);
	fake.input(STATUS);
	await settle();

	expect(applied).toStrictEqual([
		['start', '#002b36'],
		['theme', '#fafafa'],
	]);
});

test('a query that times out keeps the colors it missed', async () => {
	const fake = fakeTerminal();
	const clock = new ManualClock();
	const applied: Array<[string | null, string | null, boolean]> = [];
	const following = followTerminalColors(
		fake.terminal,
		({colors, timedOut}) =>
			applied.push([
				colors.palette[6] ?? null,
				colors.defaultBackground,
				timedOut,
			]),
		1000,
		clock,
	);
	fake.color('\u001B]4;6;rgb:2a2a/a1a1/9898\u001B\\');
	for (const sequence of DARK) fake.color(sequence);
	fake.input(STATUS);
	await following;

	fake.flipTheme();
	fake.color(LIGHT[1]!);
	clock.advance(1000);
	await settle();

	expect(applied).toStrictEqual([
		[SOLARIZED_CYAN, '#002b36', false],
		[SOLARIZED_CYAN, '#fafafa', true],
	]);
});
