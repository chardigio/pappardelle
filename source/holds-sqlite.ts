// Holds as rows.

import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {parseHold, type Hold, type HoldDao, type HoldState} from './holds.ts';
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
		/** Where each hold's JSON file was, for the one-time import. */
		private readonly jsonDir: string,
	) {}

	jsonMirrors(): JsonMirror[] {
		return this.openDb()
			.jsonKeysIn(this.jsonDir, '.json')
			.map(id => this.mirror(id));
	}

	async save(hold: Hold): Promise<void> {
		await this.openDb().write(() => {
			if (isDeepStrictEqual(this.row(hold.id), hold)) return;
			this.put(hold);
		});
	}

	load(id: string): Hold | null {
		return this.reads.or(null, () => this.row(id));
	}

	list(): Hold[] {
		return this.reads.or([], () => {
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
			file: path.join(this.jsonDir, `${id}.json`),
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
