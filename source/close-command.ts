import {spawn} from 'node:child_process';
import {selfLaunchArgs} from './runtime.ts';
import {getMainRepoRoot} from './config.ts';
import {confirm} from './confirm.ts';
import {runCloseHooks, type ClosingSpace} from './close-space.ts';
import {createLogger} from './logger.ts';
import type {TrackerIssue} from './providers/types.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import type {StateDaos} from './state-daos.ts';
import {MAIN_WORKTREE_KEY, tearDownSpace} from './space-utils.ts';
import {
	currentInnerServerSession,
	deleteQaSimulator,
	getSessionNames,
	getWorktreePath,
	killSpaceSessions,
} from './tmux.ts';
import {getIssue} from './tracker.ts';
import type {DeinitResult} from './workspace-deinit.ts';

// `pappardelle close <space>`: the CLI twin of pressing x in the TUI, for
// agents and scripts that can't answer the TUI's confirm popup. A running TUI
// drops the row on its next registry refresh.

const log = createLogger('close-command');

export type CloseCommandDeps = {
	registry: Pick<SpaceRegistryDao, 'has' | 'markClosing' | 'reopen' | 'remove'>;
	getIssue: (key: string) => Promise<TrackerIssue | null>;
	worktreePath: (key: string) => string | null;
	runHooks: (space: ClosingSpace) => Promise<DeinitResult>;
	killSpaceSessions: (key: string) => Promise<boolean>;
	cleanup: (key: string) => Promise<boolean>;
	sessionNames: (key: string) => {
		agent: string;
		companion: string;
		legacyAgent: string;
	};
	currentInnerSession: () => string | null;
	// The detached teardown starts here: a hook may have deleted the worktree
	// the close was run from.
	mainRepoRoot: string;
	spawnTeardown: (key: string, cwd: string) => void;
	isTTY: boolean;
	confirm: (question: string) => Promise<boolean>;
	print: (line: string) => void;
	logError: (message: string) => void;
};

export async function runCloseCommand(
	options: {key: string; yes: boolean},
	deps: CloseCommandDeps,
): Promise<number> {
	const {key} = options;
	if (!isOpenSpace(key, deps)) {
		deps.print(`No open space ${key}`);
		return 1;
	}

	if (!options.yes) {
		if (!deps.isTTY) {
			deps.print('close needs --yes when not run from a terminal');
			return 1;
		}

		const ok = await deps.confirm(
			`Close ${key}? Runs pre_workspace_deinit hooks and ends its agent and companion sessions. [y/N] `,
		);
		if (!ok) return 0;
	}

	const trackerIssue = await deps.getIssue(key).catch(() => null);

	if (!trackerIssue) {
		deps.print(
			`Couldn't load ${key} from the tracker; skipping profile pre_workspace_deinit hooks`,
		);
	}

	deps.print('Running pre_workspace_deinit hooks...');
	const deinit = await deps.runHooks({
		name: key,
		worktreePath: deps.worktreePath(key),
		trackerIssue,
	});
	if (!deinit.success) {
		deps.print(
			`pre_workspace_deinit hook failed: ${deinit.failedCommand ?? 'unknown'}. ${key} is still open`,
		);
		return 1;
	}

	const sessions = deps.sessionNames(key);
	const current = deps.currentInnerSession();
	if (
		current !== null &&
		[sessions.agent, sessions.companion, sessions.legacyAgent].includes(current)
	) {
		deps.print('Ending this session; teardown finishes in the background');
		deps.spawnTeardown(key, deps.mainRepoRoot);
		return 0;
	}

	deps.print('Ending sessions...');
	return (await tearDown(key, deps)) ? 0 : 1;
}

// The detached half of a self-close. Its stdio is ignored, so failures go to
// the log.
export async function runCloseTeardown(
	key: string,
	deps: CloseCommandDeps,
): Promise<number> {
	if (!isOpenSpace(key, deps)) {
		deps.logError(`No open space ${key}`);
		return 1;
	}

	return (await tearDown(key, {...deps, print: deps.logError})) ? 0 : 1;
}

function isOpenSpace(key: string, deps: CloseCommandDeps): boolean {
	// A space left closing by an interrupted close counts, so closing it
	// again finishes the job.
	return key !== MAIN_WORKTREE_KEY && deps.registry.has(key);
}

// The TUI leaves simulator cleanup running in the background; this process
// exits right after teardown, so it waits for the cleanup first.
async function tearDown(key: string, deps: CloseCommandDeps): Promise<boolean> {
	let cleanup: Promise<boolean> | undefined;
	const result = await tearDownSpace(key, {
		markClosing: async closing => deps.registry.markClosing(closing),
		reopen: async reopened => deps.registry.reopen(reopened),
		killSpaceSessions: deps.killSpaceSessions,
		removeSpace: async removed => deps.registry.remove(removed),
		async cleanup(cleanupKey) {
			cleanup = deps.cleanup(cleanupKey);
			return cleanup;
		},
		onKillFailure(failedKey) {
			deps.print(`Failed to end the tmux sessions for ${failedKey}`);
		},
	});
	await cleanup?.catch(() => false);
	if (
		result.outcome === 'mark-failed' ||
		result.outcome === 'unregister-failed'
	)
		throw result.error;
	return result.outcome === 'closed';
}

export function defaultCloseCommandDeps(daos: StateDaos): CloseCommandDeps {
	return {
		registry: daos.registry,
		getIssue,
		worktreePath: getWorktreePath,
		async runHooks(space) {
			return runCloseHooks(space);
		},
		async killSpaceSessions(key) {
			return killSpaceSessions(key);
		},
		async cleanup(key) {
			await daos.programStatus.remove(key);
			return deleteQaSimulator(key);
		},
		sessionNames: key => getSessionNames(key),
		currentInnerSession: () => currentInnerServerSession(process.env),
		mainRepoRoot: getMainRepoRoot(),
		spawnTeardown(key, cwd) {
			spawn(
				process.execPath,
				[...selfLaunchArgs(), 'close', key, '--yes', '--teardown-only'],
				{cwd, detached: true, stdio: 'ignore'},
			).unref();
		},
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		async confirm(question) {
			return confirm(question);
		},
		print(line) {
			console.log(line);
		},
		logError(message) {
			log.error(message);
		},
	};
}
