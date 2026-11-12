// The TUI's ready marker as a row, with tui.json kept beside it.
//
// A marker written by a TUI that runs without the database is imported the
// next time it is read, which is how `pappardelle restart` from a build with
// the database still sees a TUI without it come up.

import {createLogger} from './logger.ts';
import type {JsonMirror, StateDb} from './state-db.ts';
import {
	parseTuiMarker,
	renderTuiMarker,
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
	private readonly mirror: JsonMirror;
	private reportedUnreadable = false;

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		file: string,
	) {
		this.mirror = {
			file,
			importRows: content => {
				// A file that is gone or is not a marker says no TUI has
				// reported, as it does to a process that reads the file.
				const marker = content === null ? null : parseTuiMarker(content);
				if (marker) this.put(marker);
				else this.delete();
			},
		};
	}

	read(): TuiMarker | null {
		try {
			this.openDb().sync(this.mirror);
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
		} catch (error) {
			if (!this.reportedUnreadable) {
				this.reportedUnreadable = true;
				log.warn(
					'Could not read the TUI marker from the state database',
					error instanceof Error ? error : undefined,
				);
			}

			return null;
		}
	}

	async write(marker: TuiMarker): Promise<void> {
		await this.openDb().write(tx => {
			this.put(marker);
			tx.mirror(this.mirror.file, renderTuiMarker(marker));
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
