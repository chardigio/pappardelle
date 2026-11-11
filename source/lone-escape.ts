import {Buffer} from 'node:buffer';
import {parseKeypress, type CliRenderer} from '@opentui/core';

const ESCAPE = '\u001B';
const ESCAPE_BYTE = 0x1b;

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

/**
 * A read without Alt and a character outside ASCII: Escape and the bytes of
 * the character. The parser splits them and reads the bytes after the first
 * as Alt with a control key, so Alt+ă, whose last byte is 0x83, arrives as
 * Alt+Ctrl+C and quits the app. Neither the rail nor a popup has a use for
 * such a key.
 */
function withoutAltNonAscii(read: Buffer): Buffer {
	if (!read.includes(ESCAPE_BYTE)) return read;
	const kept: number[] = [];
	let index = 0;
	while (index < read.length) {
		if (read[index] === ESCAPE_BYTE && read[index + 1]! >= 0xc0) {
			index += 2;
			// The character's continuation bytes.
			while (read[index]! >= 0x80 && read[index]! <= 0xbf) index++;
		} else {
			kept.push(read[index]!);
			index++;
		}
	}

	return kept.length === read.length ? read : Buffer.from(kept);
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
 * sees it. `take` is offered each key first, as an input handler would be.
 */
export function deliverHeldKeysAtOnce(
	renderer: CliRenderer,
	stdin: NodeJS.ReadStream,
	take: (key: string) => boolean = () => false,
): void {
	interceptInput(renderer, stdin, (chunk, parse) => {
		const read = withoutAltNonAscii(Buffer.from(chunk));
		const bytes = read.toString();
		if (!isHeldKey(bytes)) {
			if (read.length > 0) parse(read);
			return;
		}

		const keys = bytes.replaceAll(ESCAPE, '') === '' ? [...bytes] : [bytes];
		for (const key of keys) {
			if (take(key)) continue;
			const parsed = parseKeypress(key);
			if (parsed?.name) renderer.keyInput.processParsedKey(parsed);
		}
	});
}
