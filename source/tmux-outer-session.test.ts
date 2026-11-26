import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect} from 'bun:test';
import {tmuxOn, tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {until} from '../test/helpers/wait.ts';
import {sessionNamesFor} from './space-identity.ts';
import {
	exactSessionTarget,
	killSession,
	newOuterSessionArgs,
	outerSessionName,
	sessionExists,
} from './tmux.ts';
import {tmuxFormatLiteral} from './tmux-format.ts';
import {reviveTui} from './tui-sessions.ts';

function privateDefaultServer(): void {
	const dir = tempDir('pappardelle-tmux-');
	const saved = process.env['TMUX_TMPDIR'];
	process.env['TMUX_TMPDIR'] = dir;
	teardown(() => {
		spawnSync('tmux', ['kill-server'], {stdio: 'ignore'});
		if (saved === undefined) delete process.env['TMUX_TMPDIR'];
		else process.env['TMUX_TMPDIR'] = saved;
	});
}

// The TUI's pappardelle-<repo> session shares the default socket with the
// default-terminal launcher's pappardelle-view-<repo>-<key> viewers, so for a
// repo named `view` a viewer name extends the TUI's.
tmuxTest('outer session lookups ignore a longer session name', () => {
	privateDefaultServer();
	const viewer = 'pappardelle-view-view-KEY-1';
	execFileSync('tmux', ['new-session', '-d', '-s', viewer]);

	expect(sessionExists('pappardelle-view')).toBe(false);
	killSession('pappardelle-view');
	expect(sessionExists(viewer)).toBe(true);
});

tmuxTest(
	'outer session lookups and kills take a name the shell would expand',
	() => {
		privateDefaultServer();
		const name = 'pappardelle-it\'s "$HOME" `id`';
		execFileSync('tmux', ['new-session', '-d', '-s', name]);

		expect(sessionExists(name)).toBe(true);
		expect(killSession(name)).toBe(true);
		expect(sessionExists(name)).toBe(false);
	},
);

tmuxTest(
	'a repo whose name reads as a tmux format still gets its own outer session, titled 🍝 <repo> even when the user turned titles off',
	() => {
		const dir = tempDir('pappardelle-tmux-');
		const conf = join(dir, 'tmux.conf');
		writeFileSync(
			conf,
			'set -g set-titles off\nset -g set-titles-string "#h:#W"\n',
		);
		const tmux = tmuxOn(join(dir, 's'), conf);
		teardown(() => tmux('kill-server'));

		const repo = 'pasta#S';
		// Detached, since the test has no terminal for the client.
		const [command, ...rest] = newOuterSessionArgs(repo, [], 'sleep 30');
		const created = tmux(command!, '-d', ...rest);
		expect(created.status, created.stderr).toBe(0);

		const shown = tmux(
			'display-message',
			'-p',
			'-t',
			exactSessionTarget(outerSessionName(repo)),
			'#{session_name}|#{set-titles}|#{T:set-titles-string}',
		);
		expect(shown.stdout.trim()).toBe('pappardelle-pasta_S|1|🍝 pasta#S');
	},
);

tmuxTest(
	'a space of a repo whose name reads as a tmux format is found under the names it was given',
	() => {
		const dir = tempDir('pappardelle-tmux-');
		const tmux = tmuxOn(join(dir, 's'));
		teardown(() => tmux('kill-server'));

		const names = sessionNamesFor('STA-1', 'pasta#S');
		for (const session of [names.agent, names.companion]) {
			const created = tmux('new-session', '-d', '-s', session, 'sleep 30');
			expect(created.status, created.stderr).toBe(0);
			expect(
				tmux('has-session', '-t', exactSessionTarget(session)).status,
				session,
			).toBe(0);
		}
	},
);

// A TUI that died stays in its session when the pane is kept (remain-on-exit),
// and the next launch reruns it there instead of creating the session again.
tmuxTest(
	'a dead TUI is rerun in its own session, which never goes away',
	async () => {
		privateDefaultServer();
		const session = 'pappardelle-revive';
		const repo = join(tempDir('pappardelle-revive-'), 'pasta#S');
		mkdirSync(repo);
		execFileSync('tmux', [
			'new-session',
			'-d',
			'-s',
			session,
			'-c',
			tmuxFormatLiteral(repo),
			'true',
			';',
			'set-option',
			'-t',
			exactSessionTarget(session),
			'remain-on-exit',
			'on',
		]);
		const pane = () =>
			execFileSync(
				'tmux',
				[
					'display-message',
					'-p',
					'-t',
					exactSessionTarget(session),
					'#{pane_dead}|#{pane_start_command}',
				],
				{encoding: 'utf8'},
			).trim();
		await until(() => pane().startsWith('1|'), {
			what: 'the first TUI to exit',
			frame: pane,
			intervalMs: 50,
		});
		// The TUI's own pane can be gone, leaving a viewer started elsewhere.
		// The session's own directory is not where the TUI is launched from.
		const viewer = execFileSync(
			'tmux',
			[
				'split-window',
				'-d',
				'-P',
				'-F',
				'#{pane_id}',
				'-t',
				exactSessionTarget(session),
				'-c',
				'/',
				'sleep 30',
			],
			{encoding: 'utf8'},
		).trim();

		const revived = reviveTui({
			session,
			command: 'sleep 30',
			cwd: repo,
			envArgs: ['-e', 'PAPPARDELLE_REVIVE_TEST=1'],
			markerPaneId: viewer,
		});

		expect(revived.ok).toBe(true);
		expect(sessionExists(session)).toBe(true);
		expect(pane()).toMatch(/^0\|"?sleep 30"?$/);
		expect(
			execFileSync(
				'tmux',
				['display-message', '-p', '-t', viewer, '#{pane_start_path}'],
				{encoding: 'utf8'},
			).trim(),
		).toBe(repo);
	},
);
