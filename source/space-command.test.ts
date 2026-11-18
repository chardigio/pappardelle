import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {
	testState,
	writeClaudeStatus,
	type TestState,
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
		home: HOME,
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

function recordSessions(
	state: TestState,
	key: string,
	sessions: Record<string, string>,
): void {
	const file = state.daos.agentSessions.file(key);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(
		file,
		JSON.stringify(
			Object.fromEntries(
				Object.entries(sessions).map(([profile, id]) => [
					profile,
					{session_id: id, pid: 1, started: null},
				]),
			),
		),
	);
}

/** One space history, written through the stores in a fixed order. */
async function history(state: TestState): Promise<void> {
	const {registry, spaceState} = state.daos;
	await registry.reserveStart('STA-2', process.pid);
	await registry.add('STA-2');
	await registry.add('STA-10');
	await registry.add('STA-1');
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

test('both stores answer get and list the same for one history', async t => {
	const outputs = [];
	for (const sqlite of [false, true]) {
		const state = testState(t, {sqlite, clock: CLOCK});
		await history(state);
		const tmux = fakeTmux([
			{session: 'agent-repo-STA-2', id: '%3', current: true},
		]).runner;
		const get = await run(
			['get', 'STA-2', '--json'],
			deps(state, {runner: tmux}),
		);
		const list = await run(['list', '--json'], deps(state, {runner: tmux}));
		outputs.push({get, list});
	}

	const [json, sqlite] = outputs;
	t.deepEqual(sqlite, json);
	const record = JSON.parse(json!.get.stdout) as Record<string, unknown>;
	t.like(record, {
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
	t.deepEqual(
		(JSON.parse(json!.list.stdout) as Array<{key: string}>).map(
			record => record.key,
		),
		['main', 'STA-10', 'STA-2', 'STA-1'],
	);
});

test('session names and targets encode dots and underscores, and name main', async t => {
	const state = testState(t);
	for (const key of ['a.b_c', 'bd-a3f8e9.1'])
		await state.daos.registry.add(key);
	const tmuxOf = async (key: string) => {
		const {stdout} = await run(['get', key, '--field', 'tmux'], deps(state));
		return JSON.parse(stdout) as unknown;
	};
	t.deepEqual(await tmuxOf('a.b_c'), {
		socket: 'pappardelle_inner',
		socketFlag: '-L',
		agentSession: 'agent-repo-a_b__c',
		companionSession: 'companion-repo-a_b__c',
		agentTarget: '=agent-repo-a_b__c:',
		companionTarget: '=companion-repo-a_b__c:',
	});
	t.like(await tmuxOf('bd-a3f8e9.1'), {
		agentTarget: '=agent-repo-bd-a3f8e9_1:',
	});
	t.like(await tmuxOf('main'), {agentTarget: '=agent-repo-main:'});
});

test('a socket path is passed with -S', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
	const result = await run(
		['get', 'STA-1', '--field', 'tmux.socketFlag', '--field', 'tmux.socket'],
		deps(state, {env: {PAPPARDELLE_TMUX_SOCKET: '/tmp/inner.sock'}}),
	);
	t.deepEqual(JSON.parse(result.stdout), {
		'tmux.socketFlag': '-S',
		'tmux.socket': '/tmp/inner.sock',
	});
});

contractTest(
	'an unregistered key with a live agent session is starting',
	async (t, state) => {
		const tmux = fakeTmux([{session: 'agent-repo-STA-5', id: '%1'}]).runner;
		const result = await run(
			['get', 'STA-5', '--field', 'phase'],
			deps(state, {runner: tmux}),
		);
		t.deepEqual(result, {code: 0, stdout: 'starting', stderr: ''});
	},
);

test('a key that is not open but has stored state is closed, and one with neither is unknown', async t => {
	const state = testState(t);
	await state.daos.spaceState.write('STA-7', {profile: 'dev'});
	t.like(await run(['get', 'STA-7', '--field', 'phase'], deps(state)), {
		code: 0,
		stdout: 'closed',
	});
	t.deepEqual(await run(['get', 'STA-8'], deps(state)), {
		code: 1,
		stdout: '',
		stderr: 'No space STA-8',
	});
});

test('a typed key the stores lack is looked up again as Pappardelle resolves it', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-8');
	const result = await run(
		['get', '8', '--field', 'key'],
		deps(state, {resolveKey: raw => `STA-${raw}`}),
	);
	t.deepEqual(result, {code: 0, stdout: 'STA-8', stderr: ''});
});

test('a registry or state store that cannot be read exits 3, never 1', async t => {
	const unreadableRegistry = testState(t, {sqlite: false});
	fs.writeFileSync(unreadableRegistry.registryFile, 'not json{');
	const get = await run(
		['get', 'STA-1', '--field', 'profile'],
		deps(unreadableRegistry),
	);
	t.is(get.code, 3);
	const list = await run(['list'], deps(unreadableRegistry));
	t.is(list.code, 3);

	const unreadableState = testState(t, {sqlite: false});
	await unreadableState.daos.registry.add('STA-1');
	fs.mkdirSync(unreadableState.daos.spaceState.file('STA-1'), {
		recursive: true,
	});
	const result = await run(
		['get', 'STA-1', '--field', 'profile'],
		deps(unreadableState),
	);
	t.is(result.code, 3);
	t.regex(result.stderr, /Could not read the state of STA-1/);
});

contractTest(
	'an agent-sessions store that cannot be read fails only the lookups that read it',
	async (t, state) => {
		await state.daos.registry.add('STA-1');
		await state.daos.spaceState.write('STA-1', {profile: 'dev'});
		fs.mkdirSync(state.daos.agentSessions.file('STA-1'), {recursive: true});
		t.deepEqual(
			await run(['get', 'STA-1', '--field', 'profile'], deps(state)),
			{code: 0, stdout: 'dev', stderr: ''},
		);
		const sessions = await run(
			['get', 'STA-1', '--field', 'agentSessions.claude'],
			deps(state),
		);
		t.is(sessions.code, 3);
		t.regex(sessions.stderr, /Could not read the state of STA-1/);
	},
);

test('a space named by PAPPARDELLE_SPACE belongs to PAPPARDELLE_REPO, not the nested checkout', async t => {
	const outer = testState(t, {repo: 'repo'});
	const nested = testState(t, {repo: 'nested'});
	await outer.daos.registry.add('STA-1');
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
	t.deepEqual(JSON.parse(result.stdout), {
		repo: 'repo',
		profile: 'dev',
		worktreePath: '/home/u/.worktrees/repo/STA-1',
	});
});

test('with no key and no PAPPARDELLE_SPACE, the space is the worktree the caller is in', async t => {
	const state = testState(t);
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'space-home-')),
	);
	t.teardown(() => fs.rmSync(home, {recursive: true, force: true}));
	const inside = path.join(home, '.worktrees', 'repo', 'STA-1', 'src');
	fs.mkdirSync(inside, {recursive: true});
	await state.daos.registry.add('STA-1');
	t.like(
		await run(['get', '--field', 'key'], deps(state, {home, cwd: inside})),
		{code: 0, stdout: 'STA-1'},
	);
	t.deepEqual(await run(['get'], deps(state, {home, cwd: home})), {
		code: 1,
		stdout: '',
		stderr: 'Not in a Pappardelle space; pass a KEY',
	});
});

