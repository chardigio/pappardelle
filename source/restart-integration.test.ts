import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {restartRepo, type RestartCommandDeps} from './restart-command.ts';
import {
	defaultServerTmuxEnv,
	defaultServerTmuxRunner,
	shellQuote,
} from './tmux.ts';

const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

const SESSION = 'pappardelle-itest';

// The test's own view of the default server, whatever TMUX says.
function tmux(...args: string[]): string {
	return execFileSync('tmux', args, {
		encoding: 'utf8',
		env: defaultServerTmuxEnv(process.env),
	}).trim();
}

const panes = () =>
	tmux('list-panes', '-t', `=${SESSION}:^`, '-F', '#{pane_id}');

function addViewers(): void {
	tmux('split-window', '-h', '-t', `=${SESSION}:^`, 'sleep 600');
	tmux('split-window', '-h', '-t', `=${SESSION}:^`, 'sleep 600');
}

async function waitForAttachedClient(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			tmux(
				'display-message',
				'-p',
				'-t',
				`=${SESSION}:`,
				'#{session_attached}',
			) === '1'
		)
			return;
		await delay(50);
	}

	throw new Error('no client attached to the test session');
}

// A TUI window as the user has it: three panes on the default server with a
// terminal attached, restarted from a process whose TMUX names the inner
// server. On tmux next-3.9, `respawn-window -k` on such a window kills the
// server, which detaches the terminal.
tmuxTest(
	'restart from a claude pane keeps the server up and the terminal attached',
	async t => {
		const dir = mkdtempSync(join(tmpdir(), 'pappardelle-restart-'));
		const saved = {
			tmux: process.env['TMUX'],
			tmpdir: process.env['TMUX_TMPDIR'],
		};
		delete process.env['TMUX'];
		process.env['TMUX_TMPDIR'] = dir;
		t.teardown(() => {
			delete process.env['TMUX'];
			spawnSync('tmux', ['-L', 'host', 'kill-server'], {stdio: 'ignore'});
			spawnSync('tmux', ['kill-server'], {stdio: 'ignore'});
			if (saved.tmux !== undefined) process.env['TMUX'] = saved.tmux;
			if (saved.tmpdir === undefined) delete process.env['TMUX_TMPDIR'];
			else process.env['TMUX_TMPDIR'] = saved.tmpdir;
			rmSync(dir, {recursive: true, force: true});
		});

		const repoStateRoot = join(dir, 'repos');
		mkdirSync(join(repoStateRoot, 'itest'), {recursive: true});
		const stub = join(dir, 'stub-tui.cjs');
		writeFileSync(
			stub,
			`require('node:fs').writeFileSync(${JSON.stringify(
				join(repoStateRoot, 'itest', 'tui.json'),
			)}, JSON.stringify({pid: process.pid, cliPath: __filename, sha: 'stub', paneId: process.env.TMUX_PANE, startedAt: Date.now()}));
setInterval(() => {}, 1000);`,
		);
		const launchCommand = `${shellQuote(process.execPath)} ${shellQuote(stub)}`;

		tmux(
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-s',
			SESSION,
			'-x',
			'200',
			'-y',
			'50',
			'sleep 600',
		);
		addViewers();
		tmux(
			'-L',
			'host',
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-x',
			'200',
			'-y',
			'50',
			`env -u TMUX tmux attach-session -t ${shellQuote(`=${SESSION}`)}`,
		);
		await waitForAttachedClient();
		const listPane = panes().split('\n')[0]!;

		// The claude pane's server. Nothing listens there, so any call that
		// followed TMUX instead of going to the default server would fail.
		process.env['TMUX'] = `${join(dir, 'pappardelle_inner')},1,0`;

		const innerCalls: string[][] = [];
		const printed: string[] = [];
		const deps: RestartCommandDeps = {
			tmux: defaultServerTmuxRunner,
			innerTmux(args) {
				innerCalls.push([...args]);
				return {status: 0, stdout: ''};
			},
			repoStateRoot,
			launchCommand,
			cliPath: stub,
			currentSession: () => null,
			onInnerServer: true,
			inTmux: true,
			attach: () => 0,
			runDetached() {},
			isTTY: false,
			confirm: async () => false,
			print(line) {
				printed.push(line);
			},
		};

		const assertRestarted = async () => {
			t.is(
				panes(),
				listPane,
				'only the TUI pane is left, and it is the same pane',
			);
			t.true(
				tmux(
					'display-message',
					'-p',
					'-t',
					listPane,
					'#{pane_start_command}',
				).includes(stub),
			);
			await waitForAttachedClient();
		};

		t.is(await restartRepo('itest', deps), 0, printed.join('\n'));
		await assertRestarted();

		addViewers();
		t.deepEqual(
			await Promise.all([
				restartRepo('itest', deps),
				restartRepo('itest', deps),
			]),
			[0, 0],
			printed.join('\n'),
		);
		await assertRestarted();

		t.is(
			printed.filter(line =>
				/^pappardelle-itest is running .*stub-tui\.cjs \(stub\)$/.test(line),
			).length,
			3,
		);
		t.deepEqual(innerCalls, []);
	},
);
