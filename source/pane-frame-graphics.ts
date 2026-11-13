// Kitty graphics commands a pane's program sends reach the real terminal
// through this frame. When the frame is itself a pane of tmux, each tmux
// above it takes a raw command for a pane title, so the command is wrapped in
// tmux's passthrough sequence once for each of them.

/** The image ID of the renderer's own Kitty graphics query. */
const RENDERER_QUERY_ID = 31_337;
const FIRST_PROBE_ID = 31_340;
const MAX_PROBED_DEPTH = 3;
const PROBE_TIMEOUT_MS = 1000;

/** Whether a graphics reply with this image ID answers the frame, not the program. */
export function isFrameGraphicsReply(id: number): boolean {
	return (
		id === RENDERER_QUERY_ID ||
		(id > FIRST_PROBE_ID && id <= FIRST_PROBE_ID + MAX_PROBED_DEPTH)
	);
}

export function wrapForTmux(command: string, depth: number): string {
	let wrapped = command;
	for (let layer = 0; layer < depth; layer++)
		wrapped = `\u001BPtmux;${wrapped.replaceAll('\u001B', '\u001B\u001B')}\u001B\\`;
	return wrapped;
}

/**
 * Passes the program's graphics commands on, wrapped for the number of tmux
 * servers between the frame and the terminal. Graphics replies come back
 * through tmux, so a query wrapped for each depth is answered only by the one
 * that reached the terminal. Commands wait for that answer; without one, the
 * depth found before is kept.
 */
export class GraphicsForwarder {
	private depth: number | undefined;
	private pending: string[] = [];
	private probeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		/** Returns false when the output is full and the sequence was not taken. */
		private readonly write: (sequence: string) => boolean,
		private readonly isInTmux: boolean,
	) {
		this.depth = isInTmux ? undefined : 0;
	}

	/** Returns false when the command could not be taken yet. */
	forward(command: string): boolean {
		if (this.depth !== undefined)
			return this.write(wrapForTmux(command, this.depth));
		this.pending.push(command);
		return true;
	}

	/** Asks again, as tmux drops what a pane it is not showing passes through. */
	probe(): void {
		if (!this.isInTmux) return;
		const previousDepth = this.depth;
		this.depth = undefined;
		let probes = '';
		for (let depth = 1; depth <= MAX_PROBED_DEPTH; depth++)
			probes += wrapForTmux(
				`\u001B_Gi=${FIRST_PROBE_ID + depth},s=1,v=1,a=q,t=d,f=24;AAAA\u001B\\`,
				depth,
			);
		this.write(probes);
		clearTimeout(this.probeTimer);
		this.probeTimer = setTimeout(() => {
			if (this.depth === undefined) this.settle(previousDepth ?? 1);
		}, PROBE_TIMEOUT_MS);
	}

	/** Takes the depth from a probe's answer among the terminal's replies. */
	readReplies(input: string): void {
		// eslint-disable-next-line no-control-regex
		for (const match of input.matchAll(/\u001B_Gi=(\d+)[;,]/g)) {
			const id = Number(match[1]);
			if (id > FIRST_PROBE_ID && id <= FIRST_PROBE_ID + MAX_PROBED_DEPTH)
				this.settle(id - FIRST_PROBE_ID);
		}
	}

	dispose(): void {
		clearTimeout(this.probeTimer);
	}

	private settle(depth: number): void {
		clearTimeout(this.probeTimer);
		this.depth = depth;
		const {pending} = this;
		this.pending = [];
		for (const command of pending) this.write(wrapForTmux(command, depth));
	}
}

type Piece = {screen: Uint8Array} | {graphics: string};
// A held piece, and whether it begins the program's next image frame.
type Held = {piece: Piece; startsFrame: boolean};

export type FramedOutputDependencies = {
	writeScreen(bytes: Uint8Array): void;
	/** Queues a command ahead of the renderer's next frame; false when the output is full. */
	writeGraphics(command: string): boolean;
	requestFrame(): void;
	schedule(callback: () => void, ms: number): () => void;
};

// The rest of an image's frame follows its upload within a read or two, so
// output that stops for this long has finished the frame.
const FRAME_QUIET_MS = 4;
// A program that never pauses still has its output shown this often.
const MAX_FRAME_HOLD_MS = 50;

/**
 * Keeps a program's image frames whole. A program that animates an image
 * uploads each frame and then rewrites the placeholder cells to show it, and
 * the renderer would otherwise draw whatever part of the cells had arrived,
 * showing rows of two frames at once. Once a graphics command arrives, the
 * output after it is held until the program pauses or starts the next image
 * frame, and the commands and cells are then given to one renderer frame,
 * the commands first, so the terminal has the image before the cells that
 * show it. Output with no graphics before it is not held.
 */
export class FramedOutput {
	private readonly held: Held[] = [];
	// How many leading pieces are whole frames ready for the renderer.
	private readyCount = 0;
	private isUploading = false;
	private cancelQuiet: (() => void) | undefined;
	private cancelHold: (() => void) | undefined;

	constructor(private readonly dependencies: FramedOutputDependencies) {}

	receive(output: Piece[]): void {
		for (const piece of output) {
			if ('screen' in piece) {
				if (this.held.length === 0) this.dependencies.writeScreen(piece.screen);
				else this.held.push({piece, startsFrame: false});
				continue;
			}

			// The chunks of one upload belong to one frame, whatever comes between.
			const startsFrame = !this.isUploading && this.endsInScreen();
			if (startsFrame) this.markReady();
			this.isUploading = continuesUpload(piece.graphics);
			this.held.push({piece, startsFrame});
			this.cancelHold ??= this.dependencies.schedule(() => {
				this.markReady(true);
			}, MAX_FRAME_HOLD_MS);
		}

		if (this.held.length === 0) return;
		this.cancelQuiet?.();
		this.cancelQuiet = this.dependencies.schedule(() => {
			this.markReady(true);
		}, FRAME_QUIET_MS);
	}

	/** Gives the renderer's coming frame the first whole image frame. */
	flushFrame(): void {
		let index = 0;
		while (index < this.readyCount) {
			const {piece, startsFrame} = this.held[index]!;
			if (startsFrame && index > 0) break;
			if ('graphics' in piece) {
				if (!this.dependencies.writeGraphics(piece.graphics)) break;
			} else {
				this.dependencies.writeScreen(piece.screen);
			}

			index++;
		}

		this.held.splice(0, index);
		this.readyCount -= index;
		if (this.readyCount > 0) this.dependencies.requestFrame();
	}

	private endsInScreen(): boolean {
		const last = this.held.at(-1);
		return last !== undefined && 'screen' in last.piece;
	}

	private markReady(everything = false): void {
		if (everything) {
			this.cancelQuiet?.();
			this.cancelQuiet = undefined;
		}

		this.cancelHold?.();
		this.cancelHold = undefined;
		this.readyCount = this.held.length;
		if (this.readyCount > 0) this.dependencies.requestFrame();
	}
}

/** Whether a command is a chunk of an upload that more chunks follow. */
function continuesUpload(command: string): boolean {
	const keys = command.slice('\u001B_G'.length).split(';', 1)[0] ?? '';
	return keys.split(',').includes('m=1');
}
