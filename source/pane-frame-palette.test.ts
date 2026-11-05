import test from 'ava';
import {EmbeddedTerminalRenderable, type TerminalColors} from '@opentui/core';
import {createTestRenderer} from '@opentui/core/testing';
import {paletteSequences} from './pane-frame-palette.ts';

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
