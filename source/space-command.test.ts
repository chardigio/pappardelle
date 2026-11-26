import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {storeTest} from '../test/helpers/store-test.ts';
import {
	testState,
	writeClaudeStatus,
	type TestState,
	recordAgentSessions,
} from '../test/helpers/state.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';
import type {
	ProgramStatusSnapshot,
	StatusPane,
} from './program-status-monitor.ts';
import {
	runSpaceCommand,
	type SpaceCommandDeps,
	type SpaceDaos,
} from './space-command.ts';
import {newSpaceIdentity, worktreePathFor} from './space-identity.ts';
import {stateDbPath} from './state-db.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const HOME = '/home/u';
const MAIN_ROOT = '/home/u/workspace/repo';
const CLOCK = () => new Date('2026-11-17T12:00:00Z');

type Pane = {
	session: string;
	id: string;
	/** The session's current pane. */
	current?: boolean;
	/** The pane the session pinned as its status pane. */
	pinned?: string;
	name?: string;
};

/** An inner tmux server holding `panes`, recording every verb it is asked to run. */
function fakeTmux(panes: Pane[] = []) {
	const verbs: string[] = [];
	const runner: OuterTmuxRunner = args => {
		verbs.push(args[0]!);
		if (args[0] === 'list-panes') {
			return {
				status: 0,
				stdout: panes
					.map(pane =>
						[
							pane.session,
							pane.id,
							pane.name ?? '',
							pane.current ? '11' : '10',
							pane.pinned ?? '',
							pane.id,
							'4242',
							'0',
							'1',
							'',
						].join('\t'),
					)
					.join('\n'),
			};
		}

		if (args[0] === 'has-session') {
			const session = args[2]!.slice(1, -1);
			return {
				status: panes.some(pane => pane.session === session) ? 0 : 1,
				stdout: '',
			};
		}

		return {status: 1, stdout: ''};
	};

	return {runner, verbs};
}

/** Stores whose spaces live where idow puts them under HOME. */
function stateOf(options: Parameters<typeof testState>[0] = {}): TestState {
	return testState({home: HOME, mainRoot: () => MAIN_ROOT, ...options});
}

/**
 * A space as idow opens it: its identity recorded, then registered unless
 * idow is still setting it up.
 */
async function openSpace(
	state: TestState,
	key: string,
	options: {home?: string; socket?: string; register?: boolean} = {},
): Promise<void> {
	await state.daos.spaceIdentities.record(
		newSpaceIdentity({
			repo: state.repo,
			key,
			worktreePath:
				key === 'main'
					? MAIN_ROOT
					: worktreePathFor(options.home ?? HOME, state.repo, key),
			socket: options.socket ?? 'pappardelle_inner',
		}),
	);
	if (key !== 'main' && options.register !== false)
		await state.daos.registry.add(key);
}

function deps(
	state: TestState,
	overrides: Partial<SpaceCommandDeps> = {},
): SpaceCommandDeps & {output: () => string; errors: () => string} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		checkout: () => ({
			kind: 'checkout',
			checkout: {repoName: state.repo, mainRoot: MAIN_ROOT},
		}),
		daos: () => state.daos,
		env: {},
		cwd: '/',
		runner: fakeTmux().runner,
		gitBranch: async directory =>
			directory === MAIN_ROOT ? 'master' : path.basename(directory),
		resolveKey: raw => raw,
		out: text => out.push(text),
		err: text => err.push(text),
		...overrides,
		output: () => out.join('\n'),
		errors: () => err.join('\n'),
	};
}

async function run(
	argv: string[],
	d: ReturnType<typeof deps>,
): Promise<{code: number; stdout: string; stderr: string}> {
	const code = await runSpaceCommand(argv, d);
	return {code, stdout: d.output(), stderr: d.errors()};
}

/** A space's sessions as the agent's hook records them, which no store method does. */
function recordSessions(
	state: TestState,
	key: string,
	sessions: Record<string, string>,
): void {
	recordAgentSessions(stateDbPath(state.stateDir), state.repo, key, sessions);
}

