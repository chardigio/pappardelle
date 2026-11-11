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

/**
 * The embedded terminal resolves palette colors to its own built-in RGB
 * values, which would repaint the user's theme in the agent and companion
 * panes. Setting its palette and default colors to the outer terminal's keeps
 * them looking as they do everywhere else.
 */
export function paletteSequences(colors: FrameColors): string {
	const sequences = colors.palette.flatMap((hex, index) =>
		hex ? [`\u001B]4;${index};${oscColor(hex)}\u001B\\`] : [],
	);
	if (colors.defaultForeground)
		sequences.push(`\u001B]10;${oscColor(colors.defaultForeground)}\u001B\\`);
	if (colors.defaultBackground)
		sequences.push(`\u001B]11;${oscColor(colors.defaultBackground)}\u001B\\`);
	return sequences.join('');
}
