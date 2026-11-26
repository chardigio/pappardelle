// Companion widths and layout requests as rows.
//
// A request is a row the CLI inserts and the TUI answers by updating it. The
// TUI hears of new rows through the state database's change notice, so it
// needs no directory watch, and its answer only lands while the row is there.

import type {
	CompanionRequestDao,
	CompanionWidthDao,
	LayoutAck,
	LayoutRequest,
} from './companion-width.ts';
import type {PaneWidth} from './layout-sizing.ts';
import {createLogger} from './logger.ts';
import {GuardedReads, type StateDb} from './state-db.ts';
import {onStateDbChange} from './state-db-watch.ts';

const log = createLogger('companion-width');

type WidthRow = {
	key: string;
	cells: number | null;
	percent: `${number}%` | null;
};

function toWidth(row: WidthRow): PaneWidth {
	return row.cells ?? row.percent!;
}

export class SqliteCompanionWidthDao implements CompanionWidthDao {
	private readonly reads = new GuardedReads(log, 'companion widths');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
	) {}

	all(): Record<string, PaneWidth> {
		// The companion takes its configured width until this can be read.
		return this.reads.or({}, () => this.stored());
	}

	get(spaceKey: string): PaneWidth | null {
		return this.all()[spaceKey] ?? null;
	}

	async set(spaceKey: string, width: PaneWidth | null): Promise<void> {
		await this.openDb().write(() => {
			this.openDb()
				.db.query('DELETE FROM companion_widths WHERE repo = ? AND key = ?')
				.run(this.repo, spaceKey);
			if (width !== null) this.insert(spaceKey, width);
		});
	}

	/** Replace every space's width. For a caller inside a write transaction. */
	replace(widths: Record<string, PaneWidth>): void {
		this.openDb()
			.db.query('DELETE FROM companion_widths WHERE repo = ?')
			.run(this.repo);
		for (const [key, width] of Object.entries(widths)) this.insert(key, width);
	}

	private stored(): Record<string, PaneWidth> {
		return Object.fromEntries(
			this.openDb()
				.db.query<WidthRow, [string]>(
					`SELECT key, cells, percent FROM companion_widths
					WHERE repo = ? ORDER BY rowid`,
				)
				.all(this.repo)
				.map(row => [row.key, toWidth(row)]),
		);
	}

	private insert(key: string, width: PaneWidth): void {
		this.openDb()
			.db.query(
				`INSERT INTO companion_widths (repo, key, cells, percent)
				VALUES (?, ?, ?, ?)`,
			)
			.run(
				this.repo,
				key,
				typeof width === 'number' ? width : null,
				typeof width === 'number' ? null : width,
			);
	}
}

type RequestRow = LayoutRequest & {asked: number};

type AckRow = {
	ack_result: LayoutAck['result'] | null;
	ack_columns: number | null;
};

export class SqliteCompanionRequestDao implements CompanionRequestDao {
	private readonly reads = new GuardedReads(log, 'companion requests');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly dbPath: string,
		private readonly repo: string,
	) {}

	async send(request: LayoutRequest): Promise<void> {
		await this.openDb().write(() => {
			// Asking again counts up, which is a change a watching TUI is told
			// of, and keeps an answer that arrived in the meantime.
			this.openDb()
				.db.query(
					`INSERT INTO companion_requests (repo, id, space, kind)
					VALUES (?, ?, ?, ?)
					ON CONFLICT (repo, id) DO UPDATE SET asked = asked + 1`,
				)
				.run(this.repo, request.id, request.space, request.kind);
		});
	}

	answerTo(id: string): LayoutAck | null {
		const row = this.reads.or(null, () =>
			this.openDb()
				.db.query<AckRow, [string, string]>(
					`SELECT ack_result, ack_columns FROM companion_requests
					WHERE repo = ? AND id = ?`,
				)
				.get(this.repo, id),
		);
		if (!row?.ack_result) return null;
		return {
			id,
			result: row.ack_result,
			...(row.ack_columns === null ? {} : {columns: row.ack_columns}),
		};
	}

	async withdraw(id: string): Promise<void> {
		await this.openDb().write(() => {
			this.openDb()
				.db.query('DELETE FROM companion_requests WHERE repo = ? AND id = ?')
				.run(this.repo, id);
		});
	}

	watch(onRequest: (request: LayoutRequest) => void): () => void {
		const timesAsked = () =>
			this.reads.or(
				undefined,
				() =>
					new Map(
						this.openDb()
							.db.query<RequestRow, [string]>(
								`SELECT id, space, kind, asked FROM companion_requests
								WHERE repo = ? AND ack_result IS NULL`,
							)
							.all(this.repo)
							.map(row => [row.id, row]),
					),
			);
		// A request is reported each time it is asked. One that was already
		// waiting at the first read that worked was left by a CLI that has
		// stopped waiting, unless it asks again.
		let reported = timesAsked();
		return onStateDbChange(this.dbPath, () => {
			const current = timesAsked();
			if (!current) return;
			if (reported) {
				for (const {asked, ...request} of current.values()) {
					if (reported.get(request.id)?.asked !== asked) onRequest(request);
				}
			}

			reported = current;
		});
	}

	async answer(ack: LayoutAck): Promise<void> {
		await this.openDb().write(() => {
			this.openDb()
				.db.query(
					`UPDATE companion_requests SET ack_result = ?, ack_columns = ?
					WHERE repo = ? AND id = ?`,
				)
				.run(ack.result, ack.columns ?? null, this.repo, ack.id);
		});
	}
}
