import {
	mix,
	terminalBackground,
	terminalForeground,
	type Look,
	type Token,
} from '../../kit/color.ts';

export const tokens = {
	pill: {
		ansi: 'magenta',
		truecolor: {dark: '#b4a0ff', light: '#6a4fd6', solarized: '#6c71c4'},
	} satisfies Token,
	live: {
		ansi: 'cyan',
		truecolor: {dark: '#5fd7c8', light: '#0f8a7e', solarized: '#2aa198'},
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
	error: {
		ansi: 'red',
		truecolor: {dark: '#ff6b6b', light: '#c62828', solarized: '#dc322f'},
	} satisfies Token,
	warn: {
		ansi: 'yellow',
		truecolor: {dark: '#e5c07b', light: '#9a6500', solarized: '#b58900'},
	} satisfies Token,
	onAccent: {
		ansi: 'black',
		truecolor: {dark: '#16181d', light: '#ffffff', solarized: '#002b36'},
	} satisfies Token,
};

export function surfaces(look: Look) {
	const bg = terminalBackground(look.theme);
	const fg = terminalForeground(look.theme);
	const solarized = look.theme === 'solarized';
	return {
		bg,
		fg,
		muted: mix(fg, bg, solarized ? 0.32 : 0.45),
		faint: mix(fg, bg, solarized ? 0.55 : 0.7),
		/** The brightest the shimmer band reaches. */
		glint:
			look.theme === 'light' ? '#000000' : solarized ? '#fdf6e3' : '#ffffff',
		wash: (accent: string, amount: number) => mix(bg, accent, amount),
	};
}
