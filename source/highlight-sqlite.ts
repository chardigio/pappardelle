// Highlight requests as rows. A row holds when it was asked for, which is how
// a watcher tells a second request for the same key from one it has already
// acted on.

import type {HighlightDao, HighlightRequest} from './highlight.ts';
import {createLogger} from './logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';
import {onStateDbChange} from './state-db-watch.ts';

const log = createLogger('highlight');

type TargetRow = {key: string; focus: number; requested_at: number};

export class SqliteHighlightDao implements HighlightDao {
	private readonly reads = new GuardedReads(log, 'highlight requests');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly dbPath: string,
		private readonly repo: string,
		/** Where the highlight target file was, for the one-time import. */
		private readonly jsonFile: string,
		private readonly clock: () => Date,
	) {}

	jsonMirrors(): JsonMirror[] {
		return [
			{
				file: this.jsonFile,
				// A request left in the file was meant for a TUI that has since
				// stopped, so it is dropped rather than shown on the next start.
				importRows() {},
			},
		];
	}

	async request(request: HighlightRequest): Promise<void> {
		await this.openDb().write(() => {
			this.put(request);
		});
	}

	watch(listener: (request: HighlightRequest) => void): () => void {
		// Undefined until a read works. A request that read finds is not
		// reported, as one already there when the watch begins is not.
		let last = this.reads.or(undefined, () => this.row());
		const check = () => {
			const target = this.reads.or(undefined, () => this.row());
			if (target === undefined) return;
			const isNew =
				last !== undefined &&
				target !== null &&
				target.requested_at !== last?.requested_at;
			last = target;
			if (isNew) listener({issueKey: target.key, focus: target.focus === 1});
		};

		return onStateDbChange(this.dbPath, check);
	}

	async clear(): Promise<void> {
		await this.openDb().write(() => {
			this.delete();
		});
	}

	private row(): TargetRow | null {
		return this.openDb()
			.db.query<
				TargetRow,
				[string]
			>('SELECT key, focus, requested_at FROM highlight_targets WHERE repo = ?')
			.get(this.repo);
	}

	/**
	 * Record a request with a later time than the one it replaces, so that
	 * asking again within the clock's resolution, or after the clock was set
	 * back, is still a new request to whoever is watching.
	 */
	private put({issueKey, focus}: HighlightRequest): void {
		const previous = this.row()?.requested_at;
		const now = this.clock().getTime();
		const requestedAt =
			previous !== undefined && now <= previous ? previous + 1 : now;
		this.openDb()
			.db.query(
				`INSERT INTO highlight_targets (repo, key, focus, requested_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (repo) DO UPDATE SET key = excluded.key,
					focus = excluded.focus, requested_at = excluded.requested_at`,
			)
			.run(this.repo, issueKey, focus ? 1 : 0, requestedAt);
	}

	private delete(): void {
		this.openDb()
			.db.query('DELETE FROM highlight_targets WHERE repo = ?')
			.run(this.repo);
	}
}
