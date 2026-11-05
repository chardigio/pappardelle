/**
 * Reference terminal palettes for displaying 16-color frames in the browser.
 * They stand in for "a typical dark/light terminal theme"; a user's own
 * palette will differ, which is the point of designing to palette slots.
 */
export type Palette = {
	name: string;
	background: string;
	foreground: string;
	ansi: string[];
};

export const darkPalette: Palette = {
	name: 'dark',
	background: '#16181d',
	foreground: '#d7dae0',
	ansi: [
		'#1f2228',
		'#e06c75',
		'#98c379',
		'#e5c07b',
		'#61afef',
		'#c678dd',
		'#56b6c2',
		'#abb2bf',
		'#5c6370',
		'#f08a92',
		'#b1d98f',
		'#f0d08f',
		'#86c2f7',
		'#d69be8',
		'#7ccfd9',
		'#eef0f4',
	],
};

export const lightPalette: Palette = {
	name: 'light',
	background: '#fbfaf7',
	foreground: '#2a2c31',
	ansi: [
		'#2a2c31',
		'#c8323c',
		'#3a7f2c',
		'#9a6500',
		'#2a63c9',
		'#9b3cb0',
		'#167f8a',
		'#c9cbd0',
		'#8a8e97',
		'#d9434d',
		'#4b943a',
		'#b27a10',
		'#3f78dd',
		'#b052c4',
		'#22939e',
		'#f4f4f1',
	],
};

/**
 * Solarized Dark as terminals ship it. Its bright slots are the base tones,
 * not brighter hues: slot 8 is the background itself and 10-14 are greys,
 * so anything styled `gray` or `*Bright` needs checking here.
 */
export const solarizedDarkPalette: Palette = {
	name: 'solarized-dark',
	background: '#002b36',
	foreground: '#839496',
	ansi: [
		'#073642',
		'#dc322f',
		'#859900',
		'#b58900',
		'#268bd2',
		'#d33682',
		'#2aa198',
		'#eee8d5',
		'#002b36',
		'#cb4b16',
		'#586e75',
		'#657b83',
		'#839496',
		'#6c71c4',
		'#93a1a1',
		'#fdf6e3',
	],
};

/** Ghostty with no theme configured (src/config/Config.zig, terminal/color.zig). */
export const ghosttyDefaultPalette: Palette = {
	name: 'ghostty-default',
	background: '#282c34',
	foreground: '#ffffff',
	ansi: [
		'#1d1f21',
		'#cc6666',
		'#b5bd68',
		'#f0c674',
		'#81a2be',
		'#b294bb',
		'#8abeb7',
		'#c5c8c6',
		'#666666',
		'#d54e53',
		'#b9ca4a',
		'#e7c547',
		'#7aa6da',
		'#c397d8',
		'#70c0b1',
		'#eaeaea',
	],
};

export const palettes = {
	dark: darkPalette,
	light: lightPalette,
	solarized: solarizedDarkPalette,
	ghostty: ghosttyDefaultPalette,
} as const;

const cube = [0, 95, 135, 175, 215, 255];

/** Standard xterm colors for slots 16-255. */
export function xtermIndexColor(index: number): string {
	const toHex = (value: number) => value.toString(16).padStart(2, '0');
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return `#${toHex(level)}${toHex(level)}${toHex(level)}`;
	}

	const offset = index - 16;
	const r = cube[Math.floor(offset / 36)]!;
	const g = cube[Math.floor(offset / 6) % 6]!;
	const b = cube[offset % 6]!;
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
