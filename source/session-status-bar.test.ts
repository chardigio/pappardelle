import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {sessionNamesFor} from './space-identity.ts';
import test from 'ava';
import {ensureCompanionSession} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {getRepoName} from './config.ts';

// tmux.ts names a space's sessions from the stores. Without the database they
// are the names idow gives a space, which is all this file needs.
const stateTeardowns: Array<() => void> = [];
test.before(() => {
	testTmuxState(
		{teardown: fn => stateTeardowns.push(fn)},
		{repo: getRepoName(), sqlite: false},
	);
});
test.after.always(() => {
	for (const teardown of stateTeardowns) teardown();
});

const runtimeTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.skip;

// The user's own tmux.conf usually turns the status bar on, which would draw a
// row naming the session inside the viewer pane.
runtimeTest(
	'a space session hides the status bar the user config turns on',
	async t => {
		const root = realpathSync(mkdtempSync('/tmp/status-bar-'));
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
		t.teardown(() => {
			if (previous === undefined) delete process.env['PAPPARDELLE_TMUX_SOCKET'];
			else process.env['PAPPARDELLE_TMUX_SOCKET'] = previous;
			spawnSync('tmux', ['-S', socket, 'kill-server']);
			rmSync(root, {recursive: true, force: true});
		});

		t.true(await ensureCompanionSession('BAR-1', root, ''));

		const session = sessionNamesFor('BAR-1', getRepoName()).companion;
		const status = spawnSync(
			'tmux',
			['-S', socket, 'show-options', '-t', `=${session}:`, '-v', 'status'],
			{encoding: 'utf8'},
		);
		t.is(status.stdout.trim(), 'off');
	},
);
