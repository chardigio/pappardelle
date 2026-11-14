// Per-space companion widths, and the requests the CLI sends the TUI to lay
// out a space's companion. The CLI and the TUI exchange request and ack files
// under ~/.pappardelle/repos/{repo}/ so `pappardelle companion` can report
// whether the running TUI applied the change. The store is written
// by the CLI and by the TUI when the user drags the border, so every
// read-modify-write holds the store's file lock.

import {randomUUID} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';
import {withFileLock} from './file-lock.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

function repoDir(repoName: string, baseDir?: string): string {
	return path.join(baseDir ?? DEFAULT_BASE_DIR, 'repos', repoName);
}

export function companionWidthsPath(repoName: string, baseDir?: string) {
	return path.join(repoDir(repoName, baseDir), 'companion-widths.json');
}

// One file per request, so two quick calls never replace each other's.
function requestsDir(repoName: string, baseDir?: string) {
	return path.join(repoDir(repoName, baseDir), 'companion-requests');
}

function requestPath(id: string, repoName: string, baseDir?: string) {
	return path.join(requestsDir(repoName, baseDir), `${id}.json`);
}

function ackPath(id: string, repoName: string, baseDir?: string) {
	return path.join(requestsDir(repoName, baseDir), `${id}${ACK_SUFFIX}`);
}

const ACK_SUFFIX = '.ack.json';

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	mkdirSync(path.dirname(file), {recursive: true});
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(data) + '\n');
	renameSync(temporary, file);
}

export function readCompanionWidths(
	repoName: string,
	baseDir?: string,
): Record<string, PaneWidth> {
	const parsed = readJson(companionWidthsPath(repoName, baseDir));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	return Object.fromEntries(
		Object.entries(parsed).filter((entry): entry is [string, PaneWidth] =>
			isPaneWidth(entry[1]),
		),
	);
}

export function getCompanionWidth(
	repoName: string,
	spaceKey: string,
	baseDir?: string,
): PaneWidth | null {
	return readCompanionWidths(repoName, baseDir)[spaceKey] ?? null;
}

/** Store `width` for the space, or remove its entry when `width` is null. */
export async function setCompanionWidth(
	repoName: string,
	spaceKey: string,
	width: PaneWidth | null,
	baseDir?: string,
): Promise<void> {
	await withFileLock(companionWidthsPath(repoName, baseDir), file => {
		const {[spaceKey]: _previous, ...others} = readCompanionWidths(
			repoName,
			baseDir,
		);
		writeJsonAtomic(
			file,
			width === null ? others : {...others, [spaceKey]: width},
		);
	});
}

/**
 * Asks the TUI to lay out a space's companion again: `width` after the
 * column width was stored, `layout` after a split was opened, resized or
 * closed.
 */
export type LayoutRequest = {
	id: string;
	space: string;
	kind: 'width' | 'layout';
};

export type LayoutAck = {
	id: string;
	result: 'applied' | 'stored' | 'no-pane' | 'deferred' | 'failed';
	/** The column's width, for an applied width request. */
	columns?: number;
};

function readRequest(file: string): LayoutRequest | null {
	const parsed = readJson(file) as LayoutRequest | null;
	return typeof parsed?.id === 'string' &&
		typeof parsed.space === 'string' &&
		(parsed.kind === 'width' || parsed.kind === 'layout')
		? parsed
		: null;
}

function readAck(
	id: string,
	repoName: string,
	baseDir?: string,
): LayoutAck | null {
	const parsed = readJson(ackPath(id, repoName, baseDir)) as LayoutAck | null;
	return parsed?.id === id ? parsed : null;
}

/**
 * Answer a request, unless the CLI stopped waiting and removed it: an answer
 * nobody reads would stay on disk.
 */
export function writeLayoutAck(
	repoName: string,
	ack: LayoutAck,
	baseDir?: string,
): void {
	if (!existsSync(requestPath(ack.id, repoName, baseDir))) return;
	writeJsonAtomic(ackPath(ack.id, repoName, baseDir), ack);
}

/** Calls `onRequest` for every request the CLI writes while the TUI runs. */
export function watchLayoutRequests(
	repoName: string,
	onRequest: (request: LayoutRequest) => void,
	baseDir?: string,
): () => void {
	const dir = requestsDir(repoName, baseDir);
	mkdirSync(dir, {recursive: true});
	const watcher = watch(dir, (_event, file) => {
		if (!file?.endsWith('.json') || file.endsWith(ACK_SUFFIX)) return;
		const request = readRequest(path.join(dir, file));
		if (request) onRequest(request);
	});
	return () => watcher.close();
}

type Unapplied =
	| {outcome: 'stored'}
	| {outcome: 'no-pane'}
	| {outcome: 'deferred'}
	| {outcome: 'failed'}
	| {outcome: 'no-ack'}
	| {outcome: 'no-tui'};

export type LayoutOutcome = {outcome: 'applied'} | Unapplied;

export type WidthOutcome = {outcome: 'applied'; columns: number} | Unapplied;

type RequestTiming = {
	baseDir?: string;
	attemptMs?: number;
	attempts?: number;
	pollMs?: number;
};

/**
 * Ask a running TUI to lay out the space's companion and wait for its answer.
 * A busy machine can drop the file event, so the request is written again
 * after each wait; the TUI answers an id once.
 */
async function requestOfTui(
	options: {
		repoName: string;
		space: string;
		kind: LayoutRequest['kind'];
		tuiIsRunning: () => boolean;
	} & RequestTiming,
): Promise<LayoutAck | Extract<Unapplied, {outcome: 'no-ack' | 'no-tui'}>> {
	const {repoName, space, kind, baseDir} = options;
	if (!options.tuiIsRunning()) return {outcome: 'no-tui'};

	const id = randomUUID();
	const file = requestPath(id, repoName, baseDir);
	const attemptMs = options.attemptMs ?? 1000;
	const pollMs = options.pollMs ?? 50;
	try {
		for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
			writeJsonAtomic(file, {id, space, kind} satisfies LayoutRequest);
			const deadline = Date.now() + attemptMs;
			while (Date.now() < deadline) {
				const ack = readAck(id, repoName, baseDir);
				if (ack) return ack;
				await delay(pollMs);
			}
		}

		return {outcome: 'no-ack'};
	} finally {
		rmSync(file, {force: true});
		rmSync(ackPath(id, repoName, baseDir), {force: true});
	}
}

/**
 * Ask the TUI to show a space's splits again after one was opened, resized
 * or closed. Opening a split waits for its frame to start, so this waits
 * longer than a width request.
 */
export async function requestCompanionLayout(
	options: {
		repoName: string;
		space: string;
		tuiIsRunning: () => boolean;
	} & RequestTiming,
): Promise<LayoutOutcome> {
	const answer = await requestOfTui({
		attempts: 5,
		...options,
		kind: 'layout',
	});
	if ('outcome' in answer) return answer;
	return {outcome: answer.result};
}

/** Store the width, then ask a running TUI to apply it. */
export async function requestCompanionWidth(
	options: {
		repoName: string;
		space: string;
		width: PaneWidth | null;
		tuiIsRunning: () => boolean;
	} & RequestTiming,
): Promise<WidthOutcome> {
	await setCompanionWidth(
		options.repoName,
		options.space,
		options.width,
		options.baseDir,
	);
	const answer = await requestOfTui({...options, kind: 'width'});
	if ('outcome' in answer) return answer;
	if (answer.result !== 'applied') return {outcome: answer.result};
	return typeof answer.columns === 'number'
		? {outcome: 'applied', columns: answer.columns}
		: {outcome: 'failed'};
}
