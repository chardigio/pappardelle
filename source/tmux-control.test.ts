import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {
	ControlClientNeverStarted,
	TmuxControlClient,
	controlCommandLine,
} from './tmux-control.ts';

const exec = promisify(execFile);

test('a command that would hold the queue, or span lines, is left to a process', () => {
	expect(controlCommandLine(['wait-for', 'channel'])).toBe(undefined);
	expect(
		controlCommandLine(['set-option', '-g', '@a', 'b', ';', 'wait-for', 'c']),
	).toBe(undefined);
	expect(controlCommandLine(['kill-server'])).toBe(undefined);
	expect(controlCommandLine(['set-option', '-g', '@a', 'two\nlines'])).toBe(
		undefined,
	);
	expect(controlCommandLine(['wait-for', '-S', 'channel'])).toBe(
		"'wait-for' '-S' 'channel'",
	);
});

test('separators stay separators and every other argument is quoted whole', () => {
	expect(
		controlCommandLine([
			'set-option',
			'-g',
			'@a',
			"it's; here",
			';',
			'kill-pane',
		]),
	).toBe(String.raw`'set-option' '-g' '@a' 'it'\''s; here' ; 'kill-pane'`);
});

test('real tmux answers quoted commands, command lists and failures like a process would', async () => {
	try {
		await exec('tmux', ['-V']);
	} catch {
		expect().pass('tmux unavailable');
		return;
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-control-'));
	const socket = path.join(dir, 'server');
	const env = {...process.env, TMUX: ''};
	await exec(
		'tmux',
		['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture'],
		{env},
	);
	const client = new TmuxControlClient(
		[
			'-S',
			socket,
			'-C',
			'attach-session',
			'-f',
			'ignore-size,no-output',
			'-t',
			'fixture',
		],
		{cwd: dir},
	);
	teardown(async () => {
		client.stop();
		try {
			await exec('tmux', ['-S', socket, 'kill-server'], {env});
		} catch {}

		fs.rmSync(dir, {recursive: true, force: true});
	});
	const run = async (args: string[]) => client.run(controlCommandLine(args)!);

	const awkward = String.raw`it's "quoted" $HOME #{pane_id} ; 'x' \ end`;
	expect(await run(['set-option', '-g', '@probe', awkward])).toBe('');
	expect(await run(['show-option', '-gqv', '@probe'])).toBe(`${awkward}\n`);

	// A pane id starts with the same character as a reply's guard lines.
	const paneId = await run([
		'display-message',
		'-p',
		'-t',
		'fixture',
		'#{pane_id}',
	]);
	expect(paneId).toMatch(/^%\d+\n$/);
	expect(
		await run([
			'display-message',
			'-p',
			'-t',
			'fixture',
			'#{pane_id}',
			';',
			'show-option',
			'-gqv',
			'@probe',
		]),
	).toBe(`${paneId}${awkward}\n`);

	const failure = await rejectionOf(
		run(['has-session', '-t', '=no-such-session:']),
	);
	expect(failure).toMatchObject({code: 1, killed: false, signal: null});
	expect((failure as unknown as {stderr: string}).stderr).toMatch(
		/^can't find session:/m,
	);
	// A conditional's own commands answer as part of the list that ran it.
	expect(
		await run([
			'if-shell',
			'-F',
			'0',
			'',
			"set-option -g @branch taken ; display-message -p 'from the branch'",
			';',
			'show-option',
			'-gqv',
			'@branch',
		]),
	).toBe('from the branch\ntaken\n');
	// A list that stops part-way has still printed what came before.
	const partial = await rejectionOf(
		run([
			'display-message',
			'-p',
			'before',
			';',
			'has-session',
			'-t',
			'=no-such-session:',
		]),
	);
	expect((partial as unknown as {stdout: string}).stdout).toBe('before\n');
	// The queue keeps answering after a failure.
	expect(await run(['show-option', '-gqv', '@probe'])).toBe(`${awkward}\n`);
});

test('a client that starts a session with two commands answers the first command sent', async () => {
	try {
		await exec('tmux', ['-V']);
	} catch {
		expect().pass('tmux unavailable');
		return;
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-control-'));
	const socket = path.join(dir, 'server');
	const client = new TmuxControlClient(
		[
			'-S',
			socket,
			'-f',
			'/dev/null',
			'-C',
			'new-session',
			'-s',
			'control',
			'tail -f /dev/null',
			';',
			'set-option',
			'-t',
			'=control:',
			'destroy-unattached',
			'on',
		],
		{cwd: dir},
	);
	teardown(async () => {
		client.stop();
		try {
			await exec('tmux', ['-S', socket, 'kill-server'], {
				env: {...process.env, TMUX: ''},
			});
		} catch {}

		fs.rmSync(dir, {recursive: true, force: true});
	});
	expect(
		await client.run(controlCommandLine(['display-message', '-p', 'first'])!),
	).toBe('first\n');
	expect(
		await client.run(controlCommandLine(['display-message', '-p', 'second'])!),
	).toBe('second\n');
});

test('commands queued on a client that never starts say tmux has not run them', async () => {
	try {
		await exec('tmux', ['-V']);
	} catch {
		expect().pass('tmux unavailable');
		return;
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-control-'));
	teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const client = new TmuxControlClient(
		[
			'-S',
			path.join(dir, 'no-server'),
			'-C',
			'attach-session',
			'-t',
			'missing',
		],
		{cwd: dir},
	);
	await rejectionOf(
		client.run(controlCommandLine(['display-message', '-p', 'x'])!),
		ControlClientNeverStarted,
	);
	expect(client.usable).toBe(false);
});
