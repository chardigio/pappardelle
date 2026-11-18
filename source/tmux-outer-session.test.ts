import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	exactSessionTarget,
	killSession,
	newOuterSessionArgs,
	outerSessionName,
	sessionExists,
} from './tmux.ts';

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

// The TUI's pappardelle-<repo> session shares the default socket with the
// default-terminal launcher's pappardelle-view-<repo>-<key> viewers, so for a
// repo named `view` a viewer name extends the TUI's.
tmuxTest('outer session lookups ignore a longer session name', t => {
	const dir = mkdtempSync(join(tmpdir(), 'pappardelle-tmux-'));
	const saved = {tmux: process.env['TMUX'], tmpdir: process.env['TMUX_TMPDIR']};
	// With TMUX set, tmux targets that server regardless of TMUX_TMPDIR, which
	// would put this session on the developer's own server.
	delete process.env['TMUX'];
	process.env['TMUX_TMPDIR'] = dir;
	t.teardown(() => {
		spawnSync('tmux', ['kill-server'], {stdio: 'ignore'});
		if (saved.tmux === undefined) delete process.env['TMUX'];
		else process.env['TMUX'] = saved.tmux;
		if (saved.tmpdir === undefined) delete process.env['TMUX_TMPDIR'];
		else process.env['TMUX_TMPDIR'] = saved.tmpdir;
		rmSync(dir, {recursive: true, force: true});
	});

	const viewer = 'pappardelle-view-view-KEY-1';
	execFileSync('tmux', ['new-session', '-d', '-s', viewer]);

	t.false(sessionExists('pappardelle-view'));
	killSession('pappardelle-view');
	t.true(sessionExists(viewer));
});

tmuxTest(
	'a repo whose name reads as a tmux format still gets its own outer session, titled 🍝 <repo> even when the user turned titles off',
	t => {
		const dir = mkdtempSync(join(tmpdir(), 'pappardelle-tmux-'));
		const conf = join(dir, 'tmux.conf');
		writeFileSync(
			conf,
			'set -g set-titles off\nset -g set-titles-string "#h:#W"\n',
		);
		const tmux = (...args: string[]) =>
			spawnSync('tmux', ['-S', join(dir, 's'), '-f', conf, ...args], {
				encoding: 'utf8',
			});
		t.teardown(() => {
			tmux('kill-server');
			rmSync(dir, {recursive: true, force: true});
		});

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
		t.is(shown.stdout.trim(), 'pappardelle-pasta#S|1|🍝 pasta#S');
	},
);
