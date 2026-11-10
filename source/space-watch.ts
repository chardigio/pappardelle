// Watching many spaces at once for a supervising agent. Each answer carries a
// cursor of the states it saw, and the next call reports anything that differs
// from it, so a change made while the supervisor was answering another space
// is still reported on its next call.

import {Buffer} from 'node:buffer';
import {
	AGENT_STATES,
	BLOCKED,
	type AgentState,
	type AgentStateReport,
} from './agent-state.ts';

export type WatchCursor = Record<string, AgentState>;

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
		value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
	} catch {
		return null;
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return null;
	const entries = Object.entries(value);
	return entries.every(([, state]) =>
		(AGENT_STATES as readonly unknown[]).includes(state),
	)
		? (Object.fromEntries(entries) as WatchCursor)
		: null;
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
	return Object.fromEntries(reports.map(report => [report.key, report.state]));
}

/**
 * The spaces to report: each one whose state differs from `baseline` and, when
 * there are targets, is in one of them.
 */
export function changesSince(
	baseline: WatchCursor,
	reports: readonly AgentStateReport[],
	targets: ReadonlySet<AgentState> | null,
): AgentStateReport[] {
	return reports.filter(
		report =>
			report.state !== baseline[report.key] &&
			(targets === null || targets.has(report.state)),
	);
}
