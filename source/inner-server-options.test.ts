import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {ensureCompanionSession, getSessionNames} from './tmux.ts';

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
			getSessionNames('KEEP-1').companion,
			getSessionNames('KEEP-2').companion,
		]);
	},
);
