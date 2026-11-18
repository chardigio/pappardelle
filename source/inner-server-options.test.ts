import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
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

runtimeTest(
	'space sessions survive a tmux.conf that destroys unattached sessions and exits the unattached server',
	async t => {
		const root = realpathSync(mkdtempSync('/tmp/inner-options-'));
		const socket = path.join(root, 's');
		writeFileSync(
			path.join(root, '.tmux.conf'),
			'set -g destroy-unattached on\nset -g exit-unattached on\n',
		);
		const saved = {
			HOME: process.env['HOME'],
			XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
			PAPPARDELLE_TMUX_SOCKET: process.env['PAPPARDELLE_TMUX_SOCKET'],
		};
		process.env['HOME'] = root;
		delete process.env['XDG_CONFIG_HOME'];
		process.env['PAPPARDELLE_TMUX_SOCKET'] = socket;
		t.teardown(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = value;
			}

			spawnSync('tmux', ['-S', socket, 'kill-server']);
			rmSync(root, {recursive: true, force: true});
		});

		t.true(await ensureCompanionSession('KEEP-1', root, ''));
		t.true(await ensureCompanionSession('KEEP-2', root, ''));

		const sessions = spawnSync(
			'tmux',
			['-S', socket, 'list-sessions', '-F', '#{session_name}'],
			{encoding: 'utf8'},
		);
		t.deepEqual(sessions.stdout.trim().split('\n').sort(), [
			sessionNamesFor('KEEP-1', getRepoName()).companion,
			sessionNamesFor('KEEP-2', getRepoName()).companion,
		]);
	},
);
