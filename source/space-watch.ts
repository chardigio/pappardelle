// Watching many spaces at once for a supervising agent. Each answer carries a
// cursor of the states it saw, and the next call reports anything that differs
// from it, so a change made while the supervisor was answering another space
// is still reported on its next call.

import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {
	AGENT_STATES,
	BLOCKED,
	type AgentState,
	type AgentStateReport,
} from './agent-state.ts';

/**
 * What each space showed: its state, and for a prompt, question or dialog a
 * short fingerprint of it, so a new prompt after an answered one counts as a
 * change though the state is the same. Two identical prompts in a row still
 * look the same.
 */
export type WatchCursor = Record<string, string>;

/** A state, or `blocked` for any state that waits on a person. */
export type WatchTarget = AgentState | 'blocked';

export const WATCH_TARGETS: readonly WatchTarget[] = [
	...AGENT_STATES,
	'blocked',
];

export function encodeCursor(cursor: WatchCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(text: string): WatchCursor | null {
	let value: unknown;
	try {
		const bytes = Buffer.from(text, 'base64url');
		// Buffer skips characters it can't read rather than failing.
		if (bytes.toString('base64url') !== text) return null;
		value = JSON.parse(bytes.toString('utf8'));
	} catch {
		return null;
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return null;
	const entries = Object.entries(value);
	return entries.every(
		([, seen]) => typeof seen === 'string' && stateOf(seen) !== null,
	)
		? (Object.fromEntries(entries) as WatchCursor)
		: null;
}

/** The state part of a cursor entry. */
export function stateOf(seen: string): AgentState | null {
	const state = seen.split(':')[0];
	return (AGENT_STATES as readonly string[]).includes(state ?? '')
		? (state as AgentState)
		: null;
}

function seenAs(report: AgentStateReport): string {
	const prompt = [
		report.permission
			? [report.permission.tool, report.permission.command]
			: null,
		report.question
			? [
					report.question.question,
					...report.question.options.map(option => option.label),
				]
			: null,
		report.codexDialog?.title ?? null,
	].filter(part => part !== null);
	if (prompt.length === 0) return report.state;
	const hash = createHash('sha256')
		.update(JSON.stringify(prompt))
		.digest('hex')
		.slice(0, 8);
	return `${report.state}:${hash}`;
}

export function targetStates(
	until: readonly WatchTarget[],
): ReadonlySet<AgentState> | null {
	if (until.length === 0) return null;
	return new Set(
		until.flatMap(target => (target === 'blocked' ? BLOCKED : [target])),
	);
}

export function snapshot(reports: readonly AgentStateReport[]): WatchCursor {
	return Object.fromEntries(
		reports.map(report => [report.key, seenAs(report)]),
	);
}

/**
 * The spaces to report: each one that shows something other than `baseline`
 * and, when there are targets, is in one of them. A space with no session is
 * always news, so a mistyped key doesn't wait out the timeout.
 */
export function changesSince(
	baseline: WatchCursor,
	reports: readonly AgentStateReport[],
	targets: ReadonlySet<AgentState> | null,
): AgentStateReport[] {
	return reports.filter(
		report =>
			seenAs(report) !== baseline[report.key] &&
			(targets === null ||
				targets.has(report.state) ||
				report.state === 'no_session'),
	);
}