/** The stores, with the lookups of `keys` in one store failing as an unreadable store's do. */
function unreadableFor(
	state: TestState,
	store: 'spaceState' | 'agentSessions',
	keys: readonly string[],
): SpaceDaos {
	const unreadable = {
		kind: 'unreadable' as const,
		error: new Error('disk I/O error'),
	};
	const {spaceState, agentSessions} = state.daos;
	return {
		...state.daos,
		spaceState:
			store === 'spaceState'
				? Object.assign(Object.create(spaceState) as typeof spaceState, {
						lookup: (key: string) =>
							keys.includes(key) ? unreadable : spaceState.lookup(key),
					})
				: spaceState,
		agentSessions:
			store === 'agentSessions'
				? Object.assign(Object.create(agentSessions) as typeof agentSessions, {
						sessions: (key: string) =>
							keys.includes(key) ? unreadable : agentSessions.sessions(key),
					})
				: agentSessions,
	};
}

/** One space history, written through the stores in a fixed order. */
async function history(state: TestState): Promise<void> {
	const {registry, spaceState} = state.daos;
	await openSpace(state, 'main');
	await openSpace(state, 'STA-2', {register: false});
	await registry.reserveStart('STA-2', process.pid);
	await registry.add('STA-2');
	await openSpace(state, 'STA-10');
	await openSpace(state, 'STA-1');
	await spaceState.write('STA-2', {
		profile: 'dev',
		issueTitle: 'Fix the login page',
	});
	await spaceState.writeMany([
		{
			key: 'STA-2',
			patch: {prNumber: 80, pipeline: 'passing', unresolvedCommentCount: 2},
		},
		{key: 'STA-1', patch: {pipeline: null}},
	]);
	await spaceState.addPrLink('STA-2', {
		host: 'github.com',
		project: 'o/r',
		localBranch: 'STA-2',
		remoteBranch: 'sd-login',
		url: 'https://github.com/o/r/pull/80',
		number: 80,
	});
	recordSessions(state, 'STA-2', {claude: 'c-1', codex: 'x-1'});
}

test('get and list report one history as the stores hold it', async () => {
	const state = stateOf({clock: CLOCK});
	await history(state);
	const tmux = fakeTmux([
		{session: 'agent-repo-STA-2', id: '%3', current: true},
	]).runner;
	const get = await run(
		['get', 'STA-2', '--json'],
		deps(state, {runner: tmux}),
	);
	const list = await run(['list', '--json'], deps(state, {runner: tmux}));
	const record = JSON.parse(get.stdout) as Record<string, unknown>;
	expect(record).toMatchObject({
		repo: 'repo',
		key: 'STA-2',
		phase: 'open',
		title: 'Fix the login page',
		worktreePath: '/home/u/.worktrees/repo/STA-2',
		branch: 'STA-2',
		profile: 'dev',
		agentSessions: {claude: 'c-1', codex: 'x-1'},
		panes: {agent: '%3', companion: null},
		prNumber: 80,
		prLinks: [
			{
				url: 'https://github.com/o/r/pull/80',
				number: 80,
				remoteBranch: 'sd-login',
			},
		],
		pipeline: 'passing',
		unresolvedCommentCount: 2,
	});
	expect(
		(JSON.parse(list.stdout) as Array<{key: string}>).map(record => record.key),
	).toStrictEqual(['main', 'STA-10', 'STA-2', 'STA-1']);
});

test('session names and targets encode dots and underscores, and name main', async () => {
	const state = stateOf();
	for (const key of ['a.b_c', 'bd-a3f8e9.1']) await openSpace(state, key);
	const tmuxOf = async (key: string) => {
		const {stdout} = await run(['get', key, '--field', 'tmux'], deps(state));
		return JSON.parse(stdout) as unknown;
	};
	expect(await tmuxOf('a.b_c')).toStrictEqual({
		socket: 'pappardelle_inner',
		socketFlag: '-L',
		agentSession: 'agent-repo-a_b__c',
		companionSession: 'companion-repo-a_b__c',
		legacyAgentSession: 'claude-repo-a_b__c',
		agentTarget: '=agent-repo-a_b__c:',
		companionTarget: '=companion-repo-a_b__c:',
	});
	expect(await tmuxOf('bd-a3f8e9.1')).toMatchObject({
		agentTarget: '=agent-repo-bd-a3f8e9_1:',
	});
	await openSpace(state, 'main');
	expect(await tmuxOf('main')).toMatchObject({
		agentTarget: '=agent-repo-main:',
	});
});

