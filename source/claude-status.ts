// Claude Code status tracking
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	renameSync,
	rmSync,
	readdirSync,
	watch,
} from 'node:fs';
import {homedir} from 'node:os';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {ClaudeStatus, ClaudeSessionState, SpaceData} from './types.ts';
import {
	STABLE_STATUSES,
	ACTIVE_STATUSES,
	ACTIVE_STATUS_TIMEOUT,
} from './types.ts';
import {createLogger} from './logger.ts';

export {STABLE_STATUSES, ACTIVE_STATUSES, ACTIVE_STATUS_TIMEOUT};

const log = createLogger('claude-status');

// Status file location: ~/.pappardelle/claude-status/<workspace>.json.
// Resolved at call time so tests (and the Python hook) can override via
// PAPPARDELLE_STATUS_DIR.
function getStatusDir(): string {
	return (
		process.env['PAPPARDELLE_STATUS_DIR'] ??
		path.join(homedir(), '.pappardelle', 'claude-status')
	);
}

export function ensureStatusDir(): void {
	const dir = getStatusDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
}

function getStatusFilePath(workspaceName: string): string {
	return path.join(getStatusDir(), `${workspaceName}.json`);
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
		const filePath = getStatusFilePath(workspaceName);
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

export function getAllStatuses(): Map<string, ClaudeStatus> {
	const statuses = new Map<string, ClaudeStatus>();

	try {
		ensureStatusDir();
		const files = readdirSync(getStatusDir());

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

export function applyStatusUpdates(
	spaces: SpaceData[],
	updates: ReadonlyMap<string, ClaudeStatusInfo>,
): SpaceData[] {
	let changed = false;
	const next = spaces.map(space => {
		const info = updates.get(space.statusKey ?? space.name);
		if (
			!info ||
			(space.claudeStatus === info.status && space.claudeTool === info.tool)
		) {
			return space;
		}
		changed = true;
		return {...space, claudeStatus: info.status, claudeTool: info.tool};
	});
	return changed ? next : spaces;
}

export function watchStatuses(
	callback: (updates: ReadonlyMap<string, ClaudeStatusInfo>) => void,
	isRelevant: (workspaceName: string) => boolean = () => true,
): () => void {
	ensureStatusDir();
	const dir = getStatusDir();
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reading = false;
	let stopped = false;

	const schedule = () => {
		if (stopped || reading || timer || pending.size === 0) return;
		// A fixed window bounds renders without starving updates during a busy session.
		timer = setTimeout(async () => {
			timer = undefined;
			reading = true;
			const names = [...pending];
			pending.clear();
			const updates = new Map<string, ClaudeStatusInfo>();
			try {
				for (let offset = 0; offset < names.length; offset += 4) {
					if (stopped) break;
					await Promise.all(
						names.slice(offset, offset + 4).map(async name => {
							if (!isRelevant(name)) return;
							let info: ClaudeStatusInfo;
							try {
								info = parseStatus(
									await readFile(path.join(dir, `${name}.json`), 'utf-8'),
								);
							} catch {
								info = {status: 'unknown'};
							}
							updates.set(name, info);
						}),
					);
				}
				if (!stopped && updates.size > 0) callback(updates);
			} finally {
				reading = false;
				schedule();
			}
		}, 50);
	};

	const watcher = watch(dir, (_eventType, filename) => {
		if (filename && filename.endsWith('.json')) {
			const workspaceName = filename.slice(0, -5);
			if (isRelevant(workspaceName)) {
				pending.add(workspaceName);
				schedule();
			}
		}
	});

	return () => {
		stopped = true;
		clearTimeout(timer);
		pending.clear();
		watcher.close();
	};
}
