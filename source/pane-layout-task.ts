import type {LatestTask} from './latest-task.ts';
import {startupTrace} from './startup-trace.ts';

export type PaneDimensions = {rows: number; cols: number};

export function syncTerminalDimensions(
	stdout: {rows: number; columns: number; emit: (event: string) => boolean},
	dimensions: PaneDimensions,
): void {
	if (stdout.columns === dimensions.cols && stdout.rows === dimensions.rows)
		return;
	// tmux can reply before the process handles SIGWINCH. The app's stdout
	// resize listeners must see the confirmed width before a dialog mounts, or
	// that frame is laid out at the old width.
	stdout.columns = dimensions.cols;
	stdout.rows = dimensions.rows;
	stdout.emit('resize');
}

/** Layout mutations finish before another attachment can use the pane IDs. */
export class PaneLayoutTask {
	private stateGeneration = 0;
	private readResizeDimensions?: () => PaneDimensions;
	private zoomed = false;
	private revision = 0;
	private pending = false;
	private stopped = false;
	private running?: Promise<void>;

	constructor(
		private readonly deps: {
			queue: Pick<LatestTask, 'exclusive'>;
			apply: (zoomed: boolean) => Promise<PaneDimensions>;
			onReady: (
				zoomed: boolean,
				dimensions: PaneDimensions,
				revision: number,
			) => void;
			onError: (error: unknown, revision: number) => void;
		},
	) {}

	async request(
		zoomed: boolean,
		revision = 0,
		readResizeDimensions?: () => PaneDimensions,
	): Promise<void> {
		if (this.stopped) return;
		if (!readResizeDimensions) this.stateGeneration++;
		this.readResizeDimensions = readResizeDimensions;
		this.zoomed = zoomed;
		this.revision = revision;
		this.pending = true;
		this.running ??= Promise.resolve().then(async () => {
			try {
				while (this.pending && !this.stopped) {
					const queued = startupTrace.current?.begin('layout-queue');
					await this.deps.queue.exclusive(async () => {
						queued?.();
						// Requests that arrive while this callback waits behind an
						// attachment are covered by the state read here.
						this.pending = false;
						if (this.stopped) return;
						const {zoomed, revision, stateGeneration} = this;
						const done = startupTrace.current?.begin('layout-pass', {
							zoomed,
							revision,
						});
						try {
							const dimensions = await this.deps.apply(zoomed);
							const observed = this.pending
								? this.readResizeDimensions?.()
								: undefined;
							if (
								!this.stopped &&
								stateGeneration === this.stateGeneration &&
								zoomed === this.zoomed &&
								revision === this.revision &&
								(!this.pending ||
									(observed?.cols === dimensions.cols &&
										observed.rows === dimensions.rows))
							)
								this.deps.onReady(zoomed, dimensions, revision);
							done?.(this.stopped ? 'cancelled' : 'ok');
						} catch (error) {
							done?.('failed');
							if (!this.stopped) this.deps.onError(error, revision);
						}
					});
				}
			} finally {
				this.running = undefined;
			}
		});
		await this.running;
	}

	stop(): void {
		this.stopped = true;
	}
}
