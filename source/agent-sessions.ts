// Each agent profile's latest conversation in a space. The agent's
// SessionStart/UserPromptSubmit hook (plugins/pappardelle/hooks/agent_session.py)
// records it; Pappardelle reads it to resume the conversation and find its
// transcript.

import type {Unreadable} from './state-db.ts';

/** One agent profile's latest conversation in a space, as its hook records it. */
export type AgentSession = {
	sessionId: string;
	/** The agent process that recorded the id, and when it started. */
	pid: number | null;
	started: string | null;
};

/** Each agent profile's recorded session id in one space. */
export type AgentSessionsLookup =
	| {kind: 'sessions'; sessions: Record<string, string>}
	| Unreadable;

/**
 * Each agent profile's latest conversation in a space, by agent profile name.
 * Keyed by agent profile so a one-launch override doesn't take the profile's
 * own conversation away. idow clears a space's sessions when it creates a
 * workspace for a new issue, whose key can't own an earlier conversation.
 */
export interface AgentSessionsDao {
	/** The session id an agent profile recorded in a space. */
	read(key: string, agentProfile: string): string | undefined;
	sessions(key: string): AgentSessionsLookup;
	/**
	 * The agent profile whose agent started last in a space. An agent launched
	 * before its space stored the agent profile it started with is running
	 * this one.
	 */
	latestProfile(key: string): string | undefined;
	/** The spaces that have recorded sessions. */
	keys(): string[];
	/**
	 * Move the session recorded under `from` to `to`. Nothing changes when
	 * `from` has none or `to` already has its own.
	 */
	renameProfile(key: string, from: string, to: string): Promise<void>;
	/** Forget every session recorded in a space. */
	clear(key: string): Promise<void>;
}

/**
 * The name whose agent started last. `started` is the agent process's start
 * time as the hook reads it from `ps -o lstart` (LC_ALL=C).
 */
export function latestStarted(
	entries: Iterable<[name: string, started: string | null]>,
): string | undefined {
	let latest: {name: string; started: number} | undefined;
	for (const [name, value] of entries) {
		if (value === null) continue;
		const started = Date.parse(value);
		if (!Number.isNaN(started) && (!latest || started > latest.started)) {
			latest = {name, started};
		}
	}

	return latest?.name;
}
