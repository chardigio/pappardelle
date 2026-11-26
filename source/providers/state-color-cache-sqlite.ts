// Workflow state colors as rows: one per state, so two Pappardelles that
// each learn a color keep both.

import {createLogger} from '../logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from '../state-db.ts';
import {parseStateColors, type StateColorDao} from './state-color-cache.ts';

const log = createLogger('state-colors');

type ColorRow = {name: string; color: string};

export class SqliteStateColorDao implements StateColorDao {
	private readonly reads = new GuardedReads(log, 'workflow state colors');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		/** Where the colors' JSON file was, for the one-time import. */
		private readonly jsonFile: string,
	) {}

	jsonMirrors(): JsonMirror[] {
		return [
			{
				file: this.jsonFile,
				importRows: content => {
					if (content !== null) this.replace(parseStateColors(content));
				},
			},
		];
	}

	load(): Record<string, string> {
		// Colors that cannot be read are re-discovered on the next issue fetch.
		return this.reads.or({}, () => Object.fromEntries(this.colors()));
	}

	async set(name: string, color: string): Promise<void> {
		await this.openDb().write(() => {
			const {db} = this.openDb();
			const stored = db
				.query<
					ColorRow,
					[string, string]
				>('SELECT name, color FROM state_colors WHERE repo = ? AND name = ?')
				.get(this.repo, name);
			if (stored?.color === color) return;
			db.query(
				`INSERT INTO state_colors (repo, name, color) VALUES (?, ?, ?)
				ON CONFLICT (repo, name) DO UPDATE SET color = excluded.color`,
			).run(this.repo, name, color);
		});
	}

	private colors(): Array<[string, string]> {
		return this.openDb()
			.db.query<ColorRow, [string]>(
				'SELECT name, color FROM state_colors WHERE repo = ? ORDER BY rowid',
			)
			.all(this.repo)
			.map(row => [row.name, row.color]);
	}

	private replace(colors: Map<string, string>): void {
		const {db} = this.openDb();
		db.query('DELETE FROM state_colors WHERE repo = ?').run(this.repo);
		const insert = db.query(
			'INSERT INTO state_colors (repo, name, color) VALUES (?, ?, ?)',
		);
		for (const [name, color] of colors) insert.run(this.repo, name, color);
	}
}
