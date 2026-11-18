import fs from 'node:fs';
import path from 'node:path';
import {sameFile} from './same-file.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';

export class NoTargetSpaceError extends Error {
	constructor() {
		super('Not in a Pappardelle workspace; pass --space KEY');
	}
}

/**
 * The space a companion verb acts on: --space when given, else the space
 * this process runs in. A --space value is typed by hand, so it resolves like
 * any issue key (`696` gains the team prefix). PAPPARDELLE_SPACE is already
 * the exact key and is used as is. The main space has no PAPPARDELLE_SPACE,
 * so it is only reachable with --space main.
 */
export function resolveTargetSpace(options: {
	flag?: string;
	env: NodeJS.ProcessEnv;
	resolve: (raw: string) => string;
}): string {
	if (options.flag?.trim()) return options.resolve(options.flag);
	const own = options.env['PAPPARDELLE_SPACE']?.trim();
	if (!own) throw new NoTargetSpaceError();
	return own;
}

/** Where Pappardelle puts a repo's worktrees, one per space. */
export function worktreesDir(home: string, repoName: string): string {
	return path.join(home, '.worktrees', repoName);
}

export function worktreePathFor(
	home: string,
	repoName: string,
	key: string,
): string {
	return path.join(worktreesDir(home, repoName), key);
}

/**
 * The space the caller is in: PAPPARDELLE_SPACE, else the checkout that
 * holds `cwd`. Codex starts MCP servers with a filtered environment and
 * OpenCode from a shared service, so PAPPARDELLE_SPACE doesn't reach them,
 * and an agent started by hand in a worktree never had it; all of them run
 * in the space's directory. Paths are compared by file identity, so a
 * directory reached through a symlink belongs to the same space.
 */
export function callerSpace(options: {
	env: NodeJS.ProcessEnv;
	cwd: string;
	home: string;
	/** Unknown outside a git checkout, where only PAPPARDELLE_SPACE names a space. */
	checkout: {repoName: string; mainRoot: string} | undefined;
}): string | undefined {
	const own = options.env['PAPPARDELLE_SPACE']?.trim();
	if (own) return own;
	if (!options.checkout) return undefined;
	const {repoName, mainRoot} = options.checkout;
	const worktrees = worktreesDir(options.home, repoName);
	let directory: string;
	try {
		directory = fs.realpathSync(options.cwd);
	} catch {
		return undefined;
	}

	for (;;) {
		if (sameFile(directory, mainRoot)) return MAIN_WORKTREE_KEY;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		if (sameFile(parent, worktrees)) return path.basename(directory);
		directory = parent;
	}
}
