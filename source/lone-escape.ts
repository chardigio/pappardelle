import {parseKeypress, type CliRenderer} from '@opentui/core';

const ESCAPE = '\u001B';

// Characters that open a longer sequence after Escape: CSI, SS3, OSC, DCS,
// APC, PM and SOS.
const SEQUENCE_OPENERS = '[]OP_^X';

/**
 * Escape on its own, or Alt with a character the parser does not report as a
 * key: one that opens a sequence, or one outside ASCII, which it splits.
 */
function isHeldKey(bytes: string): boolean {
	if (bytes.replaceAll(ESCAPE, '') === '') return bytes !== '';
	const [first, second, ...rest] = bytes;
	return (
		first === ESCAPE &&
		second !== undefined &&
		rest.length === 0 &&
		(SEQUENCE_OPENERS.includes(second) || second > '\u007F')
	);
}

type StdinListener = (chunk: Uint8Array | string) => void;

/**
 * The renderer's input parser holds an Escape byte, or Escape and a character
 * that could open an escape sequence, in case the rest follows: 20 ms for a
 * lone Escape, and the others it never reports as keys at all. Whatever is
 * typed next is read as part of the same sequence. tmux has already decided
 * where a key ends and writes each one to a pane whole, so in a pane a read
 * of just those bytes is the key. Such a read goes to `deliver` and the
 * parser never sees it. `isAlsoKey` names further reads to treat that way.
 */
export function deliverHeldKeysAtOnce(
	renderer: CliRenderer,
	stdin: NodeJS.ReadStream,
	deliver: (bytes: string) => void = bytes => {
		const keys = bytes.replaceAll(ESCAPE, '') === '' ? [...bytes] : [bytes];
		for (const key of keys) {
			const parsed = parseKeypress(key);
			if (parsed?.name) renderer.keyInput.processParsedKey(parsed);
		}
	},
	isAlsoKey: (bytes: string) => boolean = () => false,
): void {
	// The renderer adds and removes this listener by reading the field, when
	// it suspends and resumes, so the field is replaced along with the listener.
	const input = renderer as unknown as {stdinListener: StdinListener};
	const parse = input.stdinListener;
	const route: StdinListener = chunk => {
		const bytes = chunk.toString();
		if (isHeldKey(bytes) || isAlsoKey(bytes)) deliver(bytes);
		else parse(chunk);
	};

	stdin.off('data', parse);
	input.stdinListener = route;
	stdin.on('data', route);
}