test('a socket path is passed with -S', async () => {
	const state = stateOf({env: {PAPPARDELLE_TMUX_SOCKET: '/tmp/inner.sock'}});
	await openSpace(state, 'STA-1', {socket: '/tmp/inner.sock'});
	const result = await run(
		['get', 'STA-1', '--field', 'tmux.socketFlag', '--field', 'tmux.socket'],
		deps(state),
	);
	expect(JSON.parse(result.stdout)).toStrictEqual({
		'tmux.socketFlag': '-S',
		'tmux.socket': '/tmp/inner.sock',
	});
});

storeTest(
	'an unregistered key with a live agent session is starting',
	async state => {
		// idow records the space's names before it starts its sessions.
		await openSpace(state, 'STA-5', {register: false});
		const tmux = fakeTmux([{session: 'agent-repo-STA-5', id: '%1'}]).runner;
		const result = await run(
			['get', 'STA-5', '--field', 'phase'],
			deps(state, {runner: tmux}),
		);
		expect(result).toStrictEqual({code: 0, stdout: 'starting', stderr: ''});
	},
);

test('a key that is not open but has stored state is closed, and one with neither is unknown', async () => {
	const state = stateOf();
	await state.daos.spaceState.write('STA-7', {profile: 'dev'});
	expect(
		await run(['get', 'STA-7', '--field', 'phase'], deps(state)),
	).toMatchObject({
		code: 0,
		stdout: 'closed',
	});
	expect(await run(['get', 'STA-8'], deps(state))).toStrictEqual({
		code: 1,
		stdout: '',
		stderr: 'No space STA-8',
	});
});

test('a typed key the stores lack is looked up again as Pappardelle resolves it', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-8');
	const result = await run(
		['get', '8', '--field', 'key'],
		deps(state, {resolveKey: raw => `STA-${raw}`}),
	);
	expect(result).toStrictEqual({code: 0, stdout: 'STA-8', stderr: ''});
});

test('a registry or state store that cannot be read exits 3, never 1', async () => {
	const unreadableRegistry = stateOf();
	fs.writeFileSync(
		stateDbPath(unreadableRegistry.stateDir),
		'not a database '.repeat(600),
	);
	const get = await run(
		['get', 'STA-1', '--field', 'profile'],
		deps(unreadableRegistry),
	);
	expect(get.code).toBe(3);
	const list = await run(['list'], deps(unreadableRegistry));
	expect(list.code).toBe(3);

	const unreadableState = stateOf();
	await openSpace(unreadableState, 'STA-1');
	const result = await run(
		['get', 'STA-1', '--field', 'profile'],
		deps(unreadableState, {
			daos: () => unreadableFor(unreadableState, 'spaceState', ['STA-1']),
		}),
	);
	expect(result.code).toBe(3);
	expect(result.stderr).toMatch(/Could not read the state of STA-1/);
});

storeTest(
	'an agent-sessions store that cannot be read fails only the lookups that read it',
	async state => {
		await openSpace(state, 'STA-1');
		await state.daos.spaceState.write('STA-1', {profile: 'dev'});
		const daos = () => unreadableFor(state, 'agentSessions', ['STA-1']);
		expect(
			await run(['get', 'STA-1', '--field', 'profile'], deps(state, {daos})),
		).toStrictEqual({code: 0, stdout: 'dev', stderr: ''});
		const sessions = await run(
			['get', 'STA-1', '--field', 'agentSessions.claude'],
			deps(state, {daos}),
		);
		expect(sessions.code).toBe(3);
		expect(sessions.stderr).toMatch(/Could not read the state of STA-1/);
	},
);

storeTest(
	'space list prints the spaces it could read and names the one it could not',
	async state => {
		await openSpace(state, 'STA-1');
		await openSpace(state, 'STA-2');
		await state.daos.spaceState.write('STA-1', {profile: 'dev'});
		const daos = () => unreadableFor(state, 'spaceState', ['STA-2']);

		const json = await run(['list', '--json'], deps(state, {daos}));
		expect(json.code).toBe(3);
		expect(
			(JSON.parse(json.stdout) as Array<{key: string}>).map(
				record => record.key,
			),
		).toStrictEqual(['main', 'STA-1']);
		expect(json.stderr).toMatch(/^Could not read the state of STA-2: [^\n]+$/);

		const plain = await run(['list'], deps(state, {daos}));
		expect(plain.code).toBe(3);
		expect(
			plain.stdout.split('\n').map(line => line.split(' ')[0]),
		).toStrictEqual(['KEY', 'main', 'STA-1']);
		expect(plain.stderr).toBe(json.stderr);
	},
);

