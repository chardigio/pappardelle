import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import type {ClaudeSessionState} from '../../source/claude-status.ts';
import {statusSocket} from '../../source/program-status-monitor.ts';
import {
	newSpaceIdentity,
	worktreePathFor,
	type SpaceIdentityDao,
} from '../../source/space-identity.ts';
import {getRegistryPathForRepo} from '../../source/space-registry.ts';
import {createStateDaos, type StateDaos} from '../../source/state-daos.ts';
import {
	closeStateDb,
	stateDbPath,
	statusSocketPath,
} from '../../source/state-db.ts';
import {initTmuxState} from '../../source/tmux.ts';
import {sendHookEvent, serveTestHub} from './status-daemon.ts';
import {teardown, type Cleanup} from './teardown.ts';

/** Whether this test run keeps state in SQLite (PAPPARDELLE_SQLITE_STATE=1). */
export const sqliteRun = process.env['PAPPARDELLE_SQLITE_STATE'] === '1';

export type TestState = {
	daos: StateDaos;
	repo: string;
	stateDir: string;
	registryFile: string;
	/** Whether these stores keep rows. */
	sqlite: boolean;
};

/**
 * Stores on a temp directory of the test's own, in the run's mode unless
 * `sqlite` says otherwise. `spaces` is written as a registry file, the way a
 * process without the database would have left it. With `sqlite` on, a
 * status daemon's hub serves the directory's socket from this process, so
 * nothing the test reads or sends status through starts a daemon.
 */
export function testState(
	options: {
		repo?: string;
		/** A directory to keep the state in, in place of a new temp directory. */
		stateDir?: string;
		spaces?: string[];
		sqlite?: boolean;
		clock?: () => Date;
		home?: string;
		env?: NodeJS.ProcessEnv;
		mainRoot?: () => string;
		/** Where to undo it, for state a whole file shares; the test's end by default. */
		cleanup?: Cleanup;
	} = {},
): TestState {
	const cleanup = options.cleanup ?? teardown;
	const repo = options.repo ?? 'repo';
	const stateDir =
		options.stateDir ??
		fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-')));
	const registryFile = getRegistryPathForRepo(repo, stateDir);
	fs.mkdirSync(path.dirname(registryFile), {recursive: true});
	if (options.spaces)
		fs.writeFileSync(registryFile, JSON.stringify(options.spaces));

	const sqlite = options.sqlite ?? sqliteRun;
	if (sqlite) serveTestHub(statusSocketPath(stateDir), cleanup);
	const daos = createStateDaos({
		repo,
		stateDir,
		sqlite,
		clock: options.clock,
		home: options.home,
		env: options.env,
		mainRoot: options.mainRoot,
	});
	cleanup(() => {
		daos.disconnectStatusDaemon();
		closeStateDb(stateDbPath(stateDir));
		fs.rmSync(stateDir, {recursive: true, force: true});
	});
	return {daos, repo, stateDir, registryFile, sqlite};
}

const STATUS_ARRIVAL_TIMEOUT_MS = 5000;

export const claudeStatusFile = (state: TestState, statusKey: string) =>
	path.join(state.stateDir, 'claude-status', `${statusKey}.json`);

/**
 * Report a hook status the way the hook does in this state's mode: its
 * status file, or with `sqlite` on a line to the status daemon. Returns once
 * the state's stores read it.
 */
export async function writeClaudeStatus(
	state: TestState,
	reported: ClaudeSessionState,
): Promise<void> {
	if (!state.sqlite) {
		const file = claudeStatusFile(state, reported.workspaceName);
		const temporary = `${file}.tmp.${process.pid}`;
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(temporary, JSON.stringify(reported, null, 2));
		fs.renameSync(temporary, file);
		return;
	}

	await sendHookEvent(statusSocketPath(state.stateDir), reported);
	// What arrives has no key for a field that was left undefined.
	const sent = Object.fromEntries(
		Object.entries(reported).filter(([, value]) => value !== undefined),
	);
	const deadline = Date.now() + STATUS_ARRIVAL_TIMEOUT_MS;
	for (;;) {
		const stored = await state.daos.claudeStatus.readState(
			reported.workspaceName,
		);
		if (stored.kind === 'state' && isDeepStrictEqual(stored.state, sent))
			return;
		if (Date.now() > deadline)
			throw new Error(
				`The status of ${reported.workspaceName} did not reach the stores`,
			);
		await delay(2);
	}
}

/** `testState`, also handed to tmux.ts for the functions that read stores. */
export function testTmuxState(
	options: Parameters<typeof testState>[1] = {},
): TestState {
	const state = testState(options);
	initTmuxState(state.daos);
	return state;
}

/**
 * Record identities for `keys` as idow records them when it opens a space:
 * the worktree under `~/.worktrees` and the names the creation rule gives.
 */
export async function recordIdentities(
	state: TestState,
	keys: readonly string[],
	home = os.homedir(),
): Promise<void> {
	for (const key of keys) {
		await state.daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: state.repo,
				key,
				worktreePath: worktreePathFor(home, state.repo, key),
				socket: statusSocket(),
			}),
		);
	}
}

/**
 * `testTmuxState` for a test file whose spaces were opened by idow, for its
 * `beforeAll`: tmux.ts reads one set of stores for the whole file.
 */
export async function testTmuxSpaces(
	repo: string,
	keys: readonly string[],
	cleanup?: Cleanup,
): Promise<TestState> {
	const state = testTmuxState({repo, cleanup});
	await recordIdentities(state, keys);
	return state;
}

/**
 * An identity store holding `keys` as idow names them, for code that takes
 * the store as a dependency. `keys` is read on each call, so a test can add
 * spaces as it goes.
 */
export function idowIdentities(
	repo: string,
	keys: () => readonly string[],
): Pick<SpaceIdentityDao, 'get' | 'list'> {
	const identity = (key: string) =>
		newSpaceIdentity({
			repo,
			key,
			worktreePath: `/w/${key}`,
			socket: 'pappardelle_inner',
		});
	return {
		get: key =>
			keys().includes(key)
				? {kind: 'identity', identity: identity(key)}
				: {kind: 'unknown'},
		list: () => ({
			kind: 'identities',
			identities: keys().map(key => identity(key)),
		}),
	};
}
