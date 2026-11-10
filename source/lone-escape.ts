import {Buffer} from 'node:buffer';
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
	// Ahead of the renderer's own listener, so the count is right by the time
	// the parser emits anything for this read.
	stdin.prependListener('data', (chunk: Uint8Array | string) => {
		if (chunk.toString() !== ESCAPE) return;
		heldByParser++;
		renderer.keyInput.processParsedKey(escapeKey);
	});
	renderer.prependInputHandler(sequence => {
		if (heldByParser === 0) return false;
		let delivered = 0;
		while (delivered < heldByParser && sequence[delivered] === ESCAPE)
			delivered++;
		if (delivered === 0) {
			heldByParser = 0;
			return false;
		}

		heldByParser -= delivered;
		// The parser joins an Escape it still holds to the key typed after it.
		const following = sequence.slice(delivered);
		if (following === '') return true;
		const followingKey = parseKeypress(following);
		if (followingKey) renderer.keyInput.processParsedKey(followingKey);
		// A focus report or a terminal's reply: back through the parser, once
		// it has finished with the read this came from.
		else queueMicrotask(() => stdin.emit('data', Buffer.from(following)));
		return true;
	});
}
