import {
	mix,
	terminalBackground,
	terminalForeground,
	type Look,
	type Token,
} from '../../kit/color.ts';

/**
 * One color system: agent state. Tracker workflow state moves to the detail
 * line of the selected row, so a row never carries two competing palettes.
 */
export const tokens = {
	text: {} satisfies Token,
	selection: {
		ansi: 'cyan',
		truecolor: {dark: '#79c0d8', light: '#1f7f96', solarized: '#2aa198'},
	} satisfies Token,
	question: {
		ansi: 'blue',
		truecolor: {dark: '#7aa7ff', light: '#2f5bd3', solarized: '#268bd2'},
	} satisfies Token,
	permission: {
		ansi: 'red',
		truecolor: {dark: '#ff7a85', light: '#c4314b', solarized: '#dc322f'},
	} satisfies Token,
	ok: {
		ansi: 'green',
		truecolor: {dark: '#8fd18a', light: '#2f7d32', solarized: '#859900'},
	} satisfies Token,
	warn: {
		ansi: 'yellow',
		truecolor: {dark: '#e5c07b', light: '#9a6500', solarized: '#b58900'},
	} satisfies Token,
	error: {
		ansi: 'red',
		truecolor: {dark: '#ff6b6b', light: '#c62828', solarized: '#dc322f'},
	} satisfies Token,
	/** Chip text on an accent background, readable on both themes. */
	onAccent: {
		ansi: 'black',
		truecolor: {dark: '#16181d', light: '#ffffff', solarized: '#002b36'},
	} satisfies Token,
};

/** Truecolor-only surfaces derived from the terminal's own colors. */
export function surfaces(look: Look) {
	const bg = terminalBackground(look.theme);
	const fg = terminalForeground(look.theme);
	// Solarized's own foreground already sits close to its background, so
	// muted text gives up less contrast there.
	const recede = look.theme === 'solarized' ? 0.32 : 0.45;
	return {
		muted: mix(fg, bg, recede),
		hairline: mix(fg, bg, look.theme === 'solarized' ? 0.6 : 0.72),
		selectedRow: mix(bg, fg, 0.075),
		accentWash(accent: string, amount: number) {
			return mix(bg, accent, amount);
		},
	};
}
