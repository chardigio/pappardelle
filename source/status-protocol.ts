// What the status daemon and its clients say to each other: one JSON object
// per line over a Unix socket. The socket's file name carries the protocol
// number (state-db.ts), so there is no version field and no handshake.

import {parseSessionState, type ClaudeSessionState} from './claude-status.ts';
import type {ProgramStatusSnapshot} from './program-status-monitor.ts';

export type ClientMessage =
	/** A Claude hook event. Replaces the record under `state.workspaceName`. */
	| {type: 'hook'; state: ClaudeSessionState}
	/** A pane monitor's snapshot. Replaces the one of its pane generation. */
	| {type: 'snapshot'; snapshot: ProgramStatusSnapshot}
	/** Drop the snapshots of a space, except pane generation `keep`'s. */
	| {type: 'forget'; repo: string; key: string; keep?: string}
	/** Send the current state, then every change. Snapshots of `repo` only. */
	| {type: 'subscribe'; repo: string};

export type DaemonMessage =
	| {
			type: 'state';
			hooks: ClaudeSessionState[];
			snapshots: ProgramStatusSnapshot[];
	  }
	| {type: 'hook'; state: ClaudeSessionState}
	| {type: 'snapshot'; snapshot: ProgramStatusSnapshot}
	| {type: 'forgotten'; repo: string; key: string; keep?: string};

export type Parsed<Message> =
	| {kind: 'message'; message: Message}
	| {kind: 'invalid'};

const INVALID = {kind: 'invalid'} as const;

function hookState(value: unknown): ClaudeSessionState | undefined {
	try {
		return parseSessionState(JSON.stringify(value));
	} catch {
		return undefined;
	}
}

/**
 * A snapshot the daemon and a replica can file: the fields they key it by.
 * Whether its content is one a pane's monitor could have written is the
 * reader's check (`checkedProgramSnapshot`), which needs the pane it reads for.
 */
function snapshot(value: unknown): ProgramStatusSnapshot | undefined {
	const candidate = value as Partial<ProgramStatusSnapshot> | null;
	return typeof candidate?.repo === 'string' &&
		typeof candidate.key === 'string' &&
		typeof candidate.pane?.generation === 'string'
		? (candidate as ProgramStatusSnapshot)
		: undefined;
}

function forgetFields(
	record: Record<string, unknown>,
): {repo: string; key: string; keep?: string} | undefined {
	const {repo, key, keep} = record;
	if (typeof repo !== 'string' || typeof key !== 'string') return undefined;
	if (keep === undefined) return {repo, key};
	return typeof keep === 'string' ? {repo, key, keep} : undefined;
}

function record(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === 'object' && value !== null
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function listOf<Item>(
	value: unknown,
	item: (value: unknown) => Item | undefined,
): Item[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.map(entry => item(entry));
	return items.includes(undefined) ? undefined : (items as Item[]);
}

/** Never throws: a line that is not a client message is `invalid`. */
export function parseClientMessage(line: string): Parsed<ClientMessage> {
	const fields = record(line);
	switch (fields?.['type']) {
		case 'hook': {
			const state = hookState(fields['state']);
			return state
				? {kind: 'message', message: {type: 'hook', state}}
				: INVALID;
		}

		case 'snapshot': {
			const value = snapshot(fields['snapshot']);
			return value
				? {kind: 'message', message: {type: 'snapshot', snapshot: value}}
				: INVALID;
		}

		case 'forget': {
			const forget = forgetFields(fields);
			return forget
				? {kind: 'message', message: {type: 'forget', ...forget}}
				: INVALID;
		}

		case 'subscribe': {
			const {repo} = fields;
			return typeof repo === 'string'
				? {kind: 'message', message: {type: 'subscribe', repo}}
				: INVALID;
		}

		default: {
			return INVALID;
		}
	}
}

/** Never throws: a line that is not a daemon message is `invalid`. */
export function parseDaemonMessage(line: string): Parsed<DaemonMessage> {
	const fields = record(line);
	switch (fields?.['type']) {
		case 'state': {
			const hooks = listOf(fields['hooks'], hookState);
			const snapshots = listOf(fields['snapshots'], snapshot);
			return hooks && snapshots
				? {kind: 'message', message: {type: 'state', hooks, snapshots}}
				: INVALID;
		}

		case 'hook': {
			const state = hookState(fields['state']);
			return state
				? {kind: 'message', message: {type: 'hook', state}}
				: INVALID;
		}

		case 'snapshot': {
			const value = snapshot(fields['snapshot']);
			return value
				? {kind: 'message', message: {type: 'snapshot', snapshot: value}}
				: INVALID;
		}

		case 'forgotten': {
			const forgotten = forgetFields(fields);
			return forgotten
				? {kind: 'message', message: {type: 'forgotten', ...forgotten}}
				: INVALID;
		}

		default: {
			return INVALID;
		}
	}
}

export function encodeMessage(message: ClientMessage | DaemonMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** Cuts a socket's text into the lines that have arrived whole. */
export class LineReader {
	private partial = '';

	feed(text: string): string[] {
		const lines = (this.partial + text).split('\n');
		this.partial = lines.pop()!;
		return lines;
	}
}

/**
 * The delays of the daemon and its clients, injected so their tests do not
 * wait on real time.
 */
export type StatusTimers = {
	/** Call `run` after `ms`. Returns what cancels it. */
	after(ms: number, run: () => void): () => void;
};

/**
 * Real delays that do not keep the process alive: a CLI verb with a client
 * exits when its work is done, and a daemon lives by its socket.
 */
export const backgroundTimers: StatusTimers = {
	after(ms, run) {
		const timer = setTimeout(run, ms);
		timer.unref();
		return () => {
			clearTimeout(timer);
		};
	},
};
