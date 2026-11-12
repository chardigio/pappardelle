// Issue metadata as rows, with each issue's file kept beside its row.

import {createLogger} from './logger.ts';
import {
	createdNow,
	parseIssueMeta,
	renderIssueMeta,
	type IssueMeta,
	type IssueMetaDao,
	type JsonIssueMetaDao,
} from './issue-meta.ts';
import type {JsonMirror, StateDb} from './state-db.ts';

const log = createLogger('issue-meta');

type MetaRow = {created_by_pappardelle: 0 | 1; created_at: string};

export class SqliteIssueMetaDao implements IssueMetaDao {
	private reportedUnreadable = false;

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonIssueMetaDao,
		private readonly clock: () => Date,
	) {}

	read(key: string): IssueMeta | null {
		try {
			this.openDb().sync(this.mirror(key));
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
		} catch (error) {
			if (!this.reportedUnreadable) {
				this.reportedUnreadable = true;
				log.warn(
					'Could not read issue metadata from the state database',
					error instanceof Error ? error : undefined,
				);
			}

			return null;
		}
	}

	async markCreated(key: string): Promise<void> {
		const mirror = this.mirror(key);
		const meta = createdNow(this.clock);
		await this.openDb().write(tx => {
			tx.sync(mirror);
			this.put(key, meta);
			tx.mirror(mirror.file, renderIssueMeta(meta));
		});
	}

	private mirror(key: string): JsonMirror {
		return {
			file: this.json.file(key),
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
