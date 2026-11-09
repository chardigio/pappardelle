// `pappardelle companion` against a real tmux server. The server runs on its
// own socket in a short temp directory, never the user's servers, and is
// killed through that socket only.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
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

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

const dir = realpathSync(mkdtempSync('/tmp/pc-'));
const socket = `${dir}/s`;
const {TMUX: _tmux, TMUX_PANE: _pane, ...inherited} = process.env;
const env = {...inherited, SHELL: '/bin/sh'};

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

const deps = {runner, repoName: 'itest'};
const COMPANION = 'companion-itest-KEY-1';
const AGENT = 'agent-itest-KEY-1';

const panesOf = (session: string) =>
	tmux('list-panes', '-s', '-t', `=${session}:`, '-F', '#{pane_id}').split(
		'\n',
	);

async function waitFor(check: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (check()) return true;
		await delay(50);
	}

	return false;
}

test.before(() => {
	if (spawnSync('tmux', ['-V']).status !== 0) return;
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

test.after.always(() => {
	spawnSync('tmux', ['-S', socket, 'kill-server'], {env});
	rmSync(dir, {recursive: true, force: true});
});

tmuxTest('companion verbs on a real tmux server', async t => {
	const agentPanes = panesOf(AGENT);

	t.true(
		runInCompanion(
			'KEY-1',
			{pane: 'side', split: 'down', command: 'sleep 600'},
			deps,
		).created,
	);
	t.is(panesOf(COMPANION).length, 2);

	// Running the same pane again replaces it instead of adding a split.
	const again = runInCompanion(
		'KEY-1',
		{pane: 'side', split: 'down', command: 'sleep 601'},
		deps,
	);
	t.false(again.created);
	t.is(panesOf(COMPANION).length, 2);
	const side = listCompanion('KEY-1', deps).find(p => p.name === 'side')!;
	t.regex(side.startCommand, /sleep 601/);
	t.is(
		tmux('display-message', '-p', '-t', side.paneId, '#{pane_current_path}'),
		dir,
	);

	sendCompanionKeys(
		'KEY-1',
		{pane: 'main', text: 'hello-companion', keys: [], enter: true},
		deps,
	);
	t.true(
		await waitFor(() =>
			readCompanionPane('KEY-1', {pane: 'main', lines: 20}, deps).includes(
				'hello-companion',
			),
		),
	);

	resizeCompanionPane('KEY-1', {pane: 'side', height: '5'}, deps);
	t.is(listCompanion('KEY-1', deps).find(p => p.name === 'side')?.height, 5);

	t.throws(() => closeCompanionPane('KEY-1', 'main', deps), {
		instanceOf: CompanionError,
	});
	closeCompanionPane('KEY-1', 'side', deps);
	t.is(panesOf(COMPANION).length, 1);

	t.deepEqual(panesOf(AGENT), agentPanes);
	t.is(
		tmux(
			'display-message',
			'-p',
			'-t',
			`=${AGENT}:`,
			'#{pane_current_command}',
		),
		'sleep',
	);
});
