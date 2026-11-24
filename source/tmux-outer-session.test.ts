import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {tempDir} from '../test/helpers/temp-dir.ts';
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

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

/** Point the default tmux server at a private TMUX_TMPDIR for one test. */
function privateDefaultServer(t: ExecutionContext): void {
	const dir = tempDir(t, 'pappardelle-tmux-');
	const saved = process.env['TMUX_TMPDIR'];
	process.env['TMUX_TMPDIR'] = dir;
	t.teardown(() => {
		spawnSync('tmux', ['kill-server'], {stdio: 'ignore'});
		if (saved === undefined) delete process.env['TMUX_TMPDIR'];
		else process.env['TMUX_TMPDIR'] = saved;
	});
}

function tmuxOn(socket: string, conf = '/dev/null') {
	return (...args: string[]) =>
		spawnSync('tmux', ['-S', socket, '-f', conf, ...args], {encoding: 'utf8'});
}

// The TUI's pappardelle-<repo> session shares the default socket with the
// default-terminal launcher's pappardelle-view-<repo>-<key> viewers, so for a
// repo named `view` a viewer name extends the TUI's.
tmuxTest('outer session lookups ignore a longer session name', t => {
	privateDefaultServer(t);
	const viewer = 'pappardelle-view-view-KEY-1';
	execFileSync('tmux', ['new-session', '-d', '-s', viewer]);

	t.false(sessionExists('pappardelle-view'));
	killSession('pappardelle-view');
	t.true(sessionExists(viewer));
});

tmuxTest(
	'outer session lookups and kills take a name the shell would expand',
	t => {
		privateDefaultServer(t);
		const name = 'pappardelle-it\'s "$HOME" `id`';
		execFileSync('tmux', ['new-session', '-d', '-s', name]);

		t.true(sessionExists(name));
		t.true(killSession(name));
		t.false(sessionExists(name));
	},
);

tmuxTest(
	'a repo whose name reads as a tmux format still gets its own outer session, titled 🍝 <repo> even when the user turned titles off',
	t => {
		const dir = tempDir(t, 'pappardelle-tmux-');
		const conf = join(dir, 'tmux.conf');
		writeFileSync(
			conf,
			'set -g set-titles off\nset -g set-titles-string "#h:#W"\n',
		);
		const tmux = tmuxOn(join(dir, 's'), conf);
		t.teardown(() => tmux('kill-server'));

		const repo = 'pasta#S';
		// Detached, since the test has no terminal for the client.
		const [command, ...rest] = newOuterSessionArgs(repo, [], 'sleep 30');
		const created = tmux(command!, '-d', ...rest);
		t.is(created.status, 0, created.stderr);

		const shown = tmux(
			'display-message',
			'-p',
			'-t',
			exactSessionTarget(outerSessionName(repo)),
			'#{session_name}|#{set-titles}|#{T:set-titles-string}',
		);
		t.is(shown.stdout.trim(), 'pappardelle-pasta_S|1|🍝 pasta#S');
	},
);

tmuxTest(
	'a space of a repo whose name reads as a tmux format is found under the names it was given',
	t => {
		const dir = tempDir(t, 'pappardelle-tmux-');
		const tmux = tmuxOn(join(dir, 's'));
		t.teardown(() => tmux('kill-server'));

		const names = sessionNamesFor('STA-1', 'pasta#S');
		for (const session of [names.agent, names.companion]) {
			const created = tmux('new-session', '-d', '-s', session, 'sleep 30');
			t.is(created.status, 0, created.stderr);
			t.is(
				tmux('has-session', '-t', exactSessionTarget(session)).status,
				0,
				session,
			);
		}
	},
);

// A TUI that died stays in its session when the pane is kept (remain-on-exit),
// and the next launch reruns it there instead of creating the session again.
tmuxTest('a dead TUI is rerun in its own session, which never goes away', t => {
	privateDefaultServer(t);
	const session = 'pappardelle-revive';
	const repo = join(tempDir(t, 'pappardelle-revive-'), 'pasta#S');
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
	for (let i = 0; i < 50 && !pane().startsWith('1|'); i++)
		execFileSync('sleep', ['0.05']);
	t.regex(pane(), /^1\|/);
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

	t.true(revived.ok);
	t.true(sessionExists(session));
	t.regex(pane(), /^0\|"?sleep 30"?$/);
	t.is(
		execFileSync(
			'tmux',
			['display-message', '-p', '-t', viewer, '#{pane_start_path}'],
			{encoding: 'utf8'},
		).trim(),
		repo,
	);
});
