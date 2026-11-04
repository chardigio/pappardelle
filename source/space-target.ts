import path from 'node:path';

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

/**
 * The space a directory belongs to, from where Pappardelle puts worktrees.
 * Codex starts MCP servers with a filtered environment and OpenCode from a
 * shared service, so PAPPARDELLE_SPACE doesn't reach them, but both start the
 * server in the session's directory.
 */
export function spaceFromWorktreePath(
	directory: string,
	home: string,
	repoName: string,
): string | undefined {
	const relative = path.relative(
		path.join(home, '.worktrees', repoName),
		directory,
	);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
		return undefined;
	return relative.split(path.sep)[0];
}
