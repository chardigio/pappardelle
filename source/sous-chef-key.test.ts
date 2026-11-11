import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
import {installSousChefKey} from './tmux.ts';
import {
	getHighlightFilePath,
	highlightWriteCommand,
	readHighlightTarget,
} from './highlight.ts';

const exec = promisify(execFile);

// Each case runs its own tmux server with an attached control client, so keys
// are pressed through the client's key tables the way a user's would be.
// `send-keys -K` arrived in tmux 3.4; older servers skip these cases.
async function fixture(t: ExecutionContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-sous-chef-'));
	const socket = path.join(dir, 'outer');
	const run = async (args: string[]) => {
		const {stdout} = await exec('tmux', ['-S', socket, ...args], {
			env: {...process.env, TMUX: ''},
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
			env: {...process.env, TMUX: ''},
			stdio: ['pipe', 'ignore', 'ignore'],
		},
	);
	t.teardown(async () => {
		client.kill();
		try {
			await exec('tmux', ['-S', socket, 'kill-server']);
		} catch {}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	let clientName = '';
	for (let i = 0; i < 50 && !clientName; i++) {
		clientName = await run(['list-clients', '-F', '#{client_name}']);
		if (!clientName) await delay(20);
	}

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
	const command = highlightWriteCommand(repoName, request, dir);
	fs.mkdirSync(path.dirname(getHighlightFilePath(repoName, dir)), {
		recursive: true,
	});
	const jumped = () => readHighlightTarget(repoName, dir);

	const press = async (window: number, key: string) => {
		await run(['select-window', '-t', `fixture:${window}`]);
		await run(['send-keys', '-K', '-c', clientName, key]);
	};

	const echoed = async (paneId: string, text: string) => {
		const screen = await run(['capture-pane', '-p', '-t', paneId]);
		return screen.includes(text);
	};

	const waitFor = async (check: () => Promise<boolean>) => {
		for (let i = 0; i < 100; i++) {
			if (await check()) return true;
			await delay(20);
		}

		return false;
	};

	const install = async (key: string | null) =>
		installSousChefKey(pappardellePane, key, command, run);

	return {
		run,
		press,
		echoed,
		waitFor,
		install,
		jumped,
		request,
		pappardellePane,
		userPane,
	};
}

async function supportsKeyPresses(): Promise<boolean> {
	try {
		const {stdout} = await exec('tmux', ['-V']);
		const match = /(\d+)\.(\d+)/.exec(stdout);
		if (!match) return false;
		const [major, minor] = [Number(match[1]), Number(match[2])];
		return major > 3 || (major === 3 && minor >= 4);
	} catch {
		return false;
	}
}

test.serial(
	'the key runs the jump in its own window without disturbing the pane',
	async t => {
		if (!(await supportsKeyPresses())) {
			t.pass('tmux without send-keys -K');
			return;
		}

		const f = await fixture(t);
		await f.install('M-s');
		await f.press(0, 'M-s');

		t.true(await f.waitFor(async () => f.jumped() !== null));
		t.deepEqual(f.jumped(), f.request);
		t.is(
			await f.run([
				'display-message',
				'-p',
				'-t',
				f.pappardellePane,
				'#{pane_in_mode}',
			]),
			'0',
		);
		t.false(await f.echoed(f.pappardellePane, '^[s'));
	},
);

test.serial('the key reaches the program in any other window', async t => {
	if (!(await supportsKeyPresses())) {
		t.pass('tmux without send-keys -K');
		return;
	}

	const f = await fixture(t);
	await f.install('M-s');
	await f.press(1, 'M-s');

	t.true(await f.waitFor(async () => f.echoed(f.userPane, '^[s')));
	t.is(f.jumped(), null);
});

test.serial(
	'a changed key stops the old one from acting in the window',
	async t => {
		if (!(await supportsKeyPresses())) {
			t.pass('tmux without send-keys -K');
			return;
		}

		const f = await fixture(t);
		await f.install('M-s');
		await f.install('M-j');

		await f.press(0, 'M-s');
		t.true(await f.waitFor(async () => f.echoed(f.pappardellePane, '^[s')));
		t.is(f.jumped(), null);

		await f.press(0, 'M-j');
		t.true(await f.waitFor(async () => f.jumped() !== null));
	},
);

test.serial('a key turned off passes through in the window', async t => {
	if (!(await supportsKeyPresses())) {
		t.pass('tmux without send-keys -K');
		return;
	}

	const f = await fixture(t);
	await f.install('M-s');
	await f.install(null);
	await f.press(0, 'M-s');

	t.true(await f.waitFor(async () => f.echoed(f.pappardellePane, '^[s')));
	t.is(f.jumped(), null);
});
