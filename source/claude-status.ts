// Claude Code status tracking
import {existsSync, mkdirSync, watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {waitForDirChange} from './file-watch.ts';
import type {ProgramStatusInfo} from './program-status.ts';

const CLAUDE_STATUSES = [
	'processing',
	'running_tool',
	'waiting_for_input',
	'waiting_for_approval',
	'compacting',
	'ended',
	'error',
	'unknown',
] as const;
export type ClaudeStatus = (typeof CLAUDE_STATUSES)[number];
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

export interface ClaudeStatusInfo {
	status: ClaudeStatus;
	tool?: string;
}

/** What is stored under a status key, as the hook wrote it. */
export type StoredClaudeStatus =
	| {kind: 'none'}
	| {kind: 'unreadable'}
	| {kind: 'state'; state: ClaudeSessionState};

/**
 * The status each Claude session last reported through its hook, one record
 * per status key. The hook (plugins/pappardelle/hooks/update-status.py) is
 * the only writer.
 */
export interface ClaudeStatusDao {
	/**
	 * The status key to read a space under. An agent started before status
	 * keys were qualified by repo still writes under the bare name until it
	 * restarts, so that record is read when only it exists. It can belong to
	 * another repo's space with the same key, the collision the qualified name
	 * fixes.
	 */
	readableKey(repoName: string, name: string): Promise<string>;
	/** `unknown` when nothing is recorded, null when the record cannot be read. */
	read(statusKey: string): Promise<ClaudeStatusInfo | null>;
	readState(statusKey: string): Promise<StoredClaudeStatus>;
	/** Call `listener` with the status key of each record that changes. */
	watch(listener: (statusKey: string) => void): () => void;
	/** Resolve when a record changes, or after `ms`, whichever is first. */
	waitForChange(ms: number): Promise<void>;
}

export function statusInfo(state: ClaudeSessionState): ClaudeStatusInfo {
	if (
		ACTIVE_STATUSES.has(state.status) &&
		Date.now() - state.lastUpdate > ACTIVE_STATUS_TIMEOUT
	) {
		return {status: 'unknown'};
	}

	return {status: state.status, tool: state.currentTool};
}

function parseStatus(content: string): ClaudeStatusInfo {
	return statusInfo(JSON.parse(content) as ClaudeSessionState);
}

/** A record holding only the optional fields that were reported. */
function sessionState(
	required: Pick<
		ClaudeSessionState,
		'sessionId' | 'workspaceName' | 'status' | 'lastUpdate'
	>,
	reported: {
		currentTool: string | undefined;
		event: string | undefined;
		cwd: string | undefined;
	},
): ClaudeSessionState {
	const {currentTool, event, cwd} = reported;
	return {
		...required,
		...(currentTool === undefined ? {} : {currentTool}),
		...(event === undefined ? {} : {event}),
		...(cwd === undefined ? {} : {cwd}),
	};
}

const isOptionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === 'string';

/** A record as the hook writes it, or undefined when `value` is anything else. */
export function sessionStateOf(value: unknown): ClaudeSessionState | undefined {
	const record = value as Record<string, unknown> | null;
	const {
		sessionId,
		workspaceName,
		status,
		lastUpdate,
		currentTool,
		event,
		cwd,
	} = record ?? {};
	if (
		typeof sessionId !== 'string' ||
		typeof workspaceName !== 'string' ||
		!CLAUDE_STATUSES.includes(status as ClaudeStatus) ||
		typeof lastUpdate !== 'number' ||
		!isOptionalString(currentTool) ||
		!isOptionalString(event) ||
		!isOptionalString(cwd)
	)
		return undefined;
	return sessionState(
		{sessionId, workspaceName, status: status as ClaudeStatus, lastUpdate},
		{currentTool, event, cwd},
	);
}

/** Throws when `content` is not a record as the hook writes it. */
export function parseSessionState(content: string): ClaudeSessionState {
	const state = sessionStateOf(JSON.parse(content));
	if (!state) throw new Error('Not a Claude status record');
	return state;
}

/**
 * The rule of `ClaudeStatusDao.readableKey`, for a store that says whether it
 * holds a record under a status key.
 */
export async function readableStatusKey(
	repoName: string,
	name: string,
	recorded: (statusKey: string) => boolean | Promise<boolean>,
): Promise<string> {
	const qualified = hookStatusKey(repoName, name);
	if (await recorded(qualified)) return qualified;
	return (await recorded(name)) ? name : qualified;
}

export class JsonClaudeStatusDao implements ClaudeStatusDao {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = path.resolve(dir);
	}

	private file(statusKey: string): string {
		return path.join(this.dir, `${statusKey}.json`);
	}

	async readableKey(repoName: string, name: string): Promise<string> {
		return readableStatusKey(repoName, name, statusKey =>
			existsSync(this.file(statusKey)),
		);
	}

	async read(statusKey: string): Promise<ClaudeStatusInfo | null> {
		try {
			return parseStatus(await readFile(this.file(statusKey), 'utf-8'));
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === 'ENOENT'
				? {status: 'unknown'}
				: null;
		}
	}

	async readState(statusKey: string): Promise<StoredClaudeStatus> {
		let content: string;
		try {
			content = await readFile(this.file(statusKey), 'utf8');
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'ENOENT'
				? {kind: 'none'}
				: {kind: 'unreadable'};
		}

		try {
			return {kind: 'state', state: parseSessionState(content)};
		} catch {
			return {kind: 'unreadable'};
		}
	}

	watch(listener: (statusKey: string) => void): () => void {
		mkdirSync(this.dir, {recursive: true});
		const watcher = watch(this.dir, (_event, filename) => {
			if (filename?.endsWith('.json')) listener(filename.slice(0, -5));
		});
		return () => {
			watcher.close();
		};
	}

	async waitForChange(ms: number): Promise<void> {
		await waitForDirChange([this.dir], ms);
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
