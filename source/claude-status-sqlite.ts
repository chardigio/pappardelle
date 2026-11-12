// Claude hook statuses as rows, with each status file kept beside its row.
//
// The hook writes a file and its row in one transaction. A file written
// without the database (the flag was off for that agent, or the database was
// busy when its hook ran) is imported the next time its key is read.

import {isDeepStrictEqual} from 'node:util';
import {
	hookStatusKey,
	parseSessionState,
	renderSessionState,
	sessionState,
	statusInfo,
	type ClaudeSessionState,
	type ClaudeStatus,
	type ClaudeStatusDao,
	type ClaudeStatusInfo,
	type JsonClaudeStatusDao,
	type StoredClaudeStatus,
} from './claude-status.ts';
import {createLogger} from './logger.ts';
import type {JsonMirror, StateDb} from './state-db.ts';
import {onStateDbChange, waitForStateDbChange} from './state-db-watch.ts';

const log = createLogger('claude-status');

type StatusRow = {
	status_key: string;
	session_id: string;
	workspace_name: string;
	status: ClaudeStatus;
	last_update: number;
	current_tool: string | null;
	event: string | null;
	cwd: string | null;
};

const COLUMNS =
	'status_key, session_id, workspace_name, status, last_update, current_tool, event, cwd';

function toRow(statusKey: string, state: ClaudeSessionState): StatusRow {
	return {
		status_key: statusKey,
		session_id: state.sessionId,
		workspace_name: state.workspaceName,
		status: state.status,
		last_update: state.lastUpdate,
		current_tool: state.currentTool ?? null,
		event: state.event ?? null,
		cwd: state.cwd ?? null,
	};
}

function toState(row: StatusRow): ClaudeSessionState {
	return sessionState(
		{
			sessionId: row.session_id,
			workspaceName: row.workspace_name,
			status: row.status,
			lastUpdate: row.last_update,
		},
		{
			currentTool: row.current_tool ?? undefined,
			event: row.event ?? undefined,
			cwd: row.cwd ?? undefined,
		},
	);
}

export class SqliteClaudeStatusDao implements ClaudeStatusDao {
	private reportedUnreadable = false;

	constructor(
		private readonly openDb: () => StateDb,
		private readonly json: JsonClaudeStatusDao,
	) {}

	readableKey(repoName: string, name: string): string {
		const qualified = hookStatusKey(repoName, name);
		if (this.readState(qualified).kind === 'state') return qualified;
		return this.readState(name).kind === 'state' ? name : qualified;
	}

	async read(statusKey: string): Promise<ClaudeStatusInfo | null> {
		const stored = this.readState(statusKey);
		if (stored.kind === 'unreadable') return null;
		return stored.kind === 'state'
			? statusInfo(stored.state)
			: {status: 'unknown'};
	}

	readState(statusKey: string): StoredClaudeStatus {
		try {
			const synced = this.openDb().sync(this.mirror(statusKey));
			const row = this.row(statusKey);
			if (row) return {kind: 'state', state: toState(row)};
			return synced === 'malformed' ? {kind: 'unreadable'} : {kind: 'none'};
		} catch (error) {
			if (!this.reportedUnreadable) {
				this.reportedUnreadable = true;
				log.warn(
					'Could not read Claude statuses from the state database',
					error instanceof Error ? error : undefined,
				);
			}

			return {kind: 'unreadable'};
		}
	}

	async write(state: ClaudeSessionState): Promise<void> {
		const statusKey = state.workspaceName;
		const mirror = this.mirror(statusKey);
		const next = toRow(statusKey, state);
		await this.openDb().write(tx => {
			tx.sync(mirror);
			if (isDeepStrictEqual(this.row(statusKey), next)) return;
			this.upsert(next);
			tx.mirror(mirror.file, renderSessionState(state));
		});
	}

	watch(listener: (statusKey: string) => void): () => void {
		let known = this.snapshot();
		return onStateDbChange(this.openDb().path, () => {
			const current = this.snapshot();
			for (const statusKey of new Set([...known.keys(), ...current.keys()])) {
				if (known.get(statusKey) !== current.get(statusKey))
					listener(statusKey);
			}

			known = current;
		});
	}

	async waitForChange(ms: number): Promise<void> {
		await waitForStateDbChange(this.openDb().path, ms);
	}

	private mirror(statusKey: string): JsonMirror {
		return {
			file: this.json.file(statusKey),
			importRows: content => {
				// A removed status file takes its record with it, as it does for
				// a process that reads the files.
				if (content === null) this.delete(statusKey);
				else this.upsert(toRow(statusKey, parseSessionState(content)));
			},
		};
	}

	/** Every record, each as one comparable string. */
	private snapshot(): Map<string, string> {
		const rows = this.openDb()
			.db.query<StatusRow, []>(`SELECT ${COLUMNS} FROM claude_status`)
			.all();
		return new Map(rows.map(row => [row.status_key, JSON.stringify(row)]));
	}

	private row(statusKey: string): StatusRow | null {
		return this.openDb()
			.db.query<
				StatusRow,
				[string]
			>(`SELECT ${COLUMNS} FROM claude_status WHERE status_key = ?`)
			.get(statusKey);
	}

	private upsert(row: StatusRow): void {
		this.openDb()
			.db.query(
				`INSERT OR REPLACE INTO claude_status (${COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.status_key,
				row.session_id,
				row.workspace_name,
				row.status,
				row.last_update,
				row.current_tool,
				row.event,
				row.cwd,
			);
	}

	private delete(statusKey: string): void {
		this.openDb()
			.db.query('DELETE FROM claude_status WHERE status_key = ?')
			.run(statusKey);
	}
}