test('a space named by PAPPARDELLE_SPACE belongs to PAPPARDELLE_REPO, not the nested checkout', async () => {
	const outer = stateOf({repo: 'repo'});
	const nested = stateOf({repo: 'nested'});
	await openSpace(outer, 'STA-1');
	await outer.daos.spaceState.write('STA-1', {profile: 'dev'});
	const result = await run(
		['get', '--field', 'repo', '--field', 'profile', '--field', 'worktreePath'],
		deps(outer, {
			checkout: () => ({
				kind: 'checkout',
				checkout: {repoName: 'nested', mainRoot: MAIN_ROOT},
			}),
			daos: repo => (repo === 'repo' ? outer.daos : nested.daos),
			env: {PAPPARDELLE_SPACE: 'STA-1', PAPPARDELLE_REPO: 'repo'},
		}),
	);
	expect(JSON.parse(result.stdout)).toStrictEqual({
		repo: 'repo',
		profile: 'dev',
		worktreePath: '/home/u/.worktrees/repo/STA-1',
	});
});

test('with no key and no PAPPARDELLE_SPACE, the space is the worktree the caller is in', async () => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'space-home-')),
	);
	teardown(() => fs.rmSync(home, {recursive: true, force: true}));
	const state = stateOf({home});
	const inside = path.join(home, '.worktrees', 'repo', 'STA-1', 'src');
	fs.mkdirSync(inside, {recursive: true});
	await openSpace(state, 'STA-1', {home});
	expect(
		await run(['get', '--field', 'key'], deps(state, {cwd: inside})),
	).toMatchObject({
		code: 0,
		stdout: 'STA-1',
	});
	expect(await run(['get'], deps(state, {cwd: home}))).toStrictEqual({
		code: 1,
		stdout: '',
		stderr: 'Not in a Pappardelle space; pass a KEY',
	});
});

test('a space is reported under the names stored for it', async () => {
	const state = stateOf();
	await state.daos.spaceIdentities.record({
		repo: 'repo',
		key: 'STA-1',
		worktreePath: '/elsewhere/STA-1',
		tmux: {
			socket: '/tmp/other.sock',
			agentSession: 'hand-named-agent',
			companionSession: 'hand-named-companion',
		},
	});
	await state.daos.registry.add('STA-1');
	const result = await run(['get', 'STA-1', '--json'], deps(state));
	expect(JSON.parse(result.stdout)).toMatchObject({
		worktreePath: '/elsewhere/STA-1',
		branch: 'STA-1',
		tmux: {
			socket: '/tmp/other.sock',
			socketFlag: '-S',
			agentSession: 'hand-named-agent',
			companionSession: 'hand-named-companion',
			agentTarget: '=hand-named-agent:',
			companionTarget: '=hand-named-companion:',
		},
	});
});

test('with no key, a worktree outside ~/.worktrees is found by its stored path', async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'space-custom-')),
	);
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const worktree = path.join(root, 'checkouts', 'login');
	fs.mkdirSync(path.join(worktree, 'src'), {recursive: true});
	const state = stateOf();
	await state.daos.spaceIdentities.record(
		newSpaceIdentity({
			repo: 'repo',
			key: 'STA-1',
			worktreePath: worktree,
			socket: 'pappardelle_inner',
		}),
	);
	await state.daos.registry.add('STA-1');
	expect(
		await run(
			['get', '--field', 'key'],
			deps(state, {cwd: path.join(worktree, 'src')}),
		),
	).toMatchObject({code: 0, stdout: 'STA-1'});
});

test('a space closed before identities were stored has no names', async () => {
	const state = stateOf();
	await state.daos.spaceState.write('STA-7', {profile: 'dev'});
	const result = await run(['get', 'STA-7', '--json'], deps(state));
	expect(JSON.parse(result.stdout)).toMatchObject({
		phase: 'closed',
		worktreePath: null,
		tmux: null,
		panes: {agent: null, companion: null},
	});
});

