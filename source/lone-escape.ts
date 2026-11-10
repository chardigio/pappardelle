import {parseKeypress, type CliRenderer} from '@opentui/core';

const ESCAPE = '\u001B';

/**
 * The renderer holds a lone Escape byte for 20 ms in case the rest of an
 * escape sequence follows. tmux has already made that call and writes each key
 * to a pane whole, so in a pane a read of just the Escape byte is the key.
 * This delivers it on arrival and drops the renderer's late copy.
 */
export function deliverLoneEscapeAtOnce(
	renderer: Pick<CliRenderer, 'keyInput' | 'prependInputHandler'>,
	stdin: NodeJS.ReadStream,
): void {
	const escapeKey = parseKeypress(ESCAPE)!;
	let heldByParser = 0;
	stdin.on('data', (chunk: Uint8Array | string) => {
		if (chunk.toString() !== ESCAPE) {
			// The parser reads an Escape it still holds as the start of this input.
			heldByParser = 0;
			return;
		}

		heldByParser++;
		renderer.keyInput.processParsedKey(escapeKey);
	});
	renderer.prependInputHandler(sequence => {
		if (heldByParser === 0 || sequence.replaceAll(ESCAPE, '') !== '')
			return false;
		heldByParser = Math.max(0, heldByParser - sequence.length);
		return true;
	});
}
