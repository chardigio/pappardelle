// The pr-link stamp as a row, with the stamp file still touched beside it.
//
// The rail reads the stamp on every lookup, so the read is the row alone:
// a stamp file touched by a process without the database is not looked at,
// and a rail waits out its backoff in that case.

import {createLogger} from './logger.ts';
import type {JsonPrLinkStampDao, PrLinkStampDao} from './pr-link-stamp.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('pr-link-stamp');

export class SqlitePrLinkStampDao implements PrLinkStampDao {
	private readonly reads = new GuardedReads(log, 'the pr-link stamp');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly json: JsonPrLinkStampDao,
		private readonly clock: () => Date,
	) {}

	async touch(): Promise<void> {
		await this.openDb().write(() => {
			this.openDb()
				.db.query(
					`INSERT INTO pr_link_stamp (id, touched_at) VALUES (1, ?)
					ON CONFLICT (id) DO UPDATE SET touched_at = excluded.touched_at`,
				)
				.run(this.clock().getTime());
			this.json.touchFile();
		});
	}

	read(): number {
		return this.reads.or(
			0,
			() =>
				this.openDb()
					.db.query<
						{touched_at: number},
						[]
					>('SELECT touched_at FROM pr_link_stamp WHERE id = 1')
					.get()?.touched_at ?? 0,
		);
	}
}