test('outside a git checkout, get with a key or PAPPARDELLE_SPACE and list exit 1 with one line', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	const outside = {checkout: () => ({kind: 'not-in-a-repo'}) as const};
	const expected = {
		code: 1,
		stdout: '',
		stderr:
			"Not in a git repository; run it from a checkout of the space's repo",
	};
	expect(await run(['get', 'STA-1'], deps(state, outside))).toStrictEqual(
		expected,
	);
	expect(
		await run(
			['get'],
			deps(state, {...outside, env: {PAPPARDELLE_SPACE: 'STA-1'}}),
		),
	).toStrictEqual(expected);
	expect(await run(['list'], deps(state, outside))).toStrictEqual(expected);
});

test('--field prints strings bare, objects as JSON and null as an empty line', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	await state.daos.spaceState.write('STA-1', {profile: 'dev'});
	recordSessions(state, 'STA-1', {claude: 'c-1'});
	const field = async (...fields: string[]) =>
		run(
			['get', 'STA-1', ...fields.flatMap(each => ['--field', each])],
			deps(state),
		);
	expect(await field('agentSessions.claude')).toMatchObject({
		code: 0,
		stdout: 'c-1',
	});
	expect(await field('agentSessions')).toMatchObject({
		stdout: '{"claude":"c-1"}',
	});
	expect(await field('title')).toStrictEqual({code: 0, stdout: '', stderr: ''});
	expect(await field('prLinks')).toMatchObject({code: 0, stdout: '[]'});
	expect(await field('profile', 'pipeline')).toMatchObject({
		stdout: '{"profile":"dev","pipeline":null}',
	});
	expect(
		await run(['get', 'STA-1', '--field=profile'], deps(state)),
	).toMatchObject({
		stdout: 'dev',
	});
});

test('--field outside the record is a usage error', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	for (const field of [
		'bogus',
		'tmux.bogus',
		'profile.name',
		'agentSessions.a.b',
	]) {
		const {code} = await run(['get', 'STA-1', '--field', field], deps(state));
		expect(code, field).toBe(2);
	}
});

test('a stored or tmux field starts no process', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	const tmux = fakeTmux([{session: 'agent-repo-STA-1', id: '%1'}]);
	let gitCalls = 0;
	const result = await run(
		['get', 'STA-1', '--field', 'tmux.agentTarget', '--field', 'profile'],
		deps(state, {
			runner: tmux.runner,
			async gitBranch() {
				gitCalls++;
				return 'x';
			},
		}),
	);
	expect(result.code).toBe(0);
	expect(tmux.verbs).toStrictEqual([]);
	expect(gitCalls).toBe(0);
});

/** A hook status and a program status snapshot for STA-1's agent. */
function statusDaos(
	state: TestState,
	hook: ClaudeStatusInfo,
	snapshotPanes: string[],
): SpaceDaos {
	return {
		...state.daos,
		claudeStatus: {
			...state.daos.claudeStatus,
			readableKey: async (repo, name) => `${repo}-${name}`,
			read: async key => (key === 'repo-STA-1' ? hook : null),
		},
		programStatus: {
			...state.daos.programStatus,
			async read(key: string, pane: StatusPane) {
				snapshotPanes.push(pane.id);
				const snapshot: ProgramStatusSnapshot = {
					version: 1,
					repo: 'repo',
					key,
					pane,
					authoritative: true,
					exited: false,
					updatedAt: 0,
					records: [],
					info: {status: 'working', app: 'claude-code'},
				};
				return snapshot;
			},
		},
	};
}

test("status merges the hook's record with the snapshot of the session's pinned pane", async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	const snapshotPanes: string[] = [];
	const tmux = fakeTmux([
		{session: 'agent-repo-STA-1', id: '%1', pinned: '%2'},
		{session: 'agent-repo-STA-1', id: '%2', pinned: '%2'},
		{session: 'agent-repo-STA-1', id: '%3', pinned: '%2', current: true},
		{session: 'companion-repo-STA-1', id: '%9', name: 'scratch'},
		{session: 'companion-repo-STA-1', id: '%7'},
	]);
	const result = await run(
		['get', 'STA-1', '--field', 'status', '--field', 'panes'],
		deps(state, {
			runner: tmux.runner,
			daos: () =>
				statusDaos(
					state,
					{status: 'running_tool', tool: 'Bash'},
					snapshotPanes,
				),
		}),
	);
	expect(JSON.parse(result.stdout)).toStrictEqual({
		status: {
			status: 'working',
			app: 'claude-code',
			tool: 'Bash',
			activity: 'tool',
			source: 'osc',
		},
		panes: {agent: '%2', companion: '%7'},
	});
	expect(snapshotPanes).toStrictEqual(['%2']);
	expect(tmux.verbs).toStrictEqual(['list-panes']);
});