test('outside a git checkout, get with a key or PAPPARDELLE_SPACE and list exit 1 with one line', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
	const outside = {checkout: () => ({kind: 'not-in-a-repo'}) as const};
	const expected = {
		code: 1,
		stdout: '',
		stderr:
			"Not in a git repository; run it from a checkout of the space's repo",
	};
	t.deepEqual(await run(['get', 'STA-1'], deps(state, outside)), expected);
	t.deepEqual(
		await run(
			['get'],
			deps(state, {...outside, env: {PAPPARDELLE_SPACE: 'STA-1'}}),
		),
		expected,
	);
	t.deepEqual(await run(['list'], deps(state, outside)), expected);
});

test('--field prints strings bare, objects as JSON and null as an empty line', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
	await state.daos.spaceState.write('STA-1', {profile: 'dev'});
	recordSessions(state, 'STA-1', {claude: 'c-1'});
	const field = async (...fields: string[]) =>
		run(
			['get', 'STA-1', ...fields.flatMap(each => ['--field', each])],
			deps(state),
		);
	t.like(await field('agentSessions.claude'), {code: 0, stdout: 'c-1'});
	t.like(await field('agentSessions'), {stdout: '{"claude":"c-1"}'});
	t.deepEqual(await field('title'), {code: 0, stdout: '', stderr: ''});
	t.like(await field('prLinks'), {code: 0, stdout: '[]'});
	t.like(await field('profile', 'pipeline'), {
		stdout: '{"profile":"dev","pipeline":null}',
	});
	t.like(await run(['get', 'STA-1', '--field=profile'], deps(state)), {
		stdout: 'dev',
	});
});

