const ESC = 0x1b;
const BEL = 0x07;
const OSC_INTRODUCER = 0x5d; // ']'
const STRING_TERMINATOR = 0x5c; // '\'
// tmux caps a clipboard copy well below this, so anything longer is not one.
const MAX_PAYLOAD = 1024 * 1024;

export type OscEvents = {
	/** The last window title set in the chunk, if any. */
	title?: string;
	/** Sequences the outer terminal should receive verbatim. */
	passthrough: string[];
};

type State = 'text' | 'escape' | 'osc' | 'osc-escape';

/**
 * Picks the sequences out of a nested tmux client's output that the embedded
 * terminal would otherwise consume: the window title, which names the frame,
 * and clipboard writes (OSC 52), which must reach the user's real terminal.
 * Sequences can be split across reads, so state carries over between chunks.
 */
export class OscScanner {
	private state: State = 'text';
	private payload: number[] = [];
	private overflowed = false;
	private readonly decoder = new TextDecoder();

	feed(chunk: Uint8Array): OscEvents {
		const events: OscEvents = {passthrough: []};
		for (const byte of chunk) {
			switch (this.state) {
				case 'text': {
					if (byte === ESC) this.state = 'escape';
					break;
				}

				case 'escape': {
					if (byte === OSC_INTRODUCER) {
						this.state = 'osc';
						this.payload = [];
						this.overflowed = false;
					} else if (byte !== ESC) {
						this.state = 'text';
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

		return events;
	}

	private collect(byte: number) {
		if (this.payload.length < MAX_PAYLOAD) this.payload.push(byte);
		else this.overflowed = true;
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
