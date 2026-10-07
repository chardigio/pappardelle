import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	currentDefaultServerSession,
	defaultServerTmuxEnv,
	type OuterTmuxRunner,
} from './tmux.ts';

let counter = 0;
function temporaryDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`tmux-default-server-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// ============================================================================
// Reaching the default tmux server from an inner pane
// ============================================================================

test('outer tmux calls drop TMUX so an inner pane still reaches the default server', t => {
	const env = defaultServerTmuxEnv({
		TMUX: '/private/tmp/tmux-502/pappardelle_inner,59729,4',
		TMUX_PANE: '%4',
		TMUX_TMPDIR: '/scratch/tmux',
		HOME: '/home/me',
	});

	t.false('TMUX' in env);
	t.false('TMUX_PANE' in env);
	t.is(env['TMUX_TMPDIR'], '/scratch/tmux');
	t.is(env['HOME'], '/home/me');
});

test('the current outer session is unknown when TMUX names a non-default socket', t => {
	const tmuxTmpdir = temporaryDir();
	const uid = process.getuid?.() ?? 0;
	const socketDir = path.join(tmuxTmpdir, `tmux-${uid}`);
	fs.mkdirSync(socketDir);
	fs.writeFileSync(path.join(socketDir, 'default'), '');
	fs.writeFileSync(path.join(socketDir, 'pappardelle_inner'), '');

	const queried: string[][] = [];
	const tmux: OuterTmuxRunner = args => {
		queried.push([...args]);
		return {status: 0, stdout: 'pappardelle-app\n'};
	};

	t.is(
		currentDefaultServerSession(
			{
				TMUX: `${path.join(socketDir, 'pappardelle_inner')},1,0`,
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
		null,
	);
	t.deepEqual(queried, []);

	t.is(
		currentDefaultServerSession(
			{
				TMUX: `${path.join(socketDir, 'default')},1,0`,
				TMUX_PANE: '%3',
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
		'pappardelle-app',
	);
	t.deepEqual(queried, [
		['display-message', '-p', '-t', '%3', '#{session_name}'],
	]);
	t.is(currentDefaultServerSession({TMUX_TMPDIR: tmuxTmpdir}, tmux), null);
});
