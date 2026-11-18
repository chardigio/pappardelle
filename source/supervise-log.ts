// Every keystroke one agent sends into another space's agent, and every wake-up
// it schedules there, is recorded here, so the user can see afterwards who
// approved what and why.

import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {DEFAULT_REPO_STATE_ROOT} from './tui-marker.ts';

export type SuperviseAction =
	| 'send'
	| 'watch'
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

/** The supervising agent's space, `timer:{id}`, or `user`. */
export type Caller = string;

/**
 * Who is acting, from the session's environment. The main space's session
 * has no PAPPARDELLE_SPACE, since its checkout changes branch, but every
 * space's session carries PAPPARDELLE_REPO.
 */
export function callerFromEnv(env: NodeJS.ProcessEnv): Caller {
	if (env['PAPPARDELLE_SPACE']) return env['PAPPARDELLE_SPACE'];
	return env['PAPPARDELLE_REPO'] ? MAIN_WORKTREE_KEY : 'user';
}

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
