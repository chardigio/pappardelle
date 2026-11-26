import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {testState} from '../test/helpers/state.ts';
import {until, untilValue, watcherReady} from '../test/helpers/wait.ts';
import {installSousChefKey} from './tmux.ts';
import {highlightShellCommand, type HighlightRequest} from './highlight.ts';

const exec = promisify(execFile);

// Each case runs its own tmux server with an attached control client, so keys
// are pressed through the client's key tables the way a user's would be. The
// server's HOME is the case's directory, so the request the key makes lands
// in a state directory of the case's own.
async function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-sous-chef-'));
	const socket = path.join(dir, 'outer');
	const env = {...process.env, TMUX: '', HOME: dir};
	const run = async (args: string[]) => {
		const {stdout} = await exec('tmux', ['-S', socket, ...args], {
			env,
			timeout: 5000,
		});
		return stdout.trim();
	};

	// Two windows, each echoing what it receives: window 0 is Pappardelle's,
	// window 1 belongs to the user.
	await run([
		'-f',
		'/dev/null',
		'new-session',
		'-d',
		'-s',
		'fixture',
		'-x',
		'120',
		'-y',
		'30',
		'cat -v',
		';',
		'new-window',
		'-d',
		'cat -v',
	]);
	const client = spawn(
		'tmux',
		['-S', socket, '-C', 'attach', '-t', 'fixture'],
		{
			env,
			stdio: ['pipe', 'ignore', 'ignore'],
		},
	);
	teardown(async () => {
		client.kill();
		try {
			await exec('tmux', ['-S', socket, 'kill-server']);
		} catch {}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	const clientName = await untilValue(
		async () => run(['list-clients', '-F', '#{client_name}']),
		name => name !== '',
		{what: 'the control client to attach', intervalMs: 20},
	);

	const pappardellePane = await run([
		'display-message',
		'-p',
		'-t',
		'fixture:0',
		'#{pane_id}',
	]);
	const userPane = await run([
		'display-message',
		'-p',
		'-t',
		'fixture:1',
		'#{pane_id}',
	]);

	const repoName = 'fixture-repo';
	const request = {issueKey: 'main', focus: true};
	const command = highlightShellCommand(repoName, request);
	const state = testState({
		repo: repoName,
		stateDir: path.join(dir, '.pappardelle'),
	});
	const requests: HighlightRequest[] = [];
	teardown(state.daos.highlight.watch(made => requests.push(made)));
	await watcherReady();
	const jumped = () => requests.at(-1) ?? null;

	const press = async (window: number, key: string) => {
		await run(['select-window', '-t', `fixture:${window}`]);
		await run(['send-keys', '-K', '-c', clientName, key]);
	};

	const echoed = async (paneId: string, text: string) => {
		const screen = await run(['capture-pane', '-p', '-t', paneId]);
		return screen.includes(text);
	};

	const install = async (key: string | null) =>
		installSousChefKey(pappardellePane, key, command, run);

	return {
		run,
		press,
		echoed,
		install,
		jumped,
		request,
		pappardellePane,
		userPane,
	};
}

test('the key runs the jump in its own window without disturbing the pane', async () => {
	const f = await fixture();
	await f.install('M-s');
	await f.press(0, 'M-s');

	await until(() => f.jumped() !== null, {what: 'the jump request'});
	expect(f.jumped()).toStrictEqual(f.request);
	expect(
		await f.run([
			'display-message',
			'-p',
			'-t',
			f.pappardellePane,
			'#{pane_in_mode}',
		]),
	).toBe('0');
	expect(await f.echoed(f.pappardellePane, '^[s')).toBe(false);
});

test('the key reaches the program in any other window', async () => {
	const f = await fixture();
	await f.install('M-s');
	await f.press(1, 'M-s');

	await until(async () => f.echoed(f.userPane, '^[s'), {
		what: 'the key to reach the user pane',
		intervalMs: 20,
	});
	expect(f.jumped()).toBe(null);
});

test('a changed key stops the old one from acting in the window', async () => {
	const f = await fixture();
	await f.install('M-s');
	await f.install('M-j');

	await f.press(0, 'M-s');
	await until(async () => f.echoed(f.pappardellePane, '^[s'), {
		what: 'the old key to reach the pane',
		intervalMs: 20,
	});
	expect(f.jumped()).toBe(null);

	await f.press(0, 'M-j');
	await until(() => f.jumped() !== null, {what: 'the jump request'});
});

test('a key turned off passes through in the window', async () => {
	const f = await fixture();
	await f.install('M-s');
	await f.install(null);
	await f.press(0, 'M-s');

	await until(async () => f.echoed(f.pappardellePane, '^[s'), {
		what: 'the key to reach the pane',
		intervalMs: 20,
	});
	expect(f.jumped()).toBe(null);
});
