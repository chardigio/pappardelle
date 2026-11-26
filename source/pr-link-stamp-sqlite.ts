// The pr-link stamp as a row.

import {createLogger} from './logger.ts';
import type {PrLinkStampDao} from './pr-link-stamp.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

const log = createLogger('pr-link-stamp');

export class SqlitePrLinkStampDao implements PrLinkStampDao {
	private readonly reads = new GuardedReads(log, 'the pr-link stamp');

	constructor(
		private readonly openDb: () => StateDb,
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
