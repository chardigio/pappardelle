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

export function getClaudeStatus(workspaceName: string): ClaudeStatus {
	try {
		const filePath = getStatusFilePath(workspaceName);
		if (!existsSync(filePath)) {
			return 'unknown';
		}

		const content = readFileSync(filePath, 'utf-8');
		const state: ClaudeSessionState = JSON.parse(content);

		// Check if status is stale (> 5 minutes old)
		const isStale = Date.now() - state.lastUpdate > 5 * 60 * 1000;
		if (isStale) {
			return 'unknown';
		}

		return state.status;
	} catch (err) {
		log.warn(
			`Failed to read status for workspace ${workspaceName}`,
			err instanceof Error ? err : undefined,
		);
		return 'unknown';
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
				statuses.set(workspaceName, getClaudeStatus(workspaceName));
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
	callback: (workspaceName: string, status: ClaudeStatus) => void,
): () => void {
	ensureStatusDir();

	const watcher = watch(STATUS_DIR, (_eventType, filename) => {
		if (filename && filename.endsWith('.json')) {
			const workspaceName = filename.replace('.json', '');
			const status = getClaudeStatus(workspaceName);
			callback(workspaceName, status);
		}
	});

	return () => watcher.close();
}
