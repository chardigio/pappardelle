// Issue metadata as rows.

import {createLogger} from './logger.ts';
import {createdNow, type IssueMeta, type IssueMetaDao} from './issue-meta.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('issue-meta');

type MetaRow = {created_by_pappardelle: 0 | 1; created_at: string};

export class SqliteIssueMetaDao implements IssueMetaDao {
	private readonly reads = new GuardedReads(log, 'issue metadata');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly clock: () => Date,
	) {}

	read(key: string): IssueMeta | null {
		return this.reads.or(null, () => {
			const row = this.openDb()
				.db.query<MetaRow, [string, string]>(
					`SELECT created_by_pappardelle, created_at FROM issue_meta
					WHERE repo = ? AND key = ?`,
				)
				.get(this.repo, key);
			return row
				? {
						createdByPappardelle: row.created_by_pappardelle === 1,
						createdAt: row.created_at,
					}
				: null;
		});
	}

	async markCreated(key: string): Promise<void> {
		const meta = createdNow(this.clock);
		await this.openDb().write(() => {
			this.put(key, meta);
		});
	}

	/** For a caller inside a write transaction. */
	put(key: string, meta: IssueMeta): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO issue_meta
					(repo, key, created_by_pappardelle, created_at)
				VALUES (?, ?, ?, ?)`,
			)
			.run(this.repo, key, meta.createdByPappardelle ? 1 : 0, meta.createdAt);
	}

	/** For a caller inside a write transaction. */
	deleteRow(key: string): void {
		this.openDb()
			.db.query('DELETE FROM issue_meta WHERE repo = ? AND key = ?')
			.run(this.repo, key);
	}
}
