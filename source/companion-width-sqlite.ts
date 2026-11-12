// Companion widths and layout requests as rows, with their files kept beside
// them.
//
// A request is a row the CLI inserts and the TUI answers by updating it. The
// TUI hears of new rows through the state database's change notice, so it
// needs no directory watch, and its answer only lands while the row is there.

import {
	parseCompanionWidths,
	renderCompanionWidths,
	type CompanionRequestDao,
	type CompanionWidthDao,
	type JsonCompanionRequestDao,
	type JsonCompanionWidthDao,
	type LayoutAck,
	type LayoutRequest,
} from './companion-width.ts';
import type {PaneWidth} from './layout-sizing.ts';
import {createLogger} from './logger.ts';
import {
	GuardedReads,
	retryBusy,
	type JsonMirror,
	type StateDb,
} from './state-db.ts';
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
	private readonly mirror: JsonMirror;
	private readonly reads = new GuardedReads(log, 'companion widths');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonCompanionWidthDao,
	) {
		this.mirror = {
			file: json.file,
			importRows: content => {
				// A store file that is gone says nothing about the rows.
				if (content === null) return;
				this.openDb()
					.db.query('DELETE FROM companion_widths WHERE repo = ?')
					.run(this.repo);
				for (const [key, width] of Object.entries(
					parseCompanionWidths(content),
				))
					this.insert(key, width);
			},
		};
	}

	all(): Record<string, PaneWidth> {
		// The companion takes its configured width until this can be read.
		return this.reads.or({}, () => {
			this.openDb().sync(this.mirror);
			return this.stored();
		});
	}

	get(spaceKey: string): PaneWidth | null {
		return this.all()[spaceKey] ?? null;
	}

	/**
	 * Processes without the database serialize on the store's file lock and
	 * rewrite the file whole, so the transaction holds that lock too: a write
	 * of theirs cannot land between this one's import and its rewrite.
	 */
	async set(spaceKey: string, width: PaneWidth | null): Promise<void> {
		await retryBusy(async () =>
			this.json.locked(() =>
				this.openDb().tryWrite(tx => {
					tx.sync(this.mirror);
					// Removed and added again, which puts a changed space last,
					// where a process rewriting the file puts it.
					this.openDb()
						.db.query('DELETE FROM companion_widths WHERE repo = ? AND key = ?')
						.run(this.repo, spaceKey);
					if (width !== null) this.insert(spaceKey, width);
					tx.mirror(this.json.file, renderCompanionWidths(this.stored()));
				}),
			),
		);
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
		private readonly json: JsonCompanionRequestDao,
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
			this.json.writeRequest(request);
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
			this.json.remove(id);
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
			const {changes} = this.openDb()
				.db.query(
					`UPDATE companion_requests SET ack_result = ?, ack_columns = ?
					WHERE repo = ? AND id = ?`,
				)
				.run(ack.result, ack.columns ?? null, this.repo, ack.id);
			if (changes > 0) this.json.writeAck(ack);
		});
	}
}
