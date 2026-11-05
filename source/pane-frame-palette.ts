import type {TerminalColors} from '@opentui/core';

function oscColor(hex: string): string {
	const digits = hex.replace(/^#/, '');
	return `rgb:${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 6)}`;
}

/**
 * The embedded terminal resolves palette colors to its own built-in RGB
 * values, which would repaint the user's theme in the agent and companion
 * panes. Setting its palette and default colors to the outer terminal's keeps
 * them looking as they do everywhere else.
 */
export function paletteSequences(colors: TerminalColors): string {
	const sequences = colors.palette.flatMap((hex, index) =>
		hex ? [`\u001B]4;${index};${oscColor(hex)}\u001B\\`] : [],
	);
	if (colors.defaultForeground)
		sequences.push(`\u001B]10;${oscColor(colors.defaultForeground)}\u001B\\`);
	if (colors.defaultBackground)
		sequences.push(`\u001B]11;${oscColor(colors.defaultBackground)}\u001B\\`);
	return sequences.join('');
}
