// `pappardelle companion` against a real tmux server. The server runs on its
// own socket in a short temp directory, never the user's servers, and is
// killed through that socket only.
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {expect, beforeAll, afterAll} from 'bun:test';
import {hasTmux, tmuxTest} from '../test/helpers/tmux-test.ts';
import {
	closeCompanionPane,
	CompanionError,
	listCompanion,
	readCompanionPane,
	resizeCompanionPane,
	runInCompanion,
	sendCompanionKeys,
} from './companion.ts';
import type {OuterTmuxRunner} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {REAL_TMUX_TIMEOUT_MS, until} from '../test/helpers/wait.ts';

const dir = realpathSync(mkdtempSync(`${tmpdir()}/pc-`));
const socket = `${dir}/s`;
const env = {...process.env, SHELL: '/bin/sh'};

// The launch wrapper starts $SHELL -ic; keep it from sourcing the user's zshrc.
process.env['SHELL'] = '/bin/sh';

const runner: OuterTmuxRunner = args => {
	const r = spawnSync('tmux', ['-S', socket, ...args], {
		encoding: 'utf8',
		env,
		timeout: 5000,
	});
	return {error: r.error, status: r.status, stdout: r.stdout, stderr: r.stderr};
};

function tmux(...args: string[]): string {
	const r = runner(args);
	if (r.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${r.stderr}`);
	return r.stdout.trim();
}

const deps = {runner};
const COMPANION = 'companion-itest-KEY-1';
const AGENT = 'agent-itest-KEY-1';

const panesOf = (session: string) =>
	tmux('list-panes', '-s', '-t', `=${session}:`, '-F', '#{pane_id}').split(
		'\n',
	);

beforeAll(() => {
	if (!hasTmux) return;
	tmux(
		'new-session',
		'-d',
		'-s',
		COMPANION,
		'-x',
		'120',
		'-y',
		'40',
		'-c',
		dir,
		'cat',
	);
	tmux('new-session', '-d', '-s', AGENT, '-c', dir, 'sleep 600');
});

// tmux.ts names a space's sessions from the stores, as idow names them when
// it opens a space.
const stateTeardowns: Array<() => unknown> = [];
beforeAll(() => {
	testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: 'itest',
		spaces: ['KEY-1'],
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

afterAll(() => {
	spawnSync('tmux', ['-S', socket, 'kill-server'], {env});
	rmSync(dir, {recursive: true, force: true});
});

const sessions = () =>
	tmux('list-sessions', '-F', '#{session_name}').split('\n');
const SIDE = `${COMPANION}~side`;

tmuxTest('companion verbs on a real tmux server', async () => {
	const agentPanes = panesOf(AGENT);
	const agentPid = () =>
		tmux('display-message', '-p', '-t', `=${AGENT}:`, '#{pane_pid}');
	const agentPidBefore = agentPid();

	expect(
		runInCompanion(
			'KEY-1',
			{pane: 'side', split: 'down', size: '30%', command: 'sleep 600'},
			deps,
		).created,
	).toBe(true);
	expect(sessions().includes(SIDE)).toBe(true);
	expect(panesOf(COMPANION).length).toBe(1);

	// Running the same pane again replaces it instead of adding a split.
	const again = runInCompanion(
		'KEY-1',
		{pane: 'side', split: 'right', command: 'sleep 601'},
		deps,
	);
	expect(again.created).toBe(false);
	expect(sessions().filter(name => name.startsWith(COMPANION)).length).toBe(2);
	const side = listCompanion('KEY-1', deps).find(p => p.name === 'side')!;
	expect(side).toMatchObject({split: 'down', size: '30%'});
	const sideCommand = () =>
		listCompanion('KEY-1', deps).find(p => p.name === 'side')!.startCommand;
	await until(() => sideCommand().includes('sleep 601'), {
		frame: sideCommand,
		timeoutMs: REAL_TMUX_TIMEOUT_MS,
	});
	expect(
		tmux('display-message', '-p', '-t', `=${SIDE}:`, '#{pane_current_path}'),
	).toBe(dir);

	sendCompanionKeys(
		'KEY-1',
		{pane: 'main', text: 'hello-companion', keys: [], enter: true},
		deps,
	);
	const mainText = () =>
		readCompanionPane('KEY-1', {pane: 'main', lines: 20}, deps);
	await until(() => mainText().includes('hello-companion'), {
		frame: mainText,
		timeoutMs: REAL_TMUX_TIMEOUT_MS,
	});

	resizeCompanionPane('KEY-1', {pane: 'side', size: 5}, deps);
	expect(listCompanion('KEY-1', deps).find(p => p.name === 'side')?.size).toBe(
		5,
	);

	expect(() => closeCompanionPane('KEY-1', 'main', deps)).toThrow(
		CompanionError,
	);
	closeCompanionPane('KEY-1', 'side', deps);
	expect(sessions().includes(SIDE)).toBe(false);
	expect(panesOf(COMPANION).length).toBe(1);

	expect(panesOf(AGENT)).toStrictEqual(agentPanes);
	expect(agentPid(), "the agent's process was left running").toBe(
		agentPidBefore,
	);
});
