import {parseKeypress, type CliRenderer} from '@opentui/core';

const ESCAPE = '\u001B';

// Characters that open a longer sequence after Escape: CSI, SS3, OSC, DCS,
// APC, PM and SOS.
const SEQUENCE_OPENERS = '[]OP_^X';

/** Escape on its own, or Alt with a character that opens a sequence. */
function isHeldKey(bytes: string): boolean {
	if (bytes.replaceAll(ESCAPE, '') === '') return bytes !== '';
	return (
		bytes.length === 2 &&
		bytes.startsWith(ESCAPE) &&
		SEQUENCE_OPENERS.includes(bytes[1]!)
	);
}

type StdinListener = (chunk: Uint8Array | string) => void;

/**
 * Put `route` between a terminal's input and the renderer's parser. `route`
 * gets each read and the parser to hand on what it does not take itself.
 */
export function interceptInput(
	renderer: CliRenderer,
	stdin: NodeJS.ReadStream,
	route: (chunk: Uint8Array | string, parse: StdinListener) => void,
): void {
	// The renderer adds and removes this listener by reading the field, when
	// it suspends and resumes, so the field is replaced along with the listener.
	const input = renderer as unknown as {stdinListener: StdinListener};
	const parse = input.stdinListener;
	const listener: StdinListener = chunk => {
		route(chunk, parse);
	};

	stdin.off('data', parse);
	input.stdinListener = listener;
	stdin.on('data', listener);
}

/**
 * The renderer's input parser holds an Escape byte, or Escape and a character
 * that could open an escape sequence, in case the rest follows: 20 ms for a
 * lone Escape, and the others it never reports as keys at all. Whatever is
 * typed next is read as part of the same sequence. tmux has already decided
 * where a key ends and writes each one to a pane whole, so in a pane a read
 * of just those bytes is the key. It is delivered as one and the parser never
 * sees it.
 */
export function deliverHeldKeysAtOnce(
	renderer: CliRenderer,
	stdin: NodeJS.ReadStream,
): void {
	interceptInput(renderer, stdin, (chunk, parse) => {
		const bytes = chunk.toString();
		if (!isHeldKey(bytes)) {
			parse(chunk);
			return;
		}

		const keys = bytes.replaceAll(ESCAPE, '') === '' ? [...bytes] : [bytes];
		for (const key of keys) {
			const parsed = parseKeypress(key);
			if (parsed?.name) renderer.keyInput.processParsedKey(parsed);
		}
	});
}
