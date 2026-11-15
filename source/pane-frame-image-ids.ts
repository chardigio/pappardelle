/* eslint-disable no-bitwise */
import {Buffer} from 'node:buffer';

// Gives each image a program in a companion pane uploads an ID of the frame's
// own. A program animating an image with Unicode placeholders uploads each
// frame under an ID and then rewrites the cells to name it, alternating
// between two IDs. The upload reaches the terminal at once through the tmux
// above the frame, while the cells come later with that tmux's redraw, so an
// ID could be uploaded again while some cells on screen still showed it, and
// the terminal draws cells whose image is still uploading blank. Each upload
// that comes with its cells now goes to the next of a few IDs kept for the
// program's ID, so an ID is uploaded again only frames after the screen
// moved off it. The IDs are also the frame's own, so programs in two panes
// that happen to pick the same ID no longer replace each other's images.

/** How many IDs each program image cycles through. */
const IDS_PER_IMAGE = 4;
const LOW_BITS = 0xff_ff_ff;
const HIGH_BYTE = 0xff_00_00_00;
const ESC = 0x1b;
const CSI_INTRODUCER = 0x5b; // '['

type Keys = Array<[string, string]>;

function parseCommand(command: string): {keys: Keys; payload: string} {
	const body = command.slice('\u001B_G'.length, -'\u001B\\'.length);
	const separator = body.indexOf(';');
	const keyText = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? '' : body.slice(separator);
	const keys = keyText
		.split(',')
		.filter(Boolean)
		.map(pair => {
			const at = pair.indexOf('=');
			return [pair.slice(0, at), pair.slice(at + 1)] as [string, string];
		});
	return {keys, payload};
}

function formatCommand(keys: Keys, payload: string): string {
	return `\u001B_G${keys.map(([key, value]) => `${key}=${value}`).join(',')}${payload}\u001B\\`;
}

function withId(keys: Keys, id: number): Keys {
	return keys.map(([key, value]) => [key, key === 'i' ? String(id) : value]);
}

/** Whether some cells in `screen` name the image with these low 24 bits. */
function showsImage(screen: Uint8Array[], lowBits: number): boolean {
	const red = (lowBits >> 16) & 0xff;
	const green = (lowBits >> 8) & 0xff;
	const blue = lowBits & 0xff;
	const color = new RegExp(
		`[[;]38[;:]2[;:](?:\\d*:)?${red}[;:]${green}[;:]${blue}[;:m]`,
	);
	return screen.some(bytes =>
		color.test(Buffer.from(bytes).toString('latin1')),
	);
}

export class ImageIds {
	// Each program image's IDs, the one in use last.
	private readonly idsOf = new Map<number, number[]>();
	private readonly programIdOf = new Map<number, number>();
	// Program image low bits to the low bits of the ID its cells now name.
	private readonly colors = new Map<number, number>();
	private nextLowBits: number;
	private sgr: number[] | undefined;

	constructor(seed: number) {
		this.nextLowBits = seed & LOW_BITS;
	}

	/**
	 * The commands to send for one from the program. `laterScreen` is what the
	 * program writes after it in the same image frame; an upload followed by
	 * cells that show it goes to a fresh ID.
	 */
	translate(command: string, laterScreen: Uint8Array[]): string[] {
		const {keys, payload} = parseCommand(command);
		const idText = keys.find(([key]) => key === 'i')?.[1];
		if (idText === undefined) return [command];
		const programId = Number(idText);
		const action = keys.find(([key]) => key === 'a')?.[1] ?? 't';
		const ids = this.idsOf.get(programId);

		if (action === 'd') {
			const target = keys.find(([key]) => key === 'd')?.[1] ?? 'a';
			if (!ids || (target !== 'i' && target !== 'I')) return [command];
			this.forget(programId);
			return ids.map(id => formatCommand(withId(keys, id), payload));
		}

		const isUpload = action === 't' || action === 'T';
		if (isUpload && showsImage(laterScreen, programId & LOW_BITS)) {
			const id = this.nextId(programId);
			return [formatCommand(withId(keys, id), payload)];
		}

		const current = ids?.at(-1);
		return current === undefined
			? [command]
			: [formatCommand(withId(keys, current), payload)];
	}

