// Agent sessions as rows, with each space's file kept beside them.
//
// The file has two writers: the agent's hook, which records a session id, and
// a config migration, which moves an id to a renamed agent profile. Each read
// the whole file and wrote it back, so one could undo the other. Here both
// do their read and write inside one write transaction.

import {createLogger} from './logger.ts';
import {
	latestStarted,
	parseAgentSessions,
	renderAgentSessions,
	type AgentSession,
	type AgentSessionsDao,
	type JsonAgentSessionsDao,
} from './space-state.ts';
import {GuardedReads, type JsonMirror, type StateDb} from './state-db.ts';

const log = createLogger('agent-sessions');

type SessionRow = {
	agent_profile: string;
	session_id: string;
	pid: number | null;
	started: string | null;
};

export class SqliteAgentSessionsDao implements AgentSessionsDao {
	private readonly reads = new GuardedReads(log, 'agent sessions');

	constructor(
		private readonly openDb: () => StateDb,
		private readonly repo: string,
		private readonly json: JsonAgentSessionsDao,
	) {}

	file(key: string): string {
		return this.json.file(key);
	}

	read(key: string, agentProfile: string): string | undefined {
		return this.sessions(key).find(row => row.agent_profile === agentProfile)
			?.session_id;
	}

	latestProfile(key: string): string | undefined {
		return latestStarted(
			this.sessions(key).map(row => [row.agent_profile, row.started]),
		);
	}

	keys(): string[] {
		return this.reads.or([], () => {
			// A hook without the database leaves a file with no rows yet, and a
			// process that reads the files removes one without touching its rows.
			for (const key of new Set([...this.json.keys(), ...this.storedKeys()]))
				this.openDb().sync(this.mirror(key));
			return this.storedKeys();
		});
	}

	async renameProfile(key: string, from: string, to: string): Promise<void> {
		const mirror = this.mirror(key);
		try {
			await this.openDb().write(tx => {
				if (tx.sync(mirror) === 'malformed') return;
				const names = new Set(this.rows(key).map(row => row.agent_profile));
				if (!names.has(from) || names.has(to)) return;
				this.openDb()
					.db.query(
						`UPDATE agent_sessions SET agent_profile = ?
						WHERE repo = ? AND key = ? AND agent_profile = ?`,
					)
					.run(to, this.repo, key, from);
				tx.mirror(mirror.file, this.render(key));
			});
		} catch (error) {
			// The space relaunches with --continue instead.
			log.warn(
				`Could not move the agent session of ${key} from ${from} to ${to}`,
				error instanceof Error ? error : undefined,
			);
		}
	}

	async clear(key: string): Promise<void> {
		const mirror = this.mirror(key);
		await this.openDb().write(tx => {
			this.delete(key);
			tx.mirror(mirror.file, null);
		});
	}

	private sessions(key: string): SessionRow[] {
		return this.reads.or([], () => {
			this.openDb().sync(this.mirror(key));
			return this.rows(key);
		});
	}

	private mirror(key: string): JsonMirror {
		return {
			file: this.json.file(key),
			importRows: content => {
				this.delete(key);
				// idow removes the file of a new issue on purpose, so its
				// sessions go with it.
				if (content === null) return;
				const insert = this.openDb().db.query(
					`INSERT INTO agent_sessions
						(repo, key, agent_profile, session_id, pid, started)
					VALUES (?, ?, ?, ?, ?, ?)`,
				);
				for (const [name, session] of parseAgentSessions(content)) {
					insert.run(
						this.repo,
						key,
						name,
						session.sessionId,
						session.pid,
						session.started,
					);
				}
			},
		};
	}

	private render(key: string): string {
		return renderAgentSessions(
			this.rows(key).map((row): [string, AgentSession] => [
				row.agent_profile,
				{sessionId: row.session_id, pid: row.pid, started: row.started},
			]),
		);
	}

	private rows(key: string): SessionRow[] {
		return this.openDb()
			.db.query<SessionRow, [string, string]>(
				`SELECT agent_profile, session_id, pid, started FROM agent_sessions
				WHERE repo = ? AND key = ? ORDER BY rowid`,
			)
			.all(this.repo, key);
	}

	private storedKeys(): string[] {
		return this.openDb()
			.db.query<{key: string}, [string]>(
				'SELECT DISTINCT key FROM agent_sessions WHERE repo = ? ORDER BY key',
			)
			.all(this.repo)
			.map(row => row.key);
	}

	private delete(key: string): void {
		this.openDb()
			.db.query('DELETE FROM agent_sessions WHERE repo = ? AND key = ?')
			.run(this.repo, key);
	}
}
