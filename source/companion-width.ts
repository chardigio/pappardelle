// Per-space companion widths, and the requests the CLI sends the TUI to lay
// out a space's companion, so `pappardelle companion` can report whether the
// running TUI applied the change.

import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isPaneWidth, type PaneWidth} from './layout-sizing.ts';

export function companionWidthsPath(repoName: string, baseDir: string) {
	return path.join(baseDir, 'repos', repoName, 'companion-widths.json');
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
