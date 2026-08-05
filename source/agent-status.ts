// Harness-agnostic agent status: one schema, one directory, one writer.
//
// Supersedes the Claude-only claude-status.ts. Every harness's hook adapter
// funnels through the same normalized file, and the TUI reads it without ever
// learning which agent produced it beyond the mandatory `agent` field.

import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
	rmSync,
	watch,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {
	AgentCli,
	AgentDecoration,
	AgentState,
	AgentStatusFile,
} from './types.ts';
import {
	AGENT_STATUS_SCHEMA,
	ACTIVE_STATES,
	ACTIVE_STATUS_TIMEOUT,
	STABLE_STATES,
	isAgentCli,
} from './types.ts';
import {createLogger} from './logger.ts';

export {STABLE_STATES, ACTIVE_STATES, ACTIVE_STATUS_TIMEOUT};

const log = createLogger('agent-status');

const VALID_STATES = new Set<string>([
	'idle',
	'working',
	'needs-approval',
	'needs-answer',
	'done',
]);

// Status file location: ~/.pappardelle/agent-status/<statusKey>.json.
// Resolved at call time so tests (and the Python hooks) can override via
// PAPPARDELLE_STATUS_DIR.
export function getStatusDir(): string {
	return (
		process.env['PAPPARDELLE_STATUS_DIR'] ??
		path.join(homedir(), '.pappardelle', 'agent-status')
	);
}

export function ensureStatusDir(): void {
	const dir = getStatusDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
}

function getStatusFilePath(statusKey: string): string {
	return path.join(getStatusDir(), `${statusKey}.json`);
}

export interface AgentStatusInfo {
	agent: AgentCli;
	state: AgentState;
	decoration?: AgentDecoration;
	lastUpdate: number;
}

/**
 * Read a space's normalized status.
 *
 * Returns `null` — meaning "unknown", the case the UI renders as a gray `?` —
 * for a missing file, a malformed or partially-written file, a file whose
 * `state`/`agent` aren't values we recognize, a stale `working` claim, or a
 * file written by a different harness than the one this space is configured
 * for.
 *
 * That last rejection is the whole reason `agent` is mandatory in the schema:
 * without it, a status file left behind by a Claude session could keep coloring
 * a row that has since been switched to Codex, and the row would look alive
 * while nothing was running.
 */
export function getAgentStatus(
	statusKey: string,
	expectedAgent?: AgentCli,
): AgentStatusInfo | null {
	try {
		const filePath = getStatusFilePath(statusKey);
		if (!existsSync(filePath)) {
			return null;
		}

		const content = readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null;
		}

		const file = parsed as Partial<AgentStatusFile>;
		if (!isAgentCli(file.agent)) return null;
		if (typeof file.state !== 'string' || !VALID_STATES.has(file.state)) {
			return null;
		}
		if (typeof file.lastUpdate !== 'number') return null;

		// Cross-harness bleed guard.
		if (expectedAgent !== undefined && file.agent !== expectedAgent) {
			return null;
		}

		const state = file.state as AgentState;

		// Only `working` rots. A human sitting on a question for an hour is a
		// perfectly valid `needs-answer`, so the stable states never expire.
		if (
			ACTIVE_STATES.has(state) &&
			Date.now() - file.lastUpdate > ACTIVE_STATUS_TIMEOUT
		) {
			return null;
		}

		return {
			agent: file.agent,
			state,
			decoration: file.decoration,
			lastUpdate: file.lastUpdate,
		};
	} catch (err) {
		// Parse failures here are almost always a transient read/write race on
		// the status JSON file (writer truncates before rewriting). Atomic
		// writes make this rare, but a stray partial file shouldn't surface as
		// a UI-visible warning — fall back to unknown and move on.
		log.debug(
			`Failed to read status for ${statusKey}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return null;
	}
}

export interface SetAgentStatusOptions {
	sessionId?: string;
	cwd?: string;
	decoration?: AgentDecoration;
}

/**
 * Write a space's normalized status atomically.
 *
 * Write to a sibling temp file then rename. POSIX rename is atomic, so
 * concurrent readers (and our own fs.watch) always observe either the previous
 * complete file or the new complete file. If the write throws (disk full,
 * permission denied) before the rename, clean up the orphan so the status dir
 * doesn't accumulate junk across crashes.
 */
export function setAgentStatus(
	statusKey: string,
	agent: AgentCli,
	state: AgentState,
	options: SetAgentStatusOptions = {},
): void {
	ensureStatusDir();
	const filePath = getStatusFilePath(statusKey);
	const file: AgentStatusFile = {
		schema: AGENT_STATUS_SCHEMA,
		agent,
		state,
		statusKey,
		lastUpdate: Date.now(),
	};
	if (options.sessionId) file.sessionId = options.sessionId;
	if (options.cwd) file.cwd = options.cwd;
	if (options.decoration && Object.keys(options.decoration).length > 0) {
		file.decoration = options.decoration;
	}

	const tmpPath = `${filePath}.tmp.${process.pid}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(file, null, 2));
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			rmSync(tmpPath, {force: true});
		} catch {
			// swallow — original error is what we want to surface
		}
		throw err;
	}
}

/**
 * Find the index of a space matching a status file's key.
 * Uses statusKey (repo-qualified) when present, falls back to name.
 */
export function findSpaceByStatusKey(
	spaces: ReadonlyArray<{name: string; statusKey?: string}>,
	statusKey: string,
): number {
	return spaces.findIndex(s => (s.statusKey ?? s.name) === statusKey);
}

/** Watch the status directory and report each normalized change. */
export function watchStatuses(
	callback: (statusKey: string, info: AgentStatusInfo | null) => void,
): () => void {
	ensureStatusDir();

	const watcher = watch(getStatusDir(), (_eventType, filename) => {
		// Ignore the atomic-write temp files; only the post-rename final name
		// carries a complete document.
		if (!filename || !filename.endsWith('.json')) return;
		const statusKey = filename.replace(/\.json$/, '');
		callback(statusKey, getAgentStatus(statusKey));
	});

	return () => watcher.close();
}
