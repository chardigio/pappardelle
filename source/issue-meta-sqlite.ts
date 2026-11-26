// Issue metadata as rows.

import path from 'node:path';
import {createLogger} from './logger.ts';
import {
	createdNow,
	parseIssueMeta,
	type IssueMeta,
	type IssueMetaDao,
} from './issue-meta.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';

const log = createLogger('issue-meta');

type MetaRow = {created_by_pappardelle: 0 | 1; created_at: string};

export class SqliteIssueMetaDao implements IssueMetaDao {
	private readonly reads = new GuardedReads(log, 'issue metadata');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		/** Where each issue's JSON file was, for the one-time import. */
		private readonly jsonDir: string,
		private readonly clock: () => Date,
	) {}

	jsonMirrors(): JsonMirror[] {
		return this.openDb()
			.jsonKeysIn(this.jsonDir, '.json')
			.map(key => this.mirror(key));
	}

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

	private mirror(key: string): JsonMirror {
		return {
			file: path.join(this.jsonDir, `${key}.json`),
			importRows: content => {
				if (content === null) {
					this.openDb()
						.db.query('DELETE FROM issue_meta WHERE repo = ? AND key = ?')
						.run(this.repo, key);
				} else {
					this.put(key, parseIssueMeta(content));
				}
			},
		};
	}

	private put(key: string, meta: IssueMeta): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO issue_meta
					(repo, key, created_by_pappardelle, created_at)
				VALUES (?, ?, ?, ?)`,
			)
			.run(this.repo, key, meta.createdByPappardelle ? 1 : 0, meta.createdAt);
	}
}
