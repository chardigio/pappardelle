// Claude Code status tracking
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
	rmSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {ProgramStatusInfo} from './program-status.ts';

export type ClaudeStatus =
	| 'processing'
	| 'running_tool'
	| 'waiting_for_input'
	| 'waiting_for_approval'
	| 'compacting'
	| 'ended'
	| 'error'
	| 'unknown';
export interface ClaudeSessionState {
	sessionId: string;
	workspaceName: string;
	status: ClaudeStatus;
	lastUpdate: number;
	currentTool?: string;
	event?: string;
	cwd?: string;
}
export const STABLE_STATUSES = new Set<ClaudeStatus>([
	'waiting_for_input',
	'waiting_for_approval',
	'ended',
	'error',
]);
export const ACTIVE_STATUSES = new Set<ClaudeStatus>([
	'processing',
	'running_tool',
	'compacting',
]);
export const ACTIVE_STATUS_TIMEOUT = 10 * 60 * 1000;
import {createLogger} from './logger.ts';

const log = createLogger('claude-status');

// Status file location: ~/.pappardelle/claude-status/<workspace>.json.
// Resolved at call time so tests (and the Python hook) can override via
// PAPPARDELLE_STATUS_DIR.
export function getHookStatusDir(): string {
	return (
		process.env['PAPPARDELLE_STATUS_DIR'] ??
		path.join(homedir(), '.pappardelle', 'claude-status')
	);
}

export function ensureStatusDir(): void {
	const dir = getHookStatusDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
}

/**
 * The name of a space's hook status file: the space key, or the main
 * checkout's branch, qualified by repo. Every repo writes to the same
 * directory, and two repos can have spaces with the same key.
 */
export function hookStatusKey(repoName: string, name: string): string {
	// Branch names may carry a slash (alice/STA-1). The hook flattens it the
	// same way so the status file name stays a single path segment.
	return `${repoName}-${name}`.replaceAll('/', '-');
}

export function hookStatusFile(statusKey: string): string {
	return path.join(getHookStatusDir(), `${statusKey}.json`);
}

/**
 * The status key to read a space under. An agent started before status files
 * were qualified by repo still writes under the bare name until it restarts,
 * so that file is read when only it exists. It can belong to another repo's
 * space with the same key, the collision the qualified name fixes.
 */
export function readableHookStatusKey(
	repoName: string,
	name: string,
	dir = getHookStatusDir(),
): string {
	const qualified = hookStatusKey(repoName, name);
	if (existsSync(path.join(dir, `${qualified}.json`))) return qualified;
	return existsSync(path.join(dir, `${name}.json`)) ? name : qualified;
}

export interface ClaudeStatusInfo {
	status: ClaudeStatus;
	tool?: string;
}

function parseStatus(content: string): ClaudeStatusInfo {
	const state: ClaudeSessionState = JSON.parse(content);
	if (
		ACTIVE_STATUSES.has(state.status) &&
		Date.now() - state.lastUpdate > ACTIVE_STATUS_TIMEOUT
	) {
		return {status: 'unknown'};
	}
	return {status: state.status, tool: state.currentTool};
}

export function getClaudeStatusInfo(workspaceName: string): ClaudeStatusInfo {
	try {
		const filePath = hookStatusFile(workspaceName);
		if (!existsSync(filePath)) {
			return {status: 'unknown'};
		}

		return parseStatus(readFileSync(filePath, 'utf-8'));
	} catch (err) {
		// Parse failures here are almost always a transient read/write race on
		// the status JSON file (writer truncates before rewriting). Atomic
		// writes make this rare, but a stray partial file shouldn't surface as
		// a UI-visible warning — fall back to 'unknown' and move on.
		log.debug(
			`Failed to read status for workspace ${workspaceName}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return {status: 'unknown'};
	}
}

export async function getClaudeStatusInfoAsync(
	workspaceName: string,
): Promise<ClaudeStatusInfo | null> {
	try {
		return parseStatus(await readFile(hookStatusFile(workspaceName), 'utf-8'));
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT'
			? {status: 'unknown'}
			: null;
	}
}

export function setClaudeStatus(
	workspaceName: string,
	status: ClaudeStatus,
	sessionId?: string,
	currentTool?: string,
): void {
	ensureStatusDir();
	const filePath = hookStatusFile(workspaceName);
	const state: ClaudeSessionState = {
		sessionId: sessionId ?? 'unknown',
		workspaceName,
		status,
		lastUpdate: Date.now(),
		currentTool,
	};
	// Atomic write: write to a sibling temp file then rename. POSIX rename is
	// atomic, so concurrent readers (and our own fs.watch) always observe
	// either the previous complete file or the new complete file. If the
	// write throws (disk full, permission denied) before the rename, clean
	// up the orphan so the status dir doesn't accumulate junk across crashes.
	const tmpPath = `${filePath}.tmp.${process.pid}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(state, null, 2));
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
 * Find the index of a space matching a status file workspace name.
 * Uses statusKey (repo-qualified) when present, falls back to name.
 */
export function findSpaceByStatusKey(
	spaces: ReadonlyArray<{name: string; statusKey?: string}>,
	workspaceName: string,
): number {
	return spaces.findIndex(s => (s.statusKey ?? s.name) === workspaceName);
}

export function mapClaudeStatus(info: ClaudeStatusInfo): ProgramStatusInfo {
	const status = {
		processing: 'working',
		running_tool: 'working',
		compacting: 'working',
		waiting_for_input: 'idle',
		waiting_for_approval: 'blocked',
		ended: 'idle',
		error: 'error',
		unknown: 'unknown',
	} as const;
	const mapped = status[info.status];
	if (!mapped || mapped === 'unknown') return {status: 'unknown'};
	return {
		status: mapped,
		source: 'hook',
		app: 'claude-code',
		...(info.tool ? {tool: info.tool} : {}),
		...(info.status === 'waiting_for_approval'
			? {kind: info.tool === 'AskUserQuestion' ? 'question' : 'permission'}
			: {}),
		...(info.status === 'compacting'
			? {activity: 'compacting'}
			: info.status === 'running_tool'
				? {activity: 'tool'}
				: {}),
	};
}
