import test from 'ava';
import {EmbeddedTerminalRenderable, type TerminalColors} from '@opentui/core';
import {createTestRenderer} from '@opentui/core/testing';
import {
	paletteSequences,
	queryPalette,
	type PaletteTerminal,
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

test.serial(
	'an embedded terminal paints palette and default colors from the outer terminal',
	async t => {
		const setup = await createTestRenderer({width: 20, height: 2});
		t.teardown(async () => setup.dispose());
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
		t.is(hex(cyan.fg), SOLARIZED_CYAN);
		t.is(hex(plain.fg), SOLARIZED_FOREGROUND);
	},
);

function fakeTerminal() {
	let osc = (_sequence: string) => {};
	let handlers: Array<(sequence: string) => boolean> = [];
	const written: string[] = [];
	const terminal: PaletteTerminal = {
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
	};
}

test('the status reply ends a palette query with the colors reported before it', async t => {
	const fake = fakeTerminal();
	const query = queryPalette(fake.terminal, 60_000);
	t.true(fake.written[0]!.endsWith('\u001B]11;?\u0007\u001B[5n'));
	fake.color('\u001B]4;6;rgb:2a2a/a1a1/9898\u001B\\');
	fake.color('\u001B]4;1;rgb:dc/32/2f\u0007');
	fake.color('\u001B]10;rgb:8383/9494/9696\u001B\\');
	t.false(fake.input('\u001B[A'));
	t.true(fake.input('\u001B[0n'));
	const colors = await query;
	t.is(colors.palette[6], SOLARIZED_CYAN);
	t.is(colors.palette[1], '#dc322f');
	t.is(colors.palette[0], null);
	t.is(colors.defaultForeground, SOLARIZED_FOREGROUND);
	t.is(colors.defaultBackground, null);
	t.false(fake.input('\u001B[0n'));
});

test('a terminal that reports no colors still ends the query at once', async t => {
	const fake = fakeTerminal();
	const query = queryPalette(fake.terminal, 60_000);
	fake.input('\u001B[0n');
	const colors = await query;
	t.true(colors.palette.every(color => color === null));
	t.is(paletteSequences(colors), '');
});

test('a palette query without a status reply gives up with what arrived', async t => {
	const fake = fakeTerminal();
	const query = queryPalette(fake.terminal, 20);
	fake.color('\u001B]11;rgb:0000/2b2b/3636\u0007');
	const colors = await query;
	t.is(colors.defaultBackground, '#002b36');
	fake.color('\u001B]10;rgb:ffff/ffff/ffff\u0007');
	t.is(colors.defaultForeground, null);
});