	/** The program's ID for an ID a terminal reply names. */
	programId(id: number): number {
		return this.programIdOf.get(id) ?? id;
	}

	/** Deletes for every ID in use, for when the program is gone. */
	deleteAll(): string[] {
		return [...this.programIdOf.keys()].map(
			id => `\u001B_Ga=d,d=I,i=${id},q=2\u001B\\`,
		);
	}

	/**
	 * Points the cells in the program's output at the IDs their images now
	 * have, by rewriting 24-bit foreground colors. Output must come in order;
	 * a color split across writes is completed with the next one.
	 */
	rewriteCells(bytes: Uint8Array): Uint8Array {
		if (this.colors.size === 0 && !this.sgr) return bytes;
		const out: number[] = [];
		for (const byte of bytes) {
			if (this.sgr) {
				this.sgr.push(byte);
				if (this.sgr.length === 2 && byte !== CSI_INTRODUCER) {
					out.push(...this.sgr);
					this.sgr = undefined;
				} else if (this.sgr.length > 2 && byte >= 0x40 && byte <= 0x7e) {
					out.push(...this.finishSgr(this.sgr));
					this.sgr = undefined;
				} else if (this.sgr.length > 256) {
					out.push(...this.sgr);
					this.sgr = undefined;
				}
			} else if (byte === ESC) {
				this.sgr = [byte];
			} else {
				out.push(byte);
			}
		}

		return Uint8Array.from(out);
	}

	private finishSgr(sequence: number[]): number[] {
		if (sequence.at(-1) !== 0x6d /* 'm' */) return sequence;
		const parameters = String.fromCodePoint(...sequence.slice(2, -1));
		const rewritten = this.rewriteParameters(parameters);
		if (rewritten === parameters) return sequence;
		return [...Buffer.from(`\u001B[${rewritten}m`, 'latin1')];
	}

	private rewriteParameters(parameters: string): string {
		const fields = parameters.split(';');
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index]!;
			if (field.startsWith('38:2:')) {
				const parts = field.split(':');
				const at = parts.length === 6 ? 3 : 2;
				const mapped = this.mappedColor(parts.slice(at, at + 3));
				if (mapped) {
					parts.splice(at, 3, ...mapped);
					fields[index] = parts.join(':');
				}
			} else if (field === '38' && fields[index + 1] === '2') {
				const mapped = this.mappedColor(fields.slice(index + 2, index + 5));
				if (mapped) fields.splice(index + 2, 3, ...mapped);
				index += 4;
			} else if (
				(field === '38' || field === '48' || field === '58') &&
				fields[index + 1] === '5'
			) {
				index += 2;
			} else if (
				(field === '48' || field === '58') &&
				fields[index + 1] === '2'
			) {
				index += 4;
			}
		}

		return fields.join(';');
	}

	private mappedColor(channels: string[]): string[] | undefined {
		if (channels.length !== 3) return undefined;
		const [red, green, blue] = channels.map(Number) as [number, number, number];
		const mapped = this.colors.get((red << 16) | (green << 8) | blue);
		if (mapped === undefined) return undefined;
		return [(mapped >> 16) & 0xff, (mapped >> 8) & 0xff, mapped & 0xff].map(
			String,
		);
	}

	private nextId(programId: number): number {
		const ids = this.idsOf.get(programId) ?? [];
		let id: number;
		if (ids.length < IDS_PER_IMAGE) {
			id = ((programId & HIGH_BYTE) | this.allocateLowBits()) >>> 0;
			this.programIdOf.set(id, programId);
		} else {
			id = ids.shift()!;
		}

		ids.push(id);
		this.idsOf.set(programId, ids);
		this.colors.set(programId & LOW_BITS, id & LOW_BITS);
		return id;
	}

	private allocateLowBits(): number {
		do {
			this.nextLowBits = (this.nextLowBits + 1) & LOW_BITS;
		} while (this.nextLowBits === 0 || this.colors.has(this.nextLowBits));
		return this.nextLowBits;
	}

	private forget(programId: number): void {
		for (const id of this.idsOf.get(programId) ?? [])
			this.programIdOf.delete(id);
		this.idsOf.delete(programId);
		this.colors.delete(programId & LOW_BITS);
	}
}
