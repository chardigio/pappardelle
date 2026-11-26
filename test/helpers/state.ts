import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {ClaudeSessionState} from '../../source/claude-status.ts';
import {statusSocket} from '../../source/program-status-monitor.ts';
import {
	newSpaceIdentity,
	worktreePathFor,
	type SpaceIdentityDao,
} from '../../source/space-identity.ts';
import type {SqliteSpaceIdentityDao} from '../../source/space-identity-sqlite.ts';
import {
	createStateDaos,
	openImportedStateDb,
	type StateDaos,
} from '../../source/state-daos.ts';
import {
	closeStateDb,
	openStateDb,
	stateDbPath,
	statusSocketPath,
} from '../../source/state-db.ts';
import {initTmuxState} from '../../source/tmux.ts';
import {sendHookEvent, serveTestHub} from './status-daemon.ts';
import {teardown, type Cleanup} from './teardown.ts';
import {until} from './wait.ts';

export type TestState = {
	daos: StateDaos;
	repo: string;
	stateDir: string;
};

/**
 * Stores on a temp directory of the test's own, with `spaces` open and named
 * as idow names them. A status daemon's hub serves the directory's socket
 * from this process, so nothing the test reads or sends status through
 * starts a daemon.
 */
export function testState(
	options: {
		repo?: string;
		/** A directory to keep the state in, in place of a new temp directory. */
		stateDir?: string;
		spaces?: string[];
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
	fs.mkdirSync(stateDir, {recursive: true});
	serveTestHub(statusSocketPath(stateDir), cleanup);
	const daos = createStateDaos({
		repo,
		stateDir,
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
	if (options.spaces) openSpaces(daos, repo, stateDir, options.spaces);
	return {daos, repo, stateDir};
}

/** Open `keys` in one write, as the registry's own writes would leave them. */
function openSpaces(
	daos: StateDaos,
	repo: string,
	stateDir: string,
	keys: readonly string[],
): void {
	const state = openImportedStateDb(stateDbPath(stateDir), stateDir);
	state.db.transaction(() => {
		const insert = state.db.query(
			`INSERT INTO spaces (repo, key, state, owner_pid) VALUES (?, ?, 'open', NULL)`,
		);
		for (const key of keys) insert.run(repo, key);
		(daos.spaceIdentities as SqliteSpaceIdentityDao).fillMissing(keys);
	})();
}

const STATUS_ARRIVAL_TIMEOUT_MS = 5000;

/**
 * Report a hook status the way the hook does, as a line to the status
 * daemon. Returns once the state's stores read it.
 */
export async function writeClaudeStatus(
	state: TestState,
	reported: ClaudeSessionState,
): Promise<void> {
	await sendHookEvent(statusSocketPath(state.stateDir), reported);
	// What arrives has no key for a field that was left undefined.
	const sent = Object.fromEntries(
		Object.entries(reported).filter(([, value]) => value !== undefined),
	);
	await until(
		async () => {
			const stored = await state.daos.claudeStatus.readState(
				reported.workspaceName,
			);
			return stored.kind === 'state' && isDeepStrictEqual(stored.state, sent);
		},
		{
			what: `the status of ${reported.workspaceName} to reach the stores`,
			timeoutMs: STATUS_ARRIVAL_TIMEOUT_MS,
			intervalMs: 2,
		},
	);
}

/** `testState`, also handed to tmux.ts for the functions that read stores. */
export function testTmuxState(
	options: Parameters<typeof testState>[0] = {},
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

export type RecordedSession = {
	sessionId: string;
	pid?: number | null;
	started?: string | null;
};

/**
 * Replace a space's agent sessions in the database at `dbPath` as the agent's
 * hook records them, which no store method does. A string is a session id.
 */
export function recordAgentSessions(
	dbPath: string,
	repo: string,
	key: string,
	sessions: Record<string, RecordedSession | string>,
): void {
	const {db} = openStateDb(dbPath);
	db.transaction(() => {
		db.query('DELETE FROM agent_sessions WHERE repo = ? AND key = ?').run(
			repo,
			key,
		);
		const insert = db.query(
			`INSERT INTO agent_sessions (repo, key, agent_profile, session_id, pid, started)
			VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const [profile, session] of Object.entries(sessions)) {
			const {
				sessionId,
				pid = 1,
				started = null,
			} = typeof session === 'string' ? {sessionId: session} : session;
			insert.run(repo, key, profile, sessionId, pid, started);
		}
	})();
}
