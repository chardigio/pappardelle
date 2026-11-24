// Holds as rows, with each one's file kept beside it, as the schedules are:
// a hold can be approved by a process started without the flag.

import {isDeepStrictEqual} from 'node:util';
import {
	parseHold,
	renderHold,
	type Hold,
	type HoldDao,
	type HoldState,
	type JsonHoldDao,
} from './holds.ts';
import {createLogger} from './logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';

const log = createLogger('holds');

type HoldRow = {
	id: string;
	key: string;
	tool: string;
	command: string;
	file_path: string | null;
	cwd: string | null;
	approvable: number;
	reason: string;
	state: HoldState;
	created_at: string;
	resolved_at: string | null;
};

const HOLD_COLUMNS =
	'id, key, tool, command, file_path, cwd, approvable, reason, state, created_at, resolved_at';

function toHold(row: HoldRow): Hold {
	return {
		id: row.id,
		key: row.key,
		tool: row.tool,
		command: row.command,
		filePath: row.file_path,
		cwd: row.cwd,
		approvable: row.approvable === 1,
		reason: row.reason,
		state: row.state,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at,
	};
}

export class SqliteHoldDao implements HoldDao {
	private readonly reads = new GuardedReads(log, 'holds');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonHoldDao,
	) {}

	async save(hold: Hold): Promise<void> {
		const mirror = this.mirror(hold.id);
		await this.openDb().write(tx => {
			tx.sync(mirror);
			if (isDeepStrictEqual(this.row(hold.id), hold)) return;
			this.put(hold);
			tx.mirror(mirror.file, renderHold(hold));
		});
	}

	load(id: string): Hold | null {
		return this.reads.or(null, () => {
			this.openDb().sync(this.mirror(id));
			return this.row(id);
		});
	}

	list(): Hold[] {
		return this.reads.or([], () => {
			for (const id of new Set([...this.json.ids(), ...this.storedIds()]))
				this.openDb().sync(this.mirror(id));
			return this.openDb()
				.db.query<HoldRow, [string]>(
					`SELECT ${HOLD_COLUMNS} FROM holds WHERE repo = ? ORDER BY created_at, id`,
				)
				.all(this.repo)
				.map(row => toHold(row));
		});
	}

	private mirror(id: string): JsonMirror {
		return {
			file: this.json.holdFile(id),
			importRows: content => {
				if (content === null) this.deleteRow(id);
				else this.put(parseHold(content));
			},
		};
	}

	private row(id: string): Hold | null {
		const row = this.openDb()
			.db.query<
				HoldRow,
				[string, string]
			>(`SELECT ${HOLD_COLUMNS} FROM holds WHERE repo = ? AND id = ?`)
			.get(this.repo, id);
		return row ? toHold(row) : null;
	}

	private storedIds(): string[] {
		return this.openDb()
			.db.query<{id: string}, [string]>('SELECT id FROM holds WHERE repo = ?')
			.all(this.repo)
			.map(row => row.id);
	}

	private put(hold: Hold): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO holds (repo, ${HOLD_COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.repo,
				hold.id,
				hold.key,
				hold.tool,
				hold.command,
				hold.filePath,
				hold.cwd,
				hold.approvable ? 1 : 0,
				hold.reason,
				hold.state,
				hold.createdAt,
				hold.resolvedAt,
			);
	}

	private deleteRow(id: string): void {
		this.openDb()
			.db.query('DELETE FROM holds WHERE repo = ? AND id = ?')
			.run(this.repo, id);
	}
}
