// The update check's cached answer as a row.

import {createLogger} from './logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';
import {
	parseCachedCheck,
	type CacheEntry,
	type UpdateCheckDao,
} from './update-check.ts';

const log = createLogger('update-check');

export class SqliteUpdateCheckDao implements UpdateCheckDao {
	private readonly reads = new GuardedReads(log, 'the update check');

	constructor(
		private readonly openDb: () => StateDb,
		/** Where update-check.json was, for the one-time import. */
		private readonly jsonFile: string,
	) {}

	jsonMirrors(): JsonMirror[] {
		return [
			{
				file: this.jsonFile,
				importRows: content => {
					if (content === null) {
						this.openDb().db.run('DELETE FROM update_check');
						return;
					}

					const entry = parseCachedCheck(content);
					if (!entry) throw new Error('Not an update check');
					this.put(entry);
				},
			},
		];
	}

	read(): CacheEntry | null {
		return this.reads.or(null, () => {
			const row = this.openDb()
				.db.query<
					{checked_at: number; latest_version: string},
					[]
				>('SELECT checked_at, latest_version FROM update_check WHERE id = 1')
				.get();
			return (
				row && {checkedAt: row.checked_at, latestVersion: row.latest_version}
			);
		});
	}

	async write(entry: CacheEntry): Promise<void> {
		try {
			await this.openDb().write(() => {
				this.put(entry);
			});
		} catch (error) {
			log.warn(
				'Failed to write update-check cache',
				error instanceof Error ? error : undefined,
			);
		}
	}

	private put(entry: CacheEntry): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO update_check (id, checked_at, latest_version)
				VALUES (1, ?, ?)`,
			)
			.run(entry.checkedAt, entry.latestVersion);
	}
}