test('--field outside the record is a usage error', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
	for (const field of [
		'bogus',
		'tmux.bogus',
		'profile.name',
		'agentSessions.a.b',
	]) {
		const {code} = await run(['get', 'STA-1', '--field', field], deps(state));
		t.is(code, 2, field);
	}
});

test('a stored or tmux field starts no process', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
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
	t.is(result.code, 0);
	t.deepEqual(tmux.verbs, []);
	t.is(gitCalls, 0);
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

test("status merges the hook's record with the snapshot of the session's pinned pane", async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
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
	t.deepEqual(JSON.parse(result.stdout), {
		status: {
			status: 'working',
			app: 'claude-code',
			tool: 'Bash',
			activity: 'tool',
			source: 'osc',
		},
		panes: {agent: '%2', companion: '%7'},
	});
	t.deepEqual(snapshotPanes, ['%2']);
	t.deepEqual(tmux.verbs, ['list-panes']);
});

test('without a session there are no panes and only the hook status', async t => {
	const state = testState(t);
	await state.daos.registry.add('STA-1');
	const snapshotPanes: string[] = [];
	const result = await run(
		['get', 'STA-1', '--field', 'status', '--field', 'panes'],
		deps(state, {
			daos: () =>
				statusDaos(state, {status: 'waiting_for_input'}, snapshotPanes),
		}),
	);
	t.deepEqual(JSON.parse(result.stdout), {
		status: {status: 'idle', app: 'claude-code', source: 'hook'},
		panes: {agent: null, companion: null},
	});
	t.deepEqual(snapshotPanes, []);
});

test("main's status is read under its branch", async t => {
	const state = testState(t, {repo: 'repo'});
	await writeClaudeStatus(state, {
		sessionId: 's',
		workspaceName: 'repo-master',
		status: 'processing',
		lastUpdate: Date.now(),
	});
	const result = await run(
		['get', 'main', '--field', 'status.status'],
		deps(state),
	);
	t.deepEqual(result, {code: 0, stdout: 'working', stderr: ''});
});

function cli(t: ExecutionContext) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-cli-space-get-')),
	);
	t.teardown(() => fs.rmSync(root, {recursive: true, force: true}));
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
			t.teardown(() => child.kill());
			let stderr = '';
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			const [code] = (await once(child, 'close')) as [number];
			return {code, stderr};
		},
	};
}

test.serial(
	'pappardelle space with a bad verb, flag or field exits 2 without opening a space',
	async t => {
		const f = cli(t);
		for (const args of [
			['space', 'bogus'],
			['space', 'get', '--bogus'],
			['space', 'get', '--field='],
		]) {
			const result = await f.run(args);
			t.is(result.code, 2, args.join(' '));
			t.regex(result.stderr, /Usage: pappardelle space get/);
		}

		t.false(f.idowRan());
	},
);
