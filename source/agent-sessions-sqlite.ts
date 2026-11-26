// Agent sessions as rows.
//
// Two writers: the agent's hook, which records a session id, and a config
// migration, which moves an id to a renamed agent profile. Each does its read
// and write inside one write transaction, so neither undoes the other.

import {createLogger} from './logger.ts';
import {
	latestStarted,
	type AgentSession,
	type AgentSessionsDao,
	type AgentSessionsLookup,
} from './space-state.ts';
import {GuardedReads, type StateDb} from './state-db.ts';

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
	) {}

	read(key: string, agentProfile: string): string | undefined {
		return this.guardedRows(key).find(row => row.agent_profile === agentProfile)
			?.session_id;
	}

	sessions(key: string): AgentSessionsLookup {
		try {
			return {
				kind: 'sessions',
				sessions: Object.fromEntries(
					this.rows(key).map(row => [row.agent_profile, row.session_id]),
				),
			};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	latestProfile(key: string): string | undefined {
		return latestStarted(
			this.guardedRows(key).map(row => [row.agent_profile, row.started]),
		);
	}

	keys(): string[] {
		return this.reads.or([], () => this.storedKeys());
	}

	async renameProfile(key: string, from: string, to: string): Promise<void> {
		try {
			await this.openDb().write(() => {
				const names = new Set(this.rows(key).map(row => row.agent_profile));
				if (!names.has(from) || names.has(to)) return;
				this.openDb()
					.db.query(
						`UPDATE agent_sessions SET agent_profile = ?
						WHERE repo = ? AND key = ? AND agent_profile = ?`,
					)
					.run(to, this.repo, key, from);
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
		await this.openDb().write(() => {
			this.delete(key);
		});
	}

	/**
	 * Make a space's sessions `sessions`, by agent profile name. For a caller
	 * inside a write transaction.
	 */
	replace(key: string, sessions: ReadonlyMap<string, AgentSession>): void {
		this.delete(key);
		const insert = this.openDb().db.query(
			`INSERT INTO agent_sessions
				(repo, key, agent_profile, session_id, pid, started)
			VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const [name, session] of sessions) {
			insert.run(
				this.repo,
				key,
				name,
				session.sessionId,
				session.pid,
				session.started,
			);
		}
	}

	private guardedRows(key: string): SessionRow[] {
		return this.reads.or([], () => this.rows(key));
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
