import type {TerminalColors} from '@opentui/core';

export type FrameColors = Pick<
	TerminalColors,
	'palette' | 'defaultForeground' | 'defaultBackground'
>;

/** What a palette query needs from the renderer that owns the terminal. */
export type PaletteTerminal = {
	write(sequence: string): void;
	subscribeOsc(handler: (sequence: string) => void): () => void;
	prependInputHandler(handler: (sequence: string) => boolean): void;
	removeInputHandler(handler: (sequence: string) => boolean): void;
};

const PALETTE_SIZE = 16;
const OSC = '\u001B]';
const COLOR_REPLY =
	/^(4;(\d+)|10|11);rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})/i;
const STATUS_QUERY = '\u001B[5n';
const STATUS_REPLY = '\u001B[0n';

// A reply carries one to four hex digits per channel, most significant first.
function channel(digits: string): string {
	return digits.padEnd(2, digits).slice(0, 2).toLowerCase();
}

/**
 * Ask the terminal for its palette and default colors, leaving any it doesn't
 * report as null.
 *
 * A terminal answers queries in order, so the reply to the status report sent
 * last means every color that will be reported has been. The renderer's own
 * palette detection waits for the cursor color as well, which tmux reports
 * only for a pane that has set one, and so loses 300ms in a pane that hasn't.
 */
export async function queryPalette(
	terminal: PaletteTerminal,
	timeoutMs: number,
): Promise<FrameColors> {
	const colors: FrameColors = {
		palette: Array.from({length: PALETTE_SIZE}, () => null),
		defaultForeground: null,
		defaultBackground: null,
	};
	return new Promise(resolve => {
		const finish = () => {
			clearTimeout(timer);
			unsubscribe();
			terminal.removeInputHandler(onStatus);
			resolve(colors);
		};

		const onStatus = (sequence: string) => {
			if (sequence !== STATUS_REPLY) return false;
			finish();
			return true;
		};

		const unsubscribe = terminal.subscribeOsc(sequence => {
			if (!sequence.startsWith(OSC)) return;
			const reply = COLOR_REPLY.exec(sequence.slice(OSC.length));
			if (!reply) return;
			const hex = `#${channel(reply[3]!)}${channel(reply[4]!)}${channel(reply[5]!)}`;
			if (reply[1] === '10') colors.defaultForeground = hex;
			else if (reply[1] === '11') colors.defaultBackground = hex;
			else if (Number(reply[2]) < PALETTE_SIZE)
				colors.palette[Number(reply[2])] = hex;
		});
		terminal.prependInputHandler(onStatus);
		const timer = setTimeout(finish, timeoutMs);
		terminal.write(
			Array.from(
				{length: PALETTE_SIZE},
				(_, index) => `\u001B]4;${index};?\u0007`,
			).join('') +
				'\u001B]10;?\u0007\u001B]11;?\u0007' +
				STATUS_QUERY,
		);
	});
}

function oscColor(hex: string): string {
	const digits = hex.replace(/^#/, '');
	return `rgb:${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 6)}`;
}

// What the embedded terminal paints for a default color that is not set.
const BUILT_IN_FOREGROUND = '#ffffff';
const BUILT_IN_BACKGROUND = '#000000';
// WCAG's floor for large text: the least a pane of prose can get by with.
const MIN_DEFAULT_CONTRAST = 3;

function luminance(hex: string): number {
	const digits = hex.replace(/^#/, '');
	const [r, g, b] = [0, 2, 4].map(offset => {
		const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
		return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: string, second: string): number {
	const [light, dark] = [luminance(first), luminance(second)].sort(
		(a, b) => b - a,
	);
	return (light! + 0.05) / (dark! + 0.05);
}

/**
 * The embedded terminal resolves palette colors to its own built-in RGB
 * values, which would repaint the user's theme in the agent and companion
 * panes. Setting its palette and default colors to the outer terminal's keeps
 * them looking as they do everywhere else.
 *
 * A color the outer terminal does not report is reset rather than left out,
 * so a refresh cannot keep a stale value from an earlier theme.
 *
 * The default pair is not trusted blindly. After a macOS light/dark switch,
 * tmux reported black for both the foreground and the background while
 * Ghostty, with no theme set, still drew dark, and copying that pair made
 * every line written in the default color invisible (STA-3102). A pair that
 * would be unreadable falls back to the built-in white on black.
 */
export function paletteSequences(colors: FrameColors): string {
	const sequences = colors.palette.flatMap((hex, index) =>
		hex ? [`\u001B]4;${index};${oscColor(hex)}\u001B\\`] : [],
	);
	let foreground = colors.defaultForeground;
	let background = colors.defaultBackground;
	if (
		contrast(
			foreground ?? BUILT_IN_FOREGROUND,
			background ?? BUILT_IN_BACKGROUND,
		) < MIN_DEFAULT_CONTRAST
	) {
		foreground = null;
		background = null;
	}

	sequences.push(
		foreground
			? `\u001B]10;${oscColor(foreground)}\u001B\\`
			: '\u001B]110\u001B\\',
		background
			? `\u001B]11;${oscColor(background)}\u001B\\`
			: '\u001B]111\u001B\\',
	);
	return sequences.join('');
}