test('without a session there are no panes and only the hook status', async () => {
	const state = stateOf();
	await openSpace(state, 'STA-1');
	const snapshotPanes: string[] = [];
	const result = await run(
		['get', 'STA-1', '--field', 'status', '--field', 'panes'],
		deps(state, {
			daos: () =>
				statusDaos(state, {status: 'waiting_for_input'}, snapshotPanes),
		}),
	);
	expect(JSON.parse(result.stdout)).toStrictEqual({
		status: {status: 'idle', app: 'claude-code', source: 'hook'},
		panes: {agent: null, companion: null},
	});
	expect(snapshotPanes).toStrictEqual([]);
});

test("main's status is read under its key, without asking git for its branch", async () => {
	const state = stateOf({repo: 'repo'});
	await openSpace(state, 'main');
	await writeClaudeStatus(state, {
		sessionId: 's',
		workspaceName: 'repo-main',
		status: 'processing',
		lastUpdate: Date.now(),
	});
	const branchesRead: string[] = [];
	const result = await run(
		['get', 'main', '--field', 'status.status'],
		deps(state, {
			async gitBranch(directory) {
				branchesRead.push(directory);
				return 'master';
			},
		}),
	);
	expect(result).toStrictEqual({code: 0, stdout: 'working', stderr: ''});
	expect(branchesRead).toStrictEqual([]);
});

function cli() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-cli-space-get-')),
	);
	teardown(() => fs.rmSync(root, {recursive: true, force: true}));
	const projectRoot = path.resolve(import.meta.dirname, '..');
	const repo = path.join(root, 'project');
	const home = path.join(root, 'home');
	const install = path.join(root, 'install');
	fs.mkdirSync(repo);
	fs.mkdirSync(home);
	fs.mkdirSync(path.join(install, 'scripts'), {recursive: true});
	fs.copyFileSync(
		path.join(projectRoot, 'scripts', 'builtin-agents.json'),
		path.join(install, 'scripts', 'builtin-agents.json'),
	);
	fs.cpSync(path.join(projectRoot, 'source'), path.join(install, 'source'), {
		recursive: true,
		filter: file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
	});
	fs.symlinkSync(
		path.join(projectRoot, 'node_modules'),
		path.join(install, 'node_modules'),
	);
	fs.writeFileSync(path.join(install, 'package.json'), '{"type":"module"}');
	execFileSync('git', ['init', '--quiet', repo]);
	fs.writeFileSync(
		path.join(repo, '.pappardelle.yml'),
		`version: 1
team_prefix: STE
issue_tracker:
  provider: jira
  base_url: https://example.invalid
profiles:
  test:
    display_name: Test
    tracker_projects: [ste]
`,
	);
	const record = path.join(root, 'idow-ran');
	fs.writeFileSync(
		path.join(install, 'scripts', 'idow'),
		`#!/bin/sh\ntouch '${record}'\n`,
		{mode: 0o755},
	);
	return {
		idowRan: () => fs.existsSync(record),
		async run(args: string[]) {
			const child = spawn(
				process.execPath,
				[path.join(install, 'source', 'cli.tsx'), ...args],
				{
					cwd: repo,
					env: {
						...process.env,
						HOME: home,
						PAPPARDELLE_PROJECT_ROOT: repo,
						PAPPARDELLE_MAIN_REPO_ROOT: repo,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			teardown(() => child.kill());
			let stderr = '';
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			const [code] = (await once(child, 'close')) as [number];
			return {code, stderr};
		},
	};
}

test('pappardelle space with a bad verb, flag or field exits 2 without opening a space', async () => {
	const f = cli();
	for (const args of [
		['space', 'bogus'],
		['space', 'get', '--bogus'],
		['space', 'get', '--field='],
	]) {
		const result = await f.run(args);
		expect(result.code, args.join(' ')).toBe(2);
		expect(result.stderr).toMatch(/Usage: pappardelle space get/);
	}

	expect(f.idowRan()).toBe(false);
});
