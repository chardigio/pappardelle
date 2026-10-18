// Per-space companion widths. The CLI and the TUI exchange request and ack
// files under ~/.pappardelle/repos/{repo}/ so `pappardelle companion width`
// can report whether the running TUI applied the width. The store is written
// by the CLI and by the TUI when the user drags the border, so every
// read-modify-write holds the store's file lock.

import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {watchFileContent} from './file-watch.ts';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';
import {withFileLock} from './file-lock.ts';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

function repoDir(repoName: string, baseDir?: string): string {
	return path.join(baseDir ?? DEFAULT_BASE_DIR, 'repos', repoName);
}

export function companionWidthsPath(repoName: string, baseDir?: string) {
	return path.join(repoDir(repoName, baseDir), 'companion-widths.json');
}

function requestPath(repoName: string, baseDir?: string) {
	return path.join(repoDir(repoName, baseDir), 'companion-width-request.json');
}

function ackPath(repoName: string, baseDir?: string) {
	return path.join(repoDir(repoName, baseDir), 'companion-width-ack.json');
}

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

export type WidthRequest = {id: string; space: string};

export type WidthAck = {
	id: string;
	result: 'applied' | 'stored' | 'no-pane' | 'deferred' | 'failed';
	columns?: number;
};

function readRequest(repoName: string, baseDir?: string): WidthRequest | null {
	const parsed = readJson(
		requestPath(repoName, baseDir),
	) as WidthRequest | null;
	return typeof parsed?.id === 'string' && typeof parsed.space === 'string'
		? parsed
		: null;
}

function readAck(repoName: string, baseDir?: string): WidthAck | null {
	const parsed = readJson(ackPath(repoName, baseDir)) as WidthAck | null;
	return typeof parsed?.id === 'string' ? parsed : null;
}

export function writeWidthAck(
	repoName: string,
	ack: WidthAck,
	baseDir?: string,
): void {
	writeJsonAtomic(ackPath(repoName, baseDir), ack);
}

/** Calls `onRequest` for every request the CLI writes while the TUI runs. */
export function watchWidthRequests(
	repoName: string,
	onRequest: (request: WidthRequest) => void,
	baseDir?: string,
): () => void {
	return watchFileContent(requestPath(repoName, baseDir), () => {
		const request = readRequest(repoName, baseDir);
		if (request) onRequest(request);
	});
}

export type WidthOutcome =
	| {outcome: 'applied'; columns: number}
	| {outcome: 'stored'}
	| {outcome: 'no-pane'}
	| {outcome: 'deferred'}
	| {outcome: 'failed'}
	| {outcome: 'no-ack'}
	| {outcome: 'no-tui'};

/**
 * Store the width, then ask a running TUI to apply it and wait for its
 * answer. There is one request file, so a concurrent call can replace this
 * one before the TUI reads it, and a busy machine can drop the file event.
 * The request is written again after each wait; the TUI answers an id once.
 */
export async function requestCompanionWidth(options: {
	repoName: string;
	space: string;
	width: PaneWidth | null;
	tuiIsRunning: () => boolean;
	baseDir?: string;
	attemptMs?: number;
	attempts?: number;
	pollMs?: number;
}): Promise<WidthOutcome> {
	const {repoName, space, baseDir} = options;
	await setCompanionWidth(repoName, space, options.width, baseDir);
	if (!options.tuiIsRunning()) return {outcome: 'no-tui'};

	const id = randomUUID();
	const attemptMs = options.attemptMs ?? 1000;
	const pollMs = options.pollMs ?? 50;
	writeJsonAtomic(requestPath(repoName, baseDir), {id, space});
	for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
		const deadline = Date.now() + attemptMs;
		while (Date.now() < deadline) {
			const ack = readAck(repoName, baseDir);
			if (ack?.id === id) {
				if (ack.result === 'applied' && typeof ack.columns === 'number')
					return {outcome: 'applied', columns: ack.columns};
				return {
					outcome: ack.result === 'applied' ? 'failed' : ack.result,
				};
			}

			await delay(pollMs);
		}

		writeJsonAtomic(requestPath(repoName, baseDir), {id, space});
	}

	return {outcome: 'no-ack'};
}
