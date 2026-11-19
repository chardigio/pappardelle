// Starting the rail outside herdr, on the herdr backend.
//
// The tmux path re-execs Pappardelle inside a `pappardelle-<repo>` session and
// attaches to it. The herdr equivalent is a workspace whose root pane runs the
// same TUI command, with the user's terminal then attached to the herdr client
// that shows it.
//
// The workspace is labelled with the repo, so a second `pappardelle` in the
// same repo reuses it rather than stacking a duplicate beside it.

import {execFileSync, spawnSync} from 'node:child_process';
import {createLogger} from '../logger.ts';

const log = createLogger('herdr-launch');

export type LaunchDeps = {
	/** Run a herdr CLI command and return its parsed result. */
	herdr: (args: readonly string[]) => Promise<Record<string, unknown>>;
	/** Hand the terminal to the herdr client. */
	attach: () => void;
	/** Print what happened, for the cases where this returns false. */
	print: (line: string) => void;
};

function workspaceLabel(repoName: string): string {
	return `pappardelle:${repoName}`;
}

/**
 * Find the workspace already labelled for this repo, if a live one exists.
 */
export async function findRepoWorkspace(
	repoName: string,
	herdr: LaunchDeps['herdr'],
): Promise<string | null> {
	try {
		const listed = await herdr(['workspace', 'list']);
		const workspaces =
			(listed['workspaces'] as Array<Record<string, unknown>> | undefined) ??
			[];
		const match = workspaces.find(
			workspace => workspace['label'] === workspaceLabel(repoName),
		);
		return typeof match?.['workspace_id'] === 'string'
			? match['workspace_id']
			: null;
	} catch (error) {
		log.debug(`Could not list herdr workspaces: ${String(error)}`);
		return null;
	}
}

/**
 * Create (or reuse) the repo's workspace and run `command` in its root pane.
 * Returns the workspace id, or null when herdr would not cooperate.
 */
export async function openRepoWorkspace(options: {
	repoName: string;
	cwd: string;
	command: string;
	env?: Record<string, string>;
	herdr: LaunchDeps['herdr'];
}): Promise<string | null> {
	const {repoName, cwd, command, env = {}, herdr} = options;

	const existing = await findRepoWorkspace(repoName, herdr);
	if (existing) {
		return existing;
	}

	try {
		const args = [
			'workspace',
			'create',
			'--label',
			workspaceLabel(repoName),
			'--cwd',
			cwd,
		];
		for (const [name, value] of Object.entries(env)) {
			args.push('--env', `${name}=${value}`);
		}

		const created = await herdr(args);
		const workspace = created['workspace'] as
			| {workspace_id?: string}
			| undefined;
		const rootPane = created['root_pane'] as {pane_id?: string} | undefined;
		const workspaceId = workspace?.workspace_id;
		const paneId = rootPane?.pane_id;
		if (!workspaceId || !paneId) return null;

		await herdr(['pane', 'run', paneId, command]);
		await herdr(['workspace', 'focus', workspaceId]).catch(() => undefined);
		return workspaceId;
	} catch (error) {
		log.error(
			'Could not open a herdr workspace',
			error instanceof Error ? error : undefined,
		);
		return null;
	}
}

/** `true` when the herdr CLI is on PATH, so the backend can actually run. */
export function herdrAvailable(): boolean {
	try {
		execFileSync('herdr', ['--version'], {
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Start the rail in a herdr workspace and attach the terminal to it.
 *
 * Returns true once the client has been handed the terminal (which normally
 * ends this process), false when herdr could not be used at all.
 */
export async function launchHerdrWorkspace(
	repoName: string,
	command: string,
	cwd: string,
	env: Record<string, string>,
): Promise<boolean> {
	if (!herdrAvailable()) {
		console.error(
			'\x1b[31mError: backend is herdr but the `herdr` command is not installed.\x1b[0m',
		);
		console.error(
			'Install it from https://herdr.dev, or set PAPPARDELLE_BACKEND=tmux.',
		);
		return false;
	}

	const {herdrCli} = await import('./cli.ts');
	const workspaceId = await openRepoWorkspace({
		repoName,
		cwd,
		command,
		env,
		herdr: herdrCli as LaunchDeps['herdr'],
	});
	if (!workspaceId) {
		console.error(
			'\x1b[31mError: could not open a herdr workspace for this repo.\x1b[0m',
		);
		return false;
	}

	// Attach the terminal to the herdr client, as the tmux path attaches to its
	// session. stdio is inherited so the client owns the terminal from here on.
	spawnSync('herdr', [], {stdio: 'inherit', env: process.env});
	return true;
}
