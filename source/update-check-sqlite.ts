// The update check's cached answer as a row, with update-check.json kept
// beside it.
//
// The benchmarks and the compiled-binary tests write that file before they
// start Pappardelle so that it makes no network call. A file written that
// way is imported when it is read.

import {createLogger} from './logger.ts';
import type {JsonMirror, StateDb} from './state-db.ts';
import {
	parseCachedCheck,
	renderCachedCheck,
	type CacheEntry,
	type UpdateCheckDao,
} from './update-check.ts';

const log = createLogger('update-check');

export class SqliteUpdateCheckDao implements UpdateCheckDao {
	private readonly mirror: JsonMirror;

	constructor(
		private readonly openDb: () => StateDb,
		file: string,
	) {
		this.mirror = {
			file,
			importRows: content => {
				// A file that is gone or unreadable means nothing is cached,
				// as it does to a process that reads the file.
				const entry = content === null ? null : parseCachedCheck(content);
				if (entry) this.put(entry);
				else this.openDb().db.run('DELETE FROM update_check');
			},
		};
	}

	read(): CacheEntry | null {
		try {
			this.openDb().sync(this.mirror);
			const row = this.openDb()
				.db.query<
					{checked_at: number; latest_version: string},
					[]
				>('SELECT checked_at, latest_version FROM update_check WHERE id = 1')
				.get();
			return (
				row && {checkedAt: row.checked_at, latestVersion: row.latest_version}
			);
		} catch (error) {
			log.warn(
				'Could not read the update check from the state database',
				error instanceof Error ? error : undefined,
			);
			return null;
		}
	}

	async write(entry: CacheEntry): Promise<void> {
		try {
			await this.openDb().write(tx => {
				this.put(entry);
				tx.mirror(this.mirror.file, renderCachedCheck(entry));
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
