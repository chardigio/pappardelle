// Every keystroke one agent sends into another space's agent, and every wake-up
// it schedules there, is recorded here, so the user can see afterwards who
// approved what and why.

import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {DEFAULT_REPO_STATE_ROOT} from './tui-marker.ts';

export type SuperviseAction =
	| 'send'
	| 'answer'
	| 'queue'
	| 'schedule'
	| 'unschedule'
	| 'fire';

export type SuperviseEntry = {
	action: SuperviseAction;
	/** The target space. */
	key: string;
	/** What was typed or pressed, or the scheduled message. */
	sent?: string;
	/** The command on the permission prompt that was answered. */
	command?: string;
	verdict?: string;
	detail?: string;
};

/** `PAPPARDELLE_SPACE` of the supervising agent, `timer:{id}`, or `user`. */
export type Caller = string;

export function superviseLogPath(
	repo: string,
	root = DEFAULT_REPO_STATE_ROOT,
): string {
	return path.join(root, repo, 'supervise.jsonl');
}

export function recordSupervision(
	repo: string,
	caller: Caller,
	entry: SuperviseEntry,
	now: Date,
	root = DEFAULT_REPO_STATE_ROOT,
): void {
	const file = superviseLogPath(repo, root);
	mkdirSync(path.dirname(file), {recursive: true});
	appendFileSync(
		file,
		JSON.stringify({time: now.toISOString(), caller, ...entry}) + '\n',
	);
}
