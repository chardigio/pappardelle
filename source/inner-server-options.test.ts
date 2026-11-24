import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {sessionNamesFor} from './space-identity.ts';
import test, {type ExecutionContext} from 'ava';
import {ensureCompanionSession} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
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

/**
 * A private inner server for one test: HOME (whose .tmux.conf the server
 * loads) and PAPPARDELLE_TMUX_SOCKET point into a temp dir.
 */
function privateInnerServer(t: ExecutionContext, tmuxConf = '') {
	const root = tempDir(t, 'inner-options-');
	const socket = path.join(root, 's');
	writeFileSync(path.join(root, '.tmux.conf'), tmuxConf);
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
	});
	const tmux = (...args: string[]) =>
		spawnSync('tmux', ['-S', socket, ...args], {encoding: 'utf8'});
	return {root, tmux};
}

runtimeTest(
	'space sessions survive a tmux.conf that destroys unattached sessions and exits the unattached server',
	async t => {
		const {root, tmux} = privateInnerServer(
			t,
			'set -g destroy-unattached on\nset -g exit-unattached on\n',
		);

		t.true(await ensureCompanionSession('KEEP-1', root, ''));
		t.true(await ensureCompanionSession('KEEP-2', root, ''));

		const sessions = tmux('list-sessions', '-F', '#{session_name}');
		t.deepEqual(sessions.stdout.trim().split('\n').sort(), [
			sessionNamesFor('KEEP-1', getRepoName()).companion,
			sessionNamesFor('KEEP-2', getRepoName()).companion,
		]);
	},
);

runtimeTest(
	'a space whose worktree path reads as a tmux format starts in that worktree',
	async t => {
		const {root, tmux} = privateInnerServer(t);
		const worktree = path.join(root, 'pasta#S');
		mkdirSync(worktree);

		t.true(await ensureCompanionSession('HASH-1', worktree, ''));

		const shown = tmux(
			'display-message',
			'-p',
			'-t',
			`=${sessionNamesFor('HASH-1', getRepoName()).companion}:`,
			'#{session_path}',
		);
		t.is(shown.stdout.trim(), worktree);
	},
);

// A space started while the server exits over the last one closing would fail
// with "server exited unexpectedly".
runtimeTest(
	'the inner server outlives its last session, and the next space starts on it',
	async t => {
		const {root, tmux} = privateInnerServer(t);
		t.true(await ensureCompanionSession('EMPTY-1', root, ''));
		const pid = tmux('display-message', '-p', '#{pid}').stdout.trim();

		const killed = tmux(
			'kill-session',
			'-t',
			`=${sessionNamesFor('EMPTY-1', getRepoName()).companion}:`,
		);
		t.is(killed.status, 0, killed.stderr);

		const listed = tmux('list-sessions');
		t.is(listed.status, 0, listed.stderr);
		t.is(listed.stdout, '');
		t.true(await ensureCompanionSession('EMPTY-2', root, ''));
		t.is(tmux('display-message', '-p', '#{pid}').stdout.trim(), pid);
	},
);
