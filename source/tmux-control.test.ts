import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {
	ControlClientNeverStarted,
	TmuxControlClient,
	controlCommandLine,
} from './tmux-control.ts';

const exec = promisify(execFile);

test('a command that would hold the queue, or span lines, is left to a process', t => {
	t.is(controlCommandLine(['wait-for', 'channel']), undefined);
	t.is(
		controlCommandLine(['set-option', '-g', '@a', 'b', ';', 'wait-for', 'c']),
		undefined,
	);
	t.is(controlCommandLine(['kill-server']), undefined);
	t.is(controlCommandLine(['set-option', '-g', '@a', 'two\nlines']), undefined);
	t.is(
		controlCommandLine(['wait-for', '-S', 'channel']),
		"'wait-for' '-S' 'channel'",
	);
});

test('separators stay separators and every other argument is quoted whole', t => {
	t.is(
		controlCommandLine([
			'set-option',
			'-g',
			'@a',
			"it's; here",
			';',
			'kill-pane',
		]),
		String.raw`'set-option' '-g' '@a' 'it'\''s; here' ; 'kill-pane'`,
	);
});

test.serial(
	'real tmux answers quoted commands, command lists and failures like a process would',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
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
		t.teardown(async () => {
			client.stop();
			try {
				await exec('tmux', ['-S', socket, 'kill-server'], {env});
			} catch {}

			fs.rmSync(dir, {recursive: true, force: true});
		});
		const run = async (args: string[]) => client.run(controlCommandLine(args)!);

		const awkward = String.raw`it's "quoted" $HOME #{pane_id} ; 'x' \ end`;
		t.is(await run(['set-option', '-g', '@probe', awkward]), '');
		t.is(await run(['show-option', '-gqv', '@probe']), `${awkward}\n`);

		// A pane id starts with the same character as a reply's guard lines.
		const paneId = await run([
			'display-message',
			'-p',
			'-t',
			'fixture',
			'#{pane_id}',
		]);
		t.regex(paneId, /^%\d+\n$/);
		t.is(
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
			`${paneId}${awkward}\n`,
		);

		const failure = await t.throwsAsync(
			run(['has-session', '-t', '=no-such-session:']),
		);
		t.like(failure, {code: 1, killed: false, signal: null});
		t.regex(
			(failure as unknown as {stderr: string}).stderr,
			/^can't find session:/m,
		);
		// A conditional's own commands answer as part of the list that ran it.
		t.is(
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
			'from the branch\ntaken\n',
		);
		// The queue keeps answering after a failure.
		t.is(await run(['show-option', '-gqv', '@probe']), `${awkward}\n`);
	},
);

test.serial(
	'a client that starts a session with two commands answers the first command sent',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
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
		t.teardown(async () => {
			client.stop();
			try {
				await exec('tmux', ['-S', socket, 'kill-server'], {
					env: {...process.env, TMUX: ''},
				});
			} catch {}

			fs.rmSync(dir, {recursive: true, force: true});
		});
		t.is(
			await client.run(controlCommandLine(['display-message', '-p', 'first'])!),
			'first\n',
		);
		t.is(
			await client.run(
				controlCommandLine(['display-message', '-p', 'second'])!,
			),
			'second\n',
		);
	},
);

test.serial(
	'commands queued on a client that never starts say tmux has not run them',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-control-'));
		t.teardown(() => {
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
		await t.throwsAsync(
			client.run(controlCommandLine(['display-message', '-p', 'x'])!),
			{instanceOf: ControlClientNeverStarted},
		);
		t.false(client.usable);
	},
);
