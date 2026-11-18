// Kitty graphics commands a pane's program sends reach the real terminal
// through this frame. When the frame is itself a pane of tmux, each tmux
// above it takes a raw command for a pane title, so the command is wrapped in
// tmux's passthrough sequence once for each of them.

/** The image ID of the renderer's own Kitty graphics query. */
const RENDERER_QUERY_ID = 31_337;
const FIRST_PROBE_ID = 31_340;
const MAX_PROBED_DEPTH = 3;
const PROBE_TIMEOUT_MS = 1000;
// tmux drops a passthrough sequence longer than its input buffer, 1 MiB by
// default.
const MAX_PASSTHROUGH = 512 * 1024;

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
		private readonly maxWrite = MAX_PASSTHROUGH,
	) {
		this.depth = isInTmux ? undefined : 0;
	}

	/**
	 * Sends commands in as few writes as fit. tmux passes on each passthrough
	 * sequence whole, so the chunks of an upload sent in one cannot be mixed
	 * with another pane's, which would leave both images broken. Returns false
	 * when the commands could not be taken yet.
	 */
	forward(...commands: string[]): boolean {
		if (this.depth === undefined) {
			this.pending.push(...commands);
			return true;
		}

		let batch = '';
		for (const command of commands) {
			if (batch && batch.length + command.length > this.maxWrite) {
				if (!this.write(wrapForTmux(batch, this.depth))) return false;
				batch = '';
			}

			batch += command;
		}

		return !batch || this.write(wrapForTmux(batch, this.depth));
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
		this.forward(...pending);
	}
}

type Piece = {screen: Uint8Array} | {graphics: string};
// A held piece, and whether it begins the program's next image frame.
type Held = {piece: Piece; startsFrame: boolean};

export type FramedOutputDependencies = {
	writeScreen(bytes: Uint8Array): void;
	/**
	 * Queues an image frame's commands ahead of the renderer's next frame, each
	 * with what the program wrote after it in the frame; false when the output
	 * is full.
	 */
	writeGraphics(
		commands: Array<{command: string; laterScreen: Uint8Array[]}>,
	): boolean;
	requestFrame(): void;
	schedule(callback: () => void, ms: number): () => void;
};

// The rest of an image's frame follows its upload within a read or two, so
// output that stops for this long has finished the frame.
const FRAME_QUIET_MS = 4;
// A program that never pauses still has its output shown this often.
const MAX_FRAME_HOLD_MS = 50;
// An upload whose last chunk has not come by then is not waited for.
const MAX_UPLOAD_MS = 1000;

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
	// Where the upload whose last chunk has not come yet starts in `held`.
	private uploadStart: number | undefined;
	private cancelUpload: (() => void) | undefined;
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
			this.trackUpload(continuesUpload(piece.graphics));
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
		if (this.readyCount === 0) return;
		let end = 1;
		while (end < this.readyCount && !this.held[end]!.startsFrame) end++;
		const frame = this.held.slice(0, end).map(({piece}) => piece);

		const commands = frame.flatMap((piece, index) =>
			'graphics' in piece
				? [
						{
							command: piece.graphics,
							laterScreen: frame
								.slice(index + 1)
								.flatMap(later => ('screen' in later ? [later.screen] : [])),
						},
					]
				: [],
		);
		if (commands.length > 0 && !this.dependencies.writeGraphics(commands)) {
			this.dependencies.requestFrame();
			return;
		}

		for (const piece of frame)
			if ('screen' in piece) this.dependencies.writeScreen(piece.screen);
		this.held.splice(0, end);
		this.readyCount -= end;
		if (this.uploadStart !== undefined) this.uploadStart -= end;
		if (this.readyCount > 0) this.dependencies.requestFrame();
	}

	/**
	 * An upload is sent whole, in one passthrough sequence, so its first
	 * chunks are not given to the renderer until its last has come.
	 */
	private trackUpload(continues: boolean): void {
		if (continues && !this.isUploading) {
			this.uploadStart = this.held.length;
			this.cancelUpload = this.dependencies.schedule(() => {
				this.trackUpload(false);
				this.markReady(true);
			}, MAX_UPLOAD_MS);
		} else if (!continues && this.isUploading) {
			this.uploadStart = undefined;
			this.cancelUpload?.();
			this.cancelUpload = undefined;
		}

		this.isUploading = continues;
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
		this.readyCount = this.uploadStart ?? this.held.length;
		if (this.readyCount > 0) this.dependencies.requestFrame();
	}
}

/** Whether a command is a chunk of an upload that more chunks follow. */
function continuesUpload(command: string): boolean {
	const keys = command.slice('\u001B_G'.length).split(';', 1)[0] ?? '';
	return keys.split(',').includes('m=1');
}
