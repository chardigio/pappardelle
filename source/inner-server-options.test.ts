import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {sessionNamesFor} from './space-identity.ts';
import {expect, beforeAll, afterAll} from 'bun:test';
import {tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {ensureCompanionSession} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {getRepoName} from './config.ts';

// tmux.ts names a space's sessions from the stores.
const stateTeardowns: Array<() => unknown> = [];
beforeAll(() => {
	testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: getRepoName(),
		spaces: ['KEEP-1', 'KEEP-2', 'HASH-1', 'EMPTY-1', 'EMPTY-2'],
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

/**
 * A private inner server for one test: HOME (whose .tmux.conf the server
 * loads) and PAPPARDELLE_TMUX_SOCKET point into a temp dir.
 */
function privateInnerServer(tmuxConf = '') {
	const root = tempDir('inner-options-');
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
	teardown(() => {
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

tmuxTest(
	'space sessions survive a tmux.conf that destroys unattached sessions and exits the unattached server',
	async () => {
		const {root, tmux} = privateInnerServer(
			'set -g destroy-unattached on\nset -g exit-unattached on\n',
		);

		expect(await ensureCompanionSession('KEEP-1', root, '')).toBe(true);
		expect(await ensureCompanionSession('KEEP-2', root, '')).toBe(true);

		const sessions = tmux('list-sessions', '-F', '#{session_name}');
		expect(sessions.stdout.trim().split('\n').sort()).toStrictEqual([
			sessionNamesFor('KEEP-1', getRepoName()).companion,
			sessionNamesFor('KEEP-2', getRepoName()).companion,
		]);
	},
);

tmuxTest(
	'a space whose worktree path reads as a tmux format starts in that worktree',
	async () => {
		const {root, tmux} = privateInnerServer();
		const worktree = path.join(root, 'pasta#S');
		mkdirSync(worktree);

		expect(await ensureCompanionSession('HASH-1', worktree, '')).toBe(true);

		const shown = tmux(
			'display-message',
			'-p',
			'-t',
			`=${sessionNamesFor('HASH-1', getRepoName()).companion}:`,
			'#{session_path}',
		);
		expect(shown.stdout.trim()).toBe(worktree);
	},
);

// A space started while the server exits over the last one closing would fail
// with "server exited unexpectedly".
tmuxTest(
	'the inner server outlives its last session, and the next space starts on it',
	async () => {
		const {root, tmux} = privateInnerServer();
		expect(await ensureCompanionSession('EMPTY-1', root, '')).toBe(true);
		const pid = tmux('display-message', '-p', '#{pid}').stdout.trim();

		const killed = tmux(
			'kill-session',
			'-t',
			`=${sessionNamesFor('EMPTY-1', getRepoName()).companion}:`,
		);
		expect(killed.status, killed.stderr).toBe(0);

		const listed = tmux('list-sessions');
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout).toBe('');
		expect(await ensureCompanionSession('EMPTY-2', root, '')).toBe(true);
		expect(tmux('display-message', '-p', '#{pid}').stdout.trim()).toBe(pid);
	},
);
