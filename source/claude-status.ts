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
import type {ClaudeStatus, ClaudeSessionState} from './types.js';
import {createLogger} from './logger.js';

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

// Statuses that are stable and should never become stale
export const STABLE_STATUSES = new Set<ClaudeStatus>([
	'waiting_for_input', // Waiting for user input - user may take time to respond
	'waiting_for_approval', // Waiting for permission - user may be reviewing
	'ended', // Session terminated - stays ended
	'error', // Error state should persist until resolved
]);

// Statuses that indicate active work and can become stale
export const ACTIVE_STATUSES = new Set<ClaudeStatus>([
	'processing',
	'running_tool',
	'compacting',
]);

// How long before an active status becomes stale (10 minutes)
export const ACTIVE_STATUS_TIMEOUT = 10 * 60 * 1000;

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
