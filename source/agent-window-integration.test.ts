// Reading a space's agent against a real tmux server. The servers run on their
// own sockets in a short temp directory, never the user's servers, and are
// killed through those sockets only.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {captureAgentScreen, READ_WINDOW} from './agent-state.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

const dir = realpathSync(mkdtempSync('/tmp/pw-'));
const inner = `${dir}/i`;
const viewer = `${dir}/o`;
const {TMUX: _tmux, TMUX_PANE: _pane, ...env} = process.env;

const on =
	(socket: string): OuterTmuxRunner =>
	args => {
		const r = spawnSync('tmux', ['-S', socket, ...args], {
			encoding: 'utf8',
			env,
			timeout: 5000,
		});
		return {
			error: r.error,
			status: r.status,
			stdout: r.stdout,
			stderr: r.stderr,
		};
	};

const runner = on(inner);
const deps = {repo: 'itest', runner, sleep: delay};
const AGENT = 'agent-itest-KEY-1';
const sizeOf = () =>
	runner([
		'display-message',
		'-p',
		'-t',
		`=${AGENT}:`,
		'#{window_width}x#{window_height}',
	]).stdout.trim();

// Redraws its terminal's size the way an agent redraws its dialog.
const SHOW_SIZE = String.raw`while :; do printf '\033[H\033[2J%s\n' "$(stty size)"; sleep 0.05; done`;

async function waitFor(check: () => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (check()) return true;
		await delay(50);
	}

	return false;
}

test.after.always(() => {
	runner(['kill-server']);
	on(viewer)(['kill-server']);
	rmSync(dir, {recursive: true, force: true});
});

test.beforeEach(() => {
	runner(['kill-server']);
	on(viewer)(['kill-server']);
	runner(['-f', '/dev/null', 'new-session', '-d', '-s', AGENT, SHOW_SIZE]);
});

tmuxTest(
	'a window no client shows grows before it is read, then follows the next client',
	async t => {
		t.is(sizeOf(), '80x24');
		const screen = await captureAgentScreen('KEY-1', 60, deps);
		t.is(sizeOf(), `${READ_WINDOW.columns}x${READ_WINDOW.rows}`);
		t.regex(
			screen ?? '',
			new RegExp(`^${READ_WINDOW.rows} ${READ_WINDOW.columns}$`, 'm'),
		);

		on(viewer)([
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-x',
			'70',
			'-y',
			'20',
			`env -u TMUX tmux -S ${inner} attach -t '=${AGENT}'`,
		]);
		// The viewer's status line takes a row of its 20.
		t.true(await waitFor(() => sizeOf() === '70x19'), sizeOf());
	},
);

tmuxTest('a window a client shows keeps its size', async t => {
	on(viewer)([
		'-f',
		'/dev/null',
		'new-session',
		'-d',
		'-x',
		'61',
		'-y',
		'22',
		`env -u TMUX tmux -S ${inner} attach -t '=${AGENT}'`,
	]);
	t.true(await waitFor(() => sizeOf() === '61x21'), sizeOf());
	await captureAgentScreen('KEY-1', 60, deps);
	t.is(sizeOf(), '61x21');
});
