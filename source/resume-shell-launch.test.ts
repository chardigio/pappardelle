// A restore runs for real: tmux on a private server starts the pane argv
// buildShellLaunchArgs makes, under bash and zsh with rc files that try to
// get in the way, and a recorder program writes what it received.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {expect} from 'bun:test';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tmuxOn, tmuxTest} from '../test/helpers/tmux-test.ts';
import {until, REAL_TMUX_TIMEOUT_MS} from '../test/helpers/wait.ts';
import {buildShellLaunchArgs} from './tmux.ts';

const HOSTILE = [
	'$(touch pwned)',
	'a; b',
	';',
	'a;',
	'a\\;',
	'*',
	'--x',
	'',
	'x y',
];

function fixture(shellName: 'bash' | 'zsh') {
	const root = tempDir('resume-shell-');
	const home = path.join(root, 'home');
	const bin = path.join(root, 'bin');
	const work = path.join(root, 'work dir');
	for (const dir of [home, bin, work]) mkdirSync(dir);
	const out = path.join(root, 'out');
	const recorder = path.join(bin, 'recorder');
	writeFileSync(
		recorder,
		`#!/bin/sh\nprintf '%s\\0' "$@" > '${out}.argv'\npwd > '${out}.cwd'\nprintf '%s' "\${OSC7577_TOKEN-unset}" > '${out}.token'\nexit "\${RECORDER_EXIT:-0}"\n`,
		{mode: 0o755},
	);
	// The rc files move away from the restore's directory and shadow every
	// name a restore could be fooled by.
	const rc = [
		'cd /',
		`env() { touch '${out}.function'; }`,
		`recorder() { touch '${out}.function'; }`,
		`eval() { touch '${out}.function'; }`,
		`PATH='${bin}':"$PATH"`,
	].join('\n');
	writeFileSync(
		path.join(home, '.bashrc'),
		`${rc}\ncd() { touch '${out}.function'; builtin cd "$@"; }\n`,
	);
	writeFileSync(
		path.join(home, '.zshrc'),
		`${rc}\ncd() { touch '${out}.function'; builtin cd "$@"; }\n`,
	);
	const socket = path.join(root, 'tmux.sock');
	const tmux = tmuxOn(socket);
	teardown(() => tmux('kill-server'));
	const shell = spawnSync('which', [shellName], {
		encoding: 'utf8',
	}).stdout.trim();
	const start = (
		command: string,
		files: {tokenFile?: string; restoreFile?: string},
		env: Record<string, string> = {},
	) => {
		const previous = process.env['SHELL'];
		process.env['SHELL'] = shell;
		const argv = buildShellLaunchArgs(command, false, files);
		process.env['SHELL'] = previous;
		const result = spawnSync(
			'tmux',
			[
				'-S',
				socket,
				'-f',
				'/dev/null',
				'new-session',
				'-d',
				'-c',
				root,
				...argv,
			],
			{
				encoding: 'utf8',
				cwd: root,
				env: {...process.env, HOME: home, ZDOTDIR: home, ...env},
			},
		);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	};
	const restoreFile = (dir: string, argv: string[]) => {
		const file = path.join(root, 'restore');
		writeFileSync(file, [dir, ...argv].map(line => `${line}\n`).join(''), {
			mode: 0o600,
		});
		return file;
	};
	const recorded = async () => {
		await until(() => existsSync(`${out}.token`), {
			what: 'the recorder',
			timeoutMs: REAL_TMUX_TIMEOUT_MS,
		});
		return {
			argv: readFileSync(`${out}.argv`, 'utf8').split('\0').slice(0, -1),
			cwd: readFileSync(`${out}.cwd`, 'utf8').trim(),
			token: readFileSync(`${out}.token`, 'utf8'),
		};
	};
	return {root, work, out, recorder, start, restoreFile, recorded};
}

for (const shellName of ['bash', 'zsh'] as const) {
	const hasShell = spawnSync('which', [shellName]).status === 0;
	const shellTest = hasShell ? tmuxTest : tmuxTest.skip;

	shellTest(
		`${shellName}: each argv element reaches the program unchanged, in the record's directory`,
		async () => {
			const f = fixture(shellName);
			const restore = f.restoreFile(f.work, ['recorder', ...HOSTILE]);
			f.start('touch fallback-ran', {restoreFile: restore});
			const got = await f.recorded();
			expect(got.argv).toStrictEqual(HOSTILE);
			expect(got.cwd).toBe(f.work);
			expect(existsSync(path.join(f.work, 'pwned'))).toBe(false);
			expect(existsSync(path.join(f.root, 'pwned'))).toBe(false);
			expect(existsSync(`${f.out}.function`)).toBe(false);
			expect(existsSync(restore)).toBe(false);
			expect(existsSync(path.join(f.root, 'fallback-ran'))).toBe(false);
		},
	);

	shellTest(
		`${shellName}: the fallback runs only when the record's program could not start`,
		async () => {
			const f = fixture(shellName);
			f.start(`'${f.recorder}' fallback`, {
				restoreFile: f.restoreFile(f.work, ['/nonexistent/program']),
			});
			const fRecorded = await f.recorded();
			expect(fRecorded.argv).toStrictEqual(['fallback']);

			const g = fixture(shellName);
			g.start(
				`touch '${g.root}/fallback-ran'`,
				{restoreFile: g.restoreFile(g.work, [g.recorder, 'once'])},
				{RECORDER_EXIT: '1'},
			);
			const gRecorded = await g.recorded();
			expect(gRecorded.argv).toStrictEqual(['once']);
			await Bun.sleep(300);
			expect(existsSync(path.join(g.root, 'fallback-ran'))).toBe(false);

			const h = fixture(shellName);
			h.start(`'${h.recorder}' fallback`, {
				restoreFile: h.restoreFile(path.join(h.root, 'gone'), [
					h.recorder,
					'restored',
				]),
			});
			const hRecorded = await h.recorded();
			expect(hRecorded.argv).toStrictEqual(['fallback']);
		},
	);
}

tmuxTest(
	'the pane gets the token from its one-shot file, and never an inherited one',
	async () => {
		const f = fixture('bash');
		const tokenFile = path.join(f.root, 'token');
		writeFileSync(tokenFile, 'fresh-token', {mode: 0o600});
		f.start(`'${f.recorder}'`, {tokenFile}, {OSC7577_TOKEN: 'inherited'});
		const fRecorded = await f.recorded();
		expect(fRecorded.token).toBe('fresh-token');
		expect(existsSync(tokenFile)).toBe(false);

		const g = fixture('bash');
		g.start(`'${g.recorder}'`, {}, {OSC7577_TOKEN: 'inherited'});
		const gRecorded = await g.recorded();
		expect(gRecorded.token).toBe('unset');
	},
);
