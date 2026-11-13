const ESC = 0x1b;
const BEL = 0x07;
const OSC_INTRODUCER = 0x5d; // ']'
const APC_INTRODUCER = 0x5f; // '_'
const GRAPHICS_COMMAND = 0x47; // 'G'
const CSI_INTRODUCER = 0x5b; // '['
const STRING_TERMINATOR = 0x5c; // '\'
const KEYPAD_APPLICATION = 0x3d; // '='
const KEYPAD_NUMERIC = 0x3e; // '>'
// tmux caps a clipboard copy well below this, so anything longer is not one.
const MAX_PAYLOAD = 1024 * 1024;
// The Kitty graphics protocol splits image data into chunks of 4096 bytes.
const MAX_GRAPHICS_COMMAND = 64 * 1024;

export type OscEvents = {
	/** The last window title set in the chunk, if any. */
	title?: string;
	/** Sequences the outer terminal should receive verbatim. */
	passthrough: string[];
	/** Window size queries (`CSI 18 t`, `CSI 14 t`) the frame must answer. */
	sizeQueries: SizeQuery[];
	/** The chunk without its Kitty graphics commands, for the embedded terminal. */
	screen: Uint8Array;
};

export type SizeQuery = 'cells' | 'pixels';

type State =
	| 'text'
	| 'escape'
	| 'osc'
	| 'osc-escape'
	| 'csi'
	| 'apc'
	| 'graphics'
	| 'graphics-escape';

/**
 * Picks the sequences out of a nested tmux client's output that the embedded
 * terminal would otherwise consume: the window title, which names the frame,
 * clipboard writes and bells, which must reach the user's real
 * terminal, the keypad mode, which decides what the outer tmux sends this
 * pane for a keypad key, and window size queries, which the embedded terminal
 * leaves unanswered.
 * Kitty graphics commands are taken out of what the embedded terminal is
 * given and passed to the real terminal, which draws the image wherever the
 * program put Unicode placeholder cells for it.
 * Sequences can be split across reads, so state carries over between chunks.
 */
export class OscScanner {
	private state: State = 'text';
	private payload: number[] = [];
	private overflowed = false;
	private csiParameters = '';
	// The start of a sequence the last read ended in, which may yet turn out
	// to be a graphics command the embedded terminal must not see.
	private heldEscape: Uint8Array = new Uint8Array();
	private graphicsCommand: number[] = [];
	private readonly decoder = new TextDecoder();

	feed(read: Uint8Array): OscEvents {
		const chunk = this.withHeldEscape(read);
		const events: OscEvents = {
			passthrough: [],
			sizeQueries: [],
			screen: new Uint8Array(),
		};
		const screen: Uint8Array[] = [];
		let screenFrom = 0;
		let escapeAt = 0;
		for (let index = 0; index < chunk.length; index++) {
			const byte = chunk[index]!;
			switch (this.state) {
				case 'text': {
					if (byte === ESC) {
						this.state = 'escape';
						escapeAt = index;
					} else if (byte === BEL) {
						events.passthrough.push('\u0007');
					}

					break;
				}

				case 'apc': {
					if (byte === GRAPHICS_COMMAND) {
						this.state = 'graphics';
						this.graphicsCommand = [ESC, APC_INTRODUCER, GRAPHICS_COMMAND];
						this.overflowed = false;
						screen.push(chunk.subarray(screenFrom, escapeAt));
					} else {
						this.state = byte === ESC ? 'escape' : 'text';
						escapeAt = index;
					}

					break;
				}

				case 'graphics': {
					if (byte === ESC) this.state = 'graphics-escape';
					else if (this.graphicsCommand.length < MAX_GRAPHICS_COMMAND)
						this.graphicsCommand.push(byte);
					else this.overflowed = true;
					break;
				}

				case 'graphics-escape': {
					this.state = 'text';
					screenFrom = index + 1;
					if (byte === STRING_TERMINATOR && !this.overflowed) {
						this.graphicsCommand.push(ESC, STRING_TERMINATOR);
						events.passthrough.push(
							this.decoder.decode(Uint8Array.from(this.graphicsCommand)),
						);
					}

					this.graphicsCommand = [];
					break;
				}

				case 'escape': {
					switch (byte) {
						case APC_INTRODUCER: {
							this.state = 'apc';
							break;
						}

						case OSC_INTRODUCER: {
							this.state = 'osc';
							this.payload = [];
							this.overflowed = false;
							break;
						}

						case CSI_INTRODUCER: {
							this.state = 'csi';
							this.csiParameters = '';
							break;
						}

						case ESC: {
							escapeAt = index;
							break;
						}

						default: {
							this.state = 'text';
							if (byte === KEYPAD_APPLICATION)
								events.passthrough.push('\u001B=');
							else if (byte === KEYPAD_NUMERIC)
								events.passthrough.push('\u001B>');
						}
					}

					break;
				}

				case 'csi': {
					if (byte >= 0x30 && byte <= 0x3f) {
						this.csiParameters += String.fromCodePoint(byte);
					} else {
						this.state = byte === ESC ? 'escape' : 'text';
						escapeAt = index;
						if (byte === 0x74 /* 't' */) this.finishWindowOp(events);
					}

					break;
				}

				case 'osc': {
					if (byte === BEL) this.finish(events);
					else if (byte === ESC) this.state = 'osc-escape';
					else this.collect(byte);
					break;
				}

				case 'osc-escape': {
					if (byte === STRING_TERMINATOR) {
						this.finish(events);
					} else {
						// An escape that does not end the string starts a new sequence.
						this.state = byte === OSC_INTRODUCER ? 'osc' : 'text';
						this.payload = [];
						this.overflowed = false;
					}

					break;
				}
			}
		}

		if (this.state === 'graphics' || this.state === 'graphics-escape') {
			screenFrom = chunk.length;
		} else if (this.state === 'escape' || this.state === 'apc') {
			this.heldEscape = chunk.slice(escapeAt);
			this.state = 'text';
			screen.push(chunk.subarray(screenFrom, escapeAt));
			screenFrom = chunk.length;
		}

		screen.push(chunk.subarray(screenFrom));
		events.screen = concat(screen);
		return events;
	}

	private withHeldEscape(read: Uint8Array): Uint8Array {
		const held = this.heldEscape;
		if (held.length === 0) return read;
		this.heldEscape = new Uint8Array();
		return concat([held, read]);
	}

	private collect(byte: number) {
		if (this.payload.length < MAX_PAYLOAD) this.payload.push(byte);
		else this.overflowed = true;
	}

	private finishWindowOp(events: OscEvents) {
		if (this.csiParameters === '18') events.sizeQueries.push('cells');
		else if (this.csiParameters === '14') events.sizeQueries.push('pixels');
	}

	private finish(events: OscEvents) {
		this.state = 'text';
		if (this.overflowed) return;
		const payload = this.decoder.decode(Uint8Array.from(this.payload));
		const separator = payload.indexOf(';');
		const command = payload.slice(0, separator);
		const value = payload.slice(separator + 1);
		if (separator < 0) return;
		if (command === '0' || command === '2') events.title = value;
		else if (command === '52')
			events.passthrough.push(`\u001B]52;${value}\u0007`);
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const nonEmpty = parts.filter(part => part.length > 0);
	if (nonEmpty.length === 1) return nonEmpty[0]!;
	const joined = new Uint8Array(
		nonEmpty.reduce((length, part) => length + part.length, 0),
	);
	let offset = 0;
	for (const part of nonEmpty) {
		joined.set(part, offset);
		offset += part.length;
	}

	return joined;
}
