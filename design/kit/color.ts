import {RGBA, type ColorInput} from '@opentui/core';
import {terminalColor} from '../../source/tui-style.ts';
import {palettes} from '../artifact/palettes.ts';

export type Tier = 'ansi' | 'truecolor';
/** Terminal themes the directions are checked against. Solarized Dark and
 * Ghostty's default are dark themes to OSC 11 detection; Solarized's palette
 * also needs its own accents. */
export type Theme = 'dark' | 'light' | 'solarized' | 'ghostty';
export type Look = {tier: Tier; theme: Theme};

export const TIERS: Tier[] = ['ansi', 'truecolor'];
export const THEMES: Theme[] = ['dark', 'light', 'solarized', 'ghostty'];

/**
 * A design token. The ANSI value is a palette name (or undefined for the
 * terminal's default foreground) and must read well on any theme. The
 * truecolor value is used only when the terminal reports truecolor, and is
 * picked per detected theme (OpenTUI `renderer.themeMode`, from OSC 11).
 */
export type Token = {
	ansi?: string;
	truecolor?: {dark: string; light: string; solarized?: string};
};

function truecolorOf(token: Token, theme: Theme): string | undefined {
	if (!token.truecolor) return undefined;
	if (theme === 'solarized')
		return token.truecolor.solarized ?? token.truecolor.dark;
	// Ghostty's default is a dark theme; its washes still derive from its own
	// background through terminalBackground.
	if (theme === 'ghostty') return token.truecolor.dark;
	return token.truecolor[theme];
}

export function paint(token: Token, look: Look): ColorInput {
	const hex =
		look.tier === 'truecolor' ? truecolorOf(token, look.theme) : undefined;
	return hex ? RGBA.fromHex(hex) : terminalColor(token.ansi);
}

/**
 * The terminal's own background. In the real app this comes from
 * `renderer.getPalette()`; previews use the artifact's reference palettes so
 * blends match what the page shows.
 */
export function terminalBackground(theme: Theme): string {
	return palettes[theme].background;
}

export function terminalForeground(theme: Theme): string {
	return palettes[theme].foreground;
}

function channels(hex: string): [number, number, number] {
	return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [
		number,
		number,
		number,
	];
}

/** Linear blend of two hex colors; amount 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, amount: number): string {
	const [ar, ag, ab] = channels(a);
	const [br, bg, bb] = channels(b);
	const lerp = (x: number, y: number) =>
		Math.round(x + (y - x) * Math.min(1, Math.max(0, amount)))
			.toString(16)
			.padStart(2, '0');
	return `#${lerp(ar, br)}${lerp(ag, bg)}${lerp(ab, bb)}`;
}

/** An accent laid over the terminal background, for tinted rows and fills. */
export function tint(accent: string, amount: number, theme: Theme): string {
	return mix(terminalBackground(theme), accent, amount);
}

/** Truecolor hex for a token, or the ANSI palette value approximated. */
export function hexOf(token: Token, theme: Theme): string {
	const hex = truecolorOf(token, theme);
	if (hex) return hex;
	const palette = palettes[theme];
	const slot = ANSI_SLOTS[token.ansi ?? ''];
	return slot === undefined ? palette.foreground : palette.ansi[slot]!;
}

const ANSI_SLOTS: Record<string, number> = {
	black: 0,
	red: 1,
	green: 2,
	yellow: 3,
	blue: 4,
	magenta: 5,
	cyan: 6,
	white: 7,
	gray: 8,
	grey: 8,
	blackBright: 8,
	redBright: 9,
	greenBright: 10,
	yellowBright: 11,
	blueBright: 12,
	magentaBright: 13,
	cyanBright: 14,
	whiteBright: 15,
};

function luminance(hex: string) {
	const [r, g, b] = channels(hex).map(value => {
		const c = value / 255;
		return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors. */
export function contrast(a: string, b: string) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#[\da-f]{6}$/i;
const CHROMATIC = new Set([
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
]);
const HUE_SLOTS: Array<[number, string]> = [
	[0, 'red'],
	[60, 'yellow'],
	[120, 'green'],
	[180, 'cyan'],
	[240, 'blue'],
	[300, 'magenta'],
	[360, 'red'],
];

function nearestAnsi(hex: string): string | undefined {
	const [r, g, b] = channels(hex).map(value => value / 255) as [
		number,
		number,
		number,
	];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	// Grays have no hue to match, and ANSI gray and white are the slots that
	// vanish on some themes, so they fall back to the default foreground.
	if (max - min < 0.2) return undefined;
	let hue = 0;
	if (max === r) hue = 60 * (((g - b) / (max - min) + 6) % 6);
	else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
	else hue = 60 * ((r - g) / (max - min) + 4);
	let best = HUE_SLOTS[0]!;
	for (const slot of HUE_SLOTS)
		if (Math.abs(slot[0] - hue) < Math.abs(best[0] - hue)) best = slot;
	return best[1];
}

/**
 * A tracker's workflow color made safe to draw text in. Linear and Jira send
 * hex; beads sends ANSI names. 16 colors gets the nearest chromatic palette
 * slot; truecolor gets the hue pulled toward the foreground until it reads at
 * 4.5:1 on `background`. Undefined means the default foreground.
 */
export function trackerColor(
	color: string,
	look: Look,
	background = terminalBackground(look.theme),
): string | undefined {
	const name = HEX.test(color)
		? nearestAnsi(color)
		: CHROMATIC.has(color.replace(/Bright$/, ''))
			? color.replace(/Bright$/, '')
			: undefined;
	if (look.tier === 'ansi') return name;
	const hex = HEX.test(color)
		? color
		: name && palettes[look.theme].ansi[ANSI_SLOTS[name]!];
	if (!hex) return undefined;
	const fg = terminalForeground(look.theme);
	for (let amount = 0; amount <= 1; amount += 0.05) {
		const candidate = mix(hex, fg, amount);
		if (contrast(candidate, background) >= 4.5) return candidate;
	}

	return fg;
}

/**
 * Colors for a filled chip (a count badge, a keycap, a pulse). Truecolor
 * fills with the accent. 16 colors swaps the terminal's own foreground and
 * background instead, since no ANSI text color reads on every palette's
 * accents (black on blue is 2.5:1 on common light themes).
 */
export function chip(
	bg: ColorInput,
	fg: ColorInput,
	look: Look,
): {bg?: ColorInput; fg?: ColorInput; inverse?: boolean} {
	// Inverse over a colored foreground hits the PR !58 bug (OpenTUI draws the
	// cell fg-on-fg), so the chip clears both colors.
	return look.tier === 'truecolor'
		? {bg, fg}
		: {inverse: true, fg: undefined, bg: undefined};
}
