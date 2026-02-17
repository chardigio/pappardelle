// Claude Code status tracking
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	readdirSync,
	watch,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {ClaudeStatus, ClaudeSessionState} from './types.ts';
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from './types.ts';
import {createLogger} from './logger.ts';

export {STABLE_STATUSES, ACTIVE_STATUSES, ACTIVE_STATUS_TIMEOUT};

const log = createLogger('claude-status');

// Status file location: ~/.pappardelle/claude-status/<workspace>.json
const STATUS_DIR = path.join(homedir(), '.pappardelle', 'claude-status');

export function ensureStatusDir(): void {
	if (!existsSync(STATUS_DIR)) {
		mkdirSync(STATUS_DIR, {recursive: true});
	}
}

function getStatusFilePath(workspaceName: string): string {
	return path.join(STATUS_DIR, `${workspaceName}.json`);
}

export interface ClaudeStatusInfo {
	status: ClaudeStatus;
	tool?: string;
}

export function getClaudeStatusInfo(workspaceName: string): ClaudeStatusInfo {
	try {
		const filePath = getStatusFilePath(workspaceName);
		if (!existsSync(filePath)) {
			return {status: 'unknown'};
		}

		const content = readFileSync(filePath, 'utf-8');
		const state: ClaudeSessionState = JSON.parse(content);

		// Stable statuses never become stale
		if (STABLE_STATUSES.has(state.status)) {
			return {status: state.status, tool: state.currentTool};
		}

		// Active statuses become stale after timeout
		// This indicates something may be wrong (hook stopped firing, Claude crashed)
		if (ACTIVE_STATUSES.has(state.status)) {
			const isStale = Date.now() - state.lastUpdate > ACTIVE_STATUS_TIMEOUT;
			if (isStale) {
				return {status: 'unknown'};
			}
		}

		return {status: state.status, tool: state.currentTool};
	} catch (err) {
		log.warn(
			`Failed to read status for workspace ${workspaceName}`,
			err instanceof Error ? err : undefined,
		);
		return {status: 'unknown'};
	}
}

export function setClaudeStatus(
	workspaceName: string,
	status: ClaudeStatus,
	sessionId?: string,
	currentTool?: string,
): void {
	ensureStatusDir();
	const filePath = getStatusFilePath(workspaceName);
	const state: ClaudeSessionState = {
		sessionId: sessionId ?? 'unknown',
		workspaceName,
		status,
		lastUpdate: Date.now(),
		currentTool,
	};
	writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function getAllStatuses(): Map<string, ClaudeStatus> {
	const statuses = new Map<string, ClaudeStatus>();

	try {
		ensureStatusDir();
		const files = readdirSync(STATUS_DIR);

		for (const file of files) {
			if (file.endsWith('.json')) {
				const workspaceName = file.replace('.json', '');
				statuses.set(workspaceName, getClaudeStatusInfo(workspaceName).status);
			}
		}
	} catch (err) {
		log.warn(
			'Failed to read all statuses',
			err instanceof Error ? err : undefined,
		);
	}

	return statuses;
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

// Watch for status changes
export function watchStatuses(
	callback: (workspaceName: string, info: ClaudeStatusInfo) => void,
): () => void {
	ensureStatusDir();

	const watcher = watch(STATUS_DIR, (_eventType, filename) => {
		if (filename && filename.endsWith('.json')) {
			const workspaceName = filename.replace('.json', '');
			const info = getClaudeStatusInfo(workspaceName);
			callback(workspaceName, info);
		}
	});

	return () => watcher.close();
}
