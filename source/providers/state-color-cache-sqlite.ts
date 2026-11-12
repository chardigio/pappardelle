// Workflow state colors as rows, with the cache file kept beside them.
//
// A process rewrites the file whole from the colors it remembers, so two
// Pappardelles that each learn a color lose the other's. With a row per
// state, each writes only the color it learned.

import {createLogger} from '../logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from '../state-db.ts';
import {
	parseStateColors,
	renderStateColors,
	type StateColorDao,
} from './state-color-cache.ts';

const log = createLogger('state-colors');

type ColorRow = {name: string; color: string};

export class SqliteStateColorDao implements StateColorDao {
	private readonly mirror: JsonMirror;
	private readonly reads = new GuardedReads(log, 'workflow state colors');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly file: string,
	) {
		this.mirror = {
			file,
			importRows: content => {
				// A cache file that is gone says nothing about the rows.
				if (content !== null) this.replace(parseStateColors(content));
			},
		};
	}

	load(): Record<string, string> {
		// Colors that cannot be read are re-discovered on the next issue fetch.
		return this.reads.or({}, () => {
			this.openDb().sync(this.mirror);
			return Object.fromEntries(this.colors());
		});
	}

	async set(name: string, color: string): Promise<void> {
		await this.openDb().write(tx => {
			tx.sync(this.mirror);
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
			tx.mirror(this.file, renderStateColors(this.colors()));
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
