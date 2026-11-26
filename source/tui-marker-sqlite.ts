// The TUI's ready marker as a row.

import {createLogger} from './logger.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';
import {
	parseTuiMarker,
	type TuiMarker,
	type TuiMarkerDao,
} from './tui-marker.ts';

const log = createLogger('tui-marker');

type MarkerRow = {
	pid: number;
	cli_path: string;
	sha: string;
	pane_id: string;
	started_at: number;
};

export class SqliteTuiMarkerDao implements TuiMarkerDao {
	private readonly reads = new GuardedReads(log, 'the TUI marker');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		/** Where tui.json was, for the one-time import. */
		private readonly jsonFile: string,
	) {}

	jsonMirrors(): JsonMirror[] {
		return [
			{
				file: this.jsonFile,
				importRows: content => {
					if (content === null) {
						this.delete();
						return;
					}

					const marker = parseTuiMarker(content);
					if (!marker) throw new Error('Not a TUI marker');
					this.put(marker);
				},
			},
		];
	}

	read(): TuiMarker | null {
		return this.reads.or(null, () => {
			const row = this.openDb()
				.db.query<
					MarkerRow,
					[string]
				>('SELECT pid, cli_path, sha, pane_id, started_at FROM tui_markers WHERE repo = ?')
				.get(this.repo);
			return (
				row && {
					pid: row.pid,
					cliPath: row.cli_path,
					sha: row.sha,
					paneId: row.pane_id,
					startedAt: row.started_at,
				}
			);
		});
	}

	async write(marker: TuiMarker): Promise<void> {
		await this.openDb().write(() => {
			this.put(marker);
		});
	}

	private put(marker: TuiMarker): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO tui_markers
					(repo, pid, cli_path, sha, pane_id, started_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.repo,
				marker.pid,
				marker.cliPath,
				marker.sha,
				marker.paneId,
				marker.startedAt,
			);
	}

	private delete(): void {
		this.openDb()
			.db.query('DELETE FROM tui_markers WHERE repo = ?')
			.run(this.repo);
	}
}
