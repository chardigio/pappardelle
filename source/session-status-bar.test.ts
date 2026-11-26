import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {sessionNamesFor} from './space-identity.ts';
import {expect, beforeAll, afterAll} from 'bun:test';
import {tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {ensureCompanionSession} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {getRepoName} from './config.ts';

// tmux.ts names a space's sessions from the stores.
const stateTeardowns: Array<() => unknown> = [];
beforeAll(() => {
	testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: getRepoName(),
		spaces: ['BAR-1'],
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

// The user's own tmux.conf usually turns the status bar on, which would draw a
// row naming the session inside the viewer pane.
tmuxTest(
	'a space session hides the status bar the user config turns on',
	async () => {
		const root = realpathSync(mkdtempSync(`${tmpdir()}/status-bar-`));
		const socket = path.join(root, 's');
		const config = path.join(root, 'tmux.conf');
		spawnSync('/bin/sh', ['-c', `echo 'set -g status on' > '${config}'`]);
		spawnSync('tmux', [
			'-S',
			socket,
			'-f',
			config,
			'start-server',
			';',
			'new-session',
			'-d',
			'-s',
			'keepalive',
		]);
		const previous = process.env['PAPPARDELLE_TMUX_SOCKET'];
		process.env['PAPPARDELLE_TMUX_SOCKET'] = socket;
		teardown(() => {
			if (previous === undefined) delete process.env['PAPPARDELLE_TMUX_SOCKET'];
			else process.env['PAPPARDELLE_TMUX_SOCKET'] = previous;
			spawnSync('tmux', ['-S', socket, 'kill-server']);
			rmSync(root, {recursive: true, force: true});
		});

		expect(await ensureCompanionSession('BAR-1', root, '')).toBe(true);

		const session = sessionNamesFor('BAR-1', getRepoName()).companion;
		const status = spawnSync(
			'tmux',
			['-S', socket, 'show-options', '-t', `=${session}:`, '-v', 'status'],
			{encoding: 'utf8'},
		);
		expect(status.stdout.trim()).toBe('off');
	},
);
