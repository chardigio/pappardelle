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
		private readonly write: (sequence: string) => void,
		private readonly isInTmux: boolean,
	) {
		this.depth = isInTmux ? undefined : 0;
	}

	forward(command: string): void {
		if (this.depth === undefined) this.pending.push(command);
		else this.write(wrapForTmux(command, this.depth));
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
