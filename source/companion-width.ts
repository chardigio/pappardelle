// Per-space companion widths, and the requests the CLI sends the TUI to lay
// out a space's companion. The CLI and the TUI exchange a request and its
// answer, as files under ~/.pappardelle/repos/{repo}/ in the stores here, so
// `pappardelle companion` can report whether the running TUI applied the
// change. The widths store is written by the CLI and by the TUI when the user
// drags the border, so every read-modify-write holds the store's file lock.

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
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';
import {withFileLock} from './file-lock.ts';

export function companionWidthsPath(repoName: string, baseDir: string) {
	return path.join(baseDir, 'repos', repoName, 'companion-widths.json');
}

// One file per request, so two quick calls never replace each other's.
export function companionRequestsDir(repoName: string, baseDir: string) {
	return path.join(baseDir, 'repos', repoName, 'companion-requests');
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

/** The width of each space's companion column that has one of its own. */
export interface CompanionWidthDao {
	all(): Record<string, PaneWidth>;
	get(spaceKey: string): PaneWidth | null;
	/** Store `width` for the space, or remove its entry when `width` is null. */
	set(spaceKey: string, width: PaneWidth | null): Promise<void>;
}

/**
 * The widths in a store file. Throws when `content` is not an object;
 * entries that are not widths are left out.
 */
export function parseCompanionWidths(
	content: string,
): Record<string, PaneWidth> {
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error('Not a companion widths store');
	return Object.fromEntries(
		Object.entries(parsed).filter((entry): entry is [string, PaneWidth] =>
			isPaneWidth(entry[1]),
		),
	);
}

export function renderCompanionWidths(
	widths: Record<string, PaneWidth>,
): string {
	return JSON.stringify(widths) + '\n';
}

export class JsonCompanionWidthDao implements CompanionWidthDao {
	constructor(readonly file: string) {}

	all(): Record<string, PaneWidth> {
		try {
			return parseCompanionWidths(readFileSync(this.file, 'utf8'));
		} catch {
			return {};
		}
	}

	get(spaceKey: string): PaneWidth | null {
		return this.all()[spaceKey] ?? null;
	}

	async set(spaceKey: string, width: PaneWidth | null): Promise<void> {
		await this.locked(() => {
			const {[spaceKey]: _previous, ...others} = this.all();
			writeJsonAtomic(
				this.file,
				width === null ? others : {...others, [spaceKey]: width},
			);
		});
	}

	/** Run `fn` holding the store's lock, which every writer of the file takes. */
	async locked<T>(fn: () => T): Promise<T> {
		return withFileLock(this.file, fn);
	}
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

/**
 * The exchange between `pappardelle companion` and a running TUI: the CLI
 * sends a request and reads the answer, the TUI watches for requests and
 * answers them.
 */
export interface CompanionRequestDao {
	/** Make the request, or make it again for a TUI that missed it. */
	send(request: LayoutRequest): Promise<void>;
	/** The TUI's answer to a request, once it has given one. */
	answerTo(id: string): LayoutAck | null;
	/** Take the request back, with any answer to it. */
	withdraw(id: string): Promise<void>;
	/**
	 * Calls `onRequest` for requests made while the TUI runs, again each time
	 * one is made again. One request can be reported more than once.
	 */
	watch(onRequest: (request: LayoutRequest) => void): () => void;
	/**
	 * Answer a request, unless the CLI stopped waiting and withdrew it: an
	 * answer nobody reads would stay behind.
	 */
	answer(ack: LayoutAck): Promise<void>;
}

function readRequest(file: string): LayoutRequest | null {
	const parsed = readJson(file) as LayoutRequest | null;
	return typeof parsed?.id === 'string' &&
		typeof parsed.space === 'string' &&
		(parsed.kind === 'width' || parsed.kind === 'layout')
		? parsed
		: null;
}

export class JsonCompanionRequestDao implements CompanionRequestDao {
	constructor(private readonly dir: string) {}

	async send(request: LayoutRequest): Promise<void> {
		this.writeRequest(request);
	}

	answerTo(id: string): LayoutAck | null {
		const parsed = readJson(this.ackPath(id)) as LayoutAck | null;
		return parsed?.id === id ? parsed : null;
	}

	async withdraw(id: string): Promise<void> {
		this.remove(id);
	}

	watch(onRequest: (request: LayoutRequest) => void): () => void {
		mkdirSync(this.dir, {recursive: true});
		const watcher = watch(this.dir, (_event, file) => {
			if (!file?.endsWith('.json') || file.endsWith(ACK_SUFFIX)) return;
			const request = readRequest(path.join(this.dir, file));
			if (request) onRequest(request);
		});
		return () => watcher.close();
	}

	async answer(ack: LayoutAck): Promise<void> {
		if (!existsSync(this.requestPath(ack.id))) return;
		this.writeAck(ack);
	}

	writeRequest(request: LayoutRequest): void {
		writeJsonAtomic(this.requestPath(request.id), request);
	}

	writeAck(ack: LayoutAck): void {
		writeJsonAtomic(this.ackPath(ack.id), ack);
	}

	remove(id: string): void {
		rmSync(this.requestPath(id), {force: true});
		rmSync(this.ackPath(id), {force: true});
	}

	private requestPath(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	private ackPath(id: string): string {
		return path.join(this.dir, `${id}${ACK_SUFFIX}`);
	}
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
	attemptMs?: number;
	attempts?: number;
	pollMs?: number;
};

/**
 * Ask a running TUI to lay out the space's companion and wait for its answer.
 * A busy machine can drop the TUI's notice of it, so the request is made
 * again after each wait; the TUI answers an id once.
 */
async function requestOfTui(
	options: {
		requests: CompanionRequestDao;
		space: string;
		kind: LayoutRequest['kind'];
		tuiIsRunning: () => boolean;
	} & RequestTiming,
): Promise<LayoutAck | Extract<Unapplied, {outcome: 'no-ack' | 'no-tui'}>> {
	const {requests, space, kind} = options;
	if (!options.tuiIsRunning()) return {outcome: 'no-tui'};

	const id = randomUUID();
	const attemptMs = options.attemptMs ?? 1000;
	const pollMs = options.pollMs ?? 50;
	try {
		for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
			await requests.send({id, space, kind});
			const deadline = Date.now() + attemptMs;
			while (Date.now() < deadline) {
				const ack = requests.answerTo(id);
				if (ack) return ack;
				await delay(pollMs);
			}
		}

		return {outcome: 'no-ack'};
	} finally {
		await requests.withdraw(id);
	}
}

/**
 * Ask the TUI to show a space's splits again after one was opened, resized
 * or closed. Opening a split waits for its frame to start, so this waits
 * longer than a width request.
 */
export async function requestCompanionLayout(
	options: {
		requests: CompanionRequestDao;
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
		widths: CompanionWidthDao;
		requests: CompanionRequestDao;
		space: string;
		width: PaneWidth | null;
		tuiIsRunning: () => boolean;
	} & RequestTiming,
): Promise<WidthOutcome> {
	await options.widths.set(options.space, options.width);
	const answer = await requestOfTui({...options, kind: 'width'});
	if ('outcome' in answer) return answer;
	if (answer.result !== 'applied') return {outcome: answer.result};
	return typeof answer.columns === 'number'
		? {outcome: 'applied', columns: answer.columns}
		: {outcome: 'failed'};
}
