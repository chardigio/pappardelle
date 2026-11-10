import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {ensureCompanionSession, getSessionNames} from './tmux.ts';

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

		const session = getSessionNames('BAR-1').companion;
		const status = spawnSync(
			'tmux',
			['-S', socket, 'show-options', '-t', `=${session}:`, '-v', 'status'],
			{encoding: 'utf8'},
		);
		t.is(status.stdout.trim(), 'off');
	},
);
