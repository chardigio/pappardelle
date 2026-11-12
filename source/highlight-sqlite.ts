// Highlight requests as rows, with the target file kept beside each.
//
// The file only holds the key that was asked for, so its watcher acts on
// every write. A row also holds when it was asked for, which is how a watcher
// of the database tells a second request for the same key from one it has
// already acted on.

import {watchFileContent} from './file-watch.ts';
import {
	highlightWriteCommand,
	parseHighlightTarget,
	renderHighlightTarget,
	type HighlightDao,
	type HighlightRequest,
} from './highlight.ts';
import type {JsonMirror, StateDb} from './state-db.ts';
import {onStateDbChange} from './state-db-watch.ts';

type TargetRow = {key: string; focus: number; requested_at: number};

export class SqliteHighlightDao implements HighlightDao {
	private readonly mirror: JsonMirror;

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly file: string,
		private readonly clock: () => Date,
	) {
		this.mirror = {
			file,
			importRows: content => {
				// A file that changed is a request from a process without the
				// database. One that is gone or empty asks for nothing, as it
				// does for a process that watches the file.
				const request = content ? parseHighlightTarget(content) : null;
				if (request) this.put(request);
				else this.delete();
			},
		};
	}

	async request(request: HighlightRequest): Promise<void> {
		await this.openDb().write(tx => {
			this.put(request);
			tx.mirror(this.file, renderHighlightTarget(request));
		});
	}

	shellRequest(request: HighlightRequest): string {
		return highlightWriteCommand(this.file, request);
	}

	watch(listener: (request: HighlightRequest) => void): () => void {
		let seen = this.target()?.requested_at;
		const check = () => {
			const target = this.target();
			const isNew = target !== null && target.requested_at !== seen;
			seen = target?.requested_at;
			if (isNew) listener({issueKey: target.key, focus: target.focus === 1});
		};

		const unwatchRows = onStateDbChange(this.openDb().path, check);
		// The sous-chef key's shell line writes the file and commits nothing,
		// so the database's bell never rings for it.
		const unwatchFile = watchFileContent(this.file, check);
		return () => {
			unwatchRows();
			unwatchFile();
		};
	}

	async clear(): Promise<void> {
		await this.openDb().write(tx => {
			this.delete();
			tx.mirror(this.file, null);
		});
	}

	private target(): TargetRow | null {
		this.openDb().sync(this.mirror);
		return this.row();
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
