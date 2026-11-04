import {TextAttributes, RGBA} from '@opentui/core';

/** Keep conditional styles readable while using OpenTUI's native text attributes. */
export function textAttributes(style: {
	bold?: boolean;
	dim?: boolean;
	inverse?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}): number {
	// OpenTUI represents text attributes as a bit field.
	/* eslint-disable no-bitwise */
	return (
		(style.bold ? TextAttributes.BOLD : 0) |
		(style.dim ? TextAttributes.DIM : 0) |
		(style.inverse ? TextAttributes.INVERSE : 0) |
		(style.italic ? TextAttributes.ITALIC : 0) |
		(style.underline ? TextAttributes.UNDERLINE : 0) |
		(style.strikethrough ? TextAttributes.STRIKETHROUGH : 0)
	);
	/* eslint-enable no-bitwise */
}

// Preserve users' ANSI terminal palettes, including bright names used by status
// providers. Hex colors from issue trackers remain exact RGB colors.
const ansiNames = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
];
const ansiColors = new Map(
	ansiNames.flatMap((name, index) => [
		[name, RGBA.fromIndex(index)],
		[name + 'Bright', RGBA.fromIndex(index + 8)],
	]),
);
ansiColors.set('gray', RGBA.fromIndex(8));
ansiColors.set('grey', RGBA.fromIndex(8));
export function terminalColor(color?: string) {
	return color ? (ansiColors.get(color) ?? color) : RGBA.defaultForeground();
}
