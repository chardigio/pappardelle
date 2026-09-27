import type {LatestTask} from './latest-task.ts';

export type PaneDimensions = {rows: number; cols: number};

export function syncTerminalDimensions(
	stdout: {rows: number; columns: number; emit: (event: string) => boolean},
	dimensions: PaneDimensions,
): void {
	if (stdout.columns === dimensions.cols && stdout.rows === dimensions.rows)
		return;
	// tmux can reply before Node handles SIGWINCH. Ink must see the confirmed
	// root width before a dialog mounts, or it wraps that frame at the old width.
	stdout.columns = dimensions.cols;
	stdout.rows = dimensions.rows;
	stdout.emit('resize');
}

/** Layout mutations finish before another attachment can use the pane IDs. */
export class PaneLayoutTask {
	private generation = 0;
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
			onError: (error: unknown) => void;
		},
	) {}

	async request(zoomed: boolean, revision = 0): Promise<void> {
		if (this.stopped) return;
		this.zoomed = zoomed;
		this.revision = revision;
		this.generation++;
		this.pending = true;
		this.running ??= Promise.resolve().then(async () => {
			try {
				while (this.pending && !this.stopped) {
					await this.deps.queue.exclusive(async () => {
						// Requests that arrive while this callback waits behind an
						// attachment are covered by the state read here.
						this.pending = false;
						if (this.stopped) return;
						const {generation, zoomed, revision} = this;
						try {
							const dimensions = await this.deps.apply(zoomed);
							if (!this.stopped && generation === this.generation)
								this.deps.onReady(zoomed, dimensions, revision);
						} catch (error) {
							if (!this.stopped) this.deps.onError(error);
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
