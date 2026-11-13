const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const PASTE_END = [ESC, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC [ 2 0 1 ~

const code = (char: string) => char.codePointAt(0)!;
const isDigit = (byte: number | undefined) =>
	byte !== undefined && byte >= 0x30 && byte <= 0x39;

export type InputSegment = {to: 'program' | 'renderer'; bytes: Uint8Array};

type Carry = 'none' | 'string' | 'string-escape' | 'csi' | 'paste';

// The image ID of the renderer's own Kitty graphics query. Every other
// graphics reply answers the program, which sent its command through to the
// terminal.
const RENDERER_GRAPHICS_REPLY = 'i=31337';

// An OSC, DCS or APC string still unfinished after this long was not a reply:
// Alt+] and a digit typed with it, say. The time between two reads includes
// the handling of the first, which in a burst of input takes tens of
// milliseconds.
const UNFINISHED_REPLY_MS = 100;

const isCsiFinal = (byte: number) => byte >= 0x40 && byte <= 0x7e;
const isCsiParameter = (byte: number) => byte >= 0x20 && byte <= 0x3f;

/**
 * Splits what a viewer pane reads from its terminal between the program in
 * the pane and the frame host's renderer.
 *
 * Keys belong to the program, as the bytes tmux wrote. Sent through the
 * renderer's input parser first, a key that looks like the start of a longer
 * sequence is held or dropped, and whatever follows it in the same read is
 * taken with it. The renderer needs only what it has to act on itself: mouse
 * reports, whose position is in this pane's cells, pastes, focus reports and
 * the terminal's replies to its queries.
 *
 * A reply or a paste can be split across reads, so state carries over. A
 * read can also end one or two bytes into a sequence when input arrives
 * faster than it is read, as a stream of mouse reports does. Those bytes are
 * held for the next read; `release` hands them over when none follows.
 */
export class FrameInputRouter {
	private carry: Carry = 'none';
	private carriedSince = 0;
	private now = 0;
	private pasteEndMatched = 0;
	private carriedTo: InputSegment['to'] = 'renderer';
	private held: Uint8Array | undefined;

	/** Whether the last read ended in bytes held for the next one. */
	get isHolding(): boolean {
		return this.held !== undefined;
	}

	/** The held bytes, for the program: nothing followed them, so they were a key. */
	release(): Uint8Array | undefined {
		const {held} = this;
		this.held = undefined;
		return held;
	}

	route(read: Uint8Array, now = performance.now()): InputSegment[] {
		let chunk = read;
		if (this.held) {
			chunk = new Uint8Array(this.held.length + read.length);
			chunk.set(this.held);
			chunk.set(read, this.held.length);
			this.held = undefined;
		}

		if (
			(this.carry === 'string' || this.carry === 'string-escape') &&
			now - this.carriedSince > UNFINISHED_REPLY_MS
		)
			this.carry = 'none';
		this.now = now;
		const segments: InputSegment[] = [];
		const emit = (to: InputSegment['to'], from: number, end: number) => {
			if (end <= from) return;
			const bytes = chunk.subarray(from, end);
			const last = segments.at(-1);
			if (last?.to === to) {
				const joined = new Uint8Array(last.bytes.length + bytes.length);
				joined.set(last.bytes);
				joined.set(bytes, last.bytes.length);
				last.bytes = joined;
			} else {
				segments.push({to, bytes});
			}
		};

		let index = 0;
		while (index < chunk.length) {
			if (this.carry === 'none') index = this.token(chunk, index, emit);
			else if (this.carry === 'csi')
				index = this.continuedCsi(chunk, index, emit);
			else index = this.continued(chunk, index, emit);
		}

		return segments;
	}

	private begin(carry: Carry, to: InputSegment['to'] = 'renderer'): void {
		this.carry = carry;
		this.carriedTo = to;
		this.carriedSince = this.now;
	}

	/**
	 * The rest of a mouse report or reply the renderer was given the start of.
	 * It has no time limit, as in the renderer's parser, which waits for the
	 * rest of a mouse report until something else arrives.
	 */
	private continuedCsi(
		chunk: Uint8Array,
		from: number,
		emit: (to: InputSegment['to'], from: number, end: number) => void,
	): number {
		let index = from;
		while (index < chunk.length && isCsiParameter(chunk[index]!)) index++;
		if (index === chunk.length) {
			emit('renderer', from, index);
			return index;
		}

		this.carry = 'none';
		// Anything but the final byte is the start of other input.
		const end = isCsiFinal(chunk[index]!) ? index + 1 : index;
		emit('renderer', from, end);
		return end;
	}

	/** The rest of a string or paste the renderer was given the start of. */
	private continued(
		chunk: Uint8Array,
		from: number,
		emit: (to: InputSegment['to'], from: number, end: number) => void,
	): number {
		let index = from;
		while (index < chunk.length && !this.endsCarried(chunk[index]!)) index++;

		if (index === chunk.length) {
			emit(this.carriedTo, from, index);
			return index;
		}

		this.carry = 'none';
		this.pasteEndMatched = 0;
		emit(this.carriedTo, from, index + 1);
		return index + 1;
	}

	/** Whether `byte` is the last of the sequence being carried. */
	private endsCarried(byte: number): boolean {
		switch (this.carry) {
			case 'paste': {
				if (byte === PASTE_END[this.pasteEndMatched]) this.pasteEndMatched++;
				else this.pasteEndMatched = byte === ESC ? 1 : 0;
				return this.pasteEndMatched === PASTE_END.length;
			}

			case 'string-escape': {
				if (byte === BACKSLASH) return true;
				this.carry = byte === ESC ? 'string-escape' : 'string';
				return byte === BEL;
			}

			case 'string':
			case 'csi':
			case 'none': {
				if (byte === ESC) this.carry = 'string-escape';
				return byte === BEL;
			}
		}
	}

	/** One key, report or reply starting at `from`; returns where it ends. */
	private token(
		chunk: Uint8Array,
		from: number,
		emit: (to: InputSegment['to'], from: number, end: number) => void,
	): number {
		if (chunk[from] !== ESC) {
			let end = from + 1;
			while (end < chunk.length && chunk[end] !== ESC) end++;
			emit('program', from, end);
			return end;
		}

		const introducer = chunk[from + 1];
		if (this.endsMidSequence(chunk, from)) {
			this.held = chunk.slice(from);
			return chunk.length;
		}

		if (introducer === code('[')) return this.csi(chunk, from, emit);
		if (introducer === code('O')) {
			const end = Math.min(from + 3, chunk.length);
			emit('program', from, end);
			return end;
		}

		if (this.startsReply(chunk, from)) {
			this.begin(
				'string',
				this.isProgramGraphicsReply(chunk, from) ? 'program' : 'renderer',
			);
			return this.continued(chunk, from, emit);
		}

		// Escape alone, or Alt with a character.
		const end = Math.min(from + 2, chunk.length);
		emit('program', from, end);
		return end;
	}

	/**
	 * Whether a read with other input before it ends on Escape, or on Escape
	 * and a character that opens a sequence. A read of only those bytes is a
	 * key, since tmux writes each key whole.
	 */
	private endsMidSequence(chunk: Uint8Array, from: number): boolean {
		if (from === 0) return false;
		const rest = chunk.length - from;
		return (
			rest === 1 ||
			(rest === 2 && '[]P_'.includes(String.fromCodePoint(chunk[from + 1]!)))
		);
	}

	/**
	 * Whether an OSC, DCS or APC string is one the renderer asked the terminal
	 * for, not Alt+], Alt+P or Alt+_ and the text typed after it.
	 */
	private startsReply(chunk: Uint8Array, from: number): boolean {
		const introducer = chunk[from + 1];
		const next = chunk[from + 2];
		if (next === undefined) return false;
		if (introducer === code(']')) return isDigit(next);
		if (introducer === code('P'))
			return isDigit(next) || '>$!'.includes(String.fromCodePoint(next));
		return introducer === code('_') && next === code('G');
	}

	private isProgramGraphicsReply(chunk: Uint8Array, from: number): boolean {
		if (chunk[from + 1] !== code('_')) return false;
		const keys = String.fromCodePoint(
			...chunk.subarray(
				from + 3,
				from + 3 + RENDERER_GRAPHICS_REPLY.length + 1,
			),
		);
		return !`${RENDERER_GRAPHICS_REPLY};`.startsWith(keys);
	}

	private csi(
		chunk: Uint8Array,
		from: number,
		emit: (to: InputSegment['to'], from: number, end: number) => void,
	): number {
		const first = chunk[from + 2];
		// An X10 mouse report: three bytes of button and position follow.
		if (first === code('M')) {
			const end = Math.min(from + 6, chunk.length);
			emit('renderer', from, end);
			return end;
		}

		let index = from + 2;
		while (index < chunk.length) {
			const byte = chunk[index]!;
			if (isCsiFinal(byte)) break;
			// Not a parameter or intermediate byte: the sequence stops short.
			if (!isCsiParameter(byte)) {
				emit('program', from, index);
				return index;
			}

			index++;
		}

		const parameters = String.fromCodePoint(...chunk.subarray(from + 2, index));
		const isPrivate = '<?>'.includes(parameters[0] ?? ' ');
		if (index === chunk.length) {
			// The rest of a mouse report or a reply follows in the next read. A
			// key cut short is the program's to make sense of.
			if (isPrivate) {
				this.begin('csi');
				emit('renderer', from, index);
			} else {
				emit('program', from, index);
			}

			return index;
		}

		const final = String.fromCodePoint(chunk[index]!);
		const end = index + 1;
		if (final === '~' && parameters === '200') {
			this.begin('paste');
			emit('renderer', from, end);
			return end;
		}

		emit(
			this.isForRenderer(parameters, final, isPrivate) ? 'renderer' : 'program',
			from,
			end,
		);
		return end;
	}

	private isForRenderer(
		parameters: string,
		final: string,
		isPrivate: boolean,
	): boolean {
		switch (final) {
			// SGR mouse reports.
			case 'M':
			case 'm': {
				return parameters.startsWith('<');
			}

			// Focus in and out.
			case 'I':
			case 'O': {
				return parameters === '';
			}

			// Device attributes, a kitty keyboard query's answer.
			case 'c':
			case 'u': {
				return isPrivate;
			}

			// A mode report.
			case 'y': {
				return parameters.includes('$');
			}

			// A cursor position report, unless it is Shift, Ctrl or Alt with F3,
			// which has the same form.
			case 'R': {
				return !/^1;[2-8]$/.test(parameters);
			}

			// Window size and device status reports.
			case 't':
			case 'n': {
				return true;
			}

			default: {
				return false;
			}
		}
	}
}
