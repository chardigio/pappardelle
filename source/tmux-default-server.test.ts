import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {
	currentDefaultServerSession,
	currentInnerServerSession,
	defaultServerTmuxEnv,
	isOnInnerServer,
	type OuterTmuxRunner,
} from './tmux.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

// ============================================================================
// Reaching the default tmux server from an inner pane
// ============================================================================

test('outer tmux calls drop TMUX so an inner pane still reaches the default server', () => {
	const env = defaultServerTmuxEnv({
		TMUX: '/private/tmp/tmux-502/pappardelle_inner,59729,4',
		TMUX_PANE: '%4',
		TMUX_TMPDIR: '/scratch/tmux',
		HOME: '/home/me',
	});

	expect('TMUX' in env).toBe(false);
	expect('TMUX_PANE' in env).toBe(false);
	expect(env['TMUX_TMPDIR']).toBe('/scratch/tmux');
	expect(env['HOME']).toBe('/home/me');
});

test('inner identity uses the selected named or absolute socket from its supplied environment', () => {
	const root = tempDir('tmux-default-server-test-');
	const socketDir = path.join(root, `tmux-${process.getuid?.() ?? 0}`);
	fs.mkdirSync(socketDir);
	for (const selected of ['custom', path.join(root, "socket with ' quotes")]) {
		const socket = selected.startsWith('/')
			? selected
			: path.join(socketDir, selected);
		fs.writeFileSync(socket, '');
		const env = {
			TMUX: `${socket},1,0`,
			TMUX_PANE: '%7',
			TMUX_TMPDIR: root,
			PAPPARDELLE_TMUX_SOCKET: selected,
		};
		expect(isOnInnerServer(env)).toBe(true);
		expect(
			currentInnerServerSession(env, () => ({
				status: 0,
				stdout: 'agent-repo-TEST-1\n',
			})),
		).toBe('agent-repo-TEST-1');
		expect(isOnInnerServer({...env, PAPPARDELLE_TMUX_SOCKET: 'another'})).toBe(
			false,
		);
	}
});

test('the current outer session is unknown when TMUX names a non-default socket', () => {
	const tmuxTmpdir = tempDir('tmux-default-server-test-');
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

	expect(
		currentDefaultServerSession(
			{
				TMUX: `${path.join(socketDir, 'pappardelle_inner')},1,0`,
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
	).toBe(null);
	expect(queried).toStrictEqual([]);

	expect(
		currentDefaultServerSession(
			{
				TMUX: `${path.join(socketDir, 'default')},1,0`,
				TMUX_PANE: '%3',
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
	).toBe('pappardelle-app');
	expect(queried).toStrictEqual([
		['display-message', '-p', '-t', '%3', '#{session_name}'],
	]);
	expect(currentDefaultServerSession({TMUX_TMPDIR: tmuxTmpdir}, tmux)).toBe(
		null,
	);
});
