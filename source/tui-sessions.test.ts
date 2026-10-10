import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	FAKE_CLI_PATH,
	FAKE_SHA,
	FAST,
	REFUSAL,
	fakeTuiTmux,
	restarted,
} from '../test/helpers/fake-tui-tmux.ts';
import {restartLockPath} from './tui-marker.ts';
import {
	installedLaunchCommand,
	listRunningTuis,
	restartAndVerifyTui,
	restartOwnTui,
	restartTuis,
	tuiLaunchCommand,
} from './tui-sessions.ts';

let counter = 0;
function repoStateRoot(repos: string[]): string {
	const dir = path.join(
		os.tmpdir(),
		`tui-sessions-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	for (const repo of repos) {
		fs.mkdirSync(path.join(dir, repo));
	}

	return dir;
}

const COMMAND = "'/node' '/build/dist/cli.js'";

function setup(
	sessions: string[],
	behavior: Parameters<typeof fakeTuiTmux>[0]['behavior'] = {},
) {
	const root = repoStateRoot(
		sessions.map(name => name.replace(/^pappardelle-/, '')),
	);
	const printed: string[] = [];
	const {tmux, calls} = fakeTuiTmux({repoStateRoot: root, sessions, behavior});
	return {
		root,
		calls,
		printed,
		deps: {
			tmux,
			repoStateRoot: root,
			timing: FAST,
			print(line: string) {
				printed.push(line);
			},
		},
	};
}

const app = {session: 'pappardelle-app', repo: 'app'};

test('only pappardelle sessions with a repo state dir count as TUIs', t => {
	const root = repoStateRoot(['app', 'web']);
	const {tmux} = fakeTuiTmux({
		repoStateRoot: root,
		sessions: [
			'pappardelle-app',
			'pappardelle-decoy',
			'claude-app-STA-1',
			'pappardelle-web',
		],
	});

	t.deepEqual(listRunningTuis(tmux, root), [
		{session: 'pappardelle-app', repo: 'app'},
		{session: 'pappardelle-web', repo: 'web'},
	]);
});

test('a dotted repo name matches with or without tmux rewriting the dot', t => {
	const root = repoStateRoot(['my.repo', 'next.js']);
	const {tmux} = fakeTuiTmux({
		repoStateRoot: root,
		sessions: ['pappardelle-my_repo', 'pappardelle-next.js'],
	});

	t.deepEqual(listRunningTuis(tmux, root), [
		{session: 'pappardelle-my_repo', repo: 'my.repo'},
		{session: 'pappardelle-next.js', repo: 'next.js'},
	]);
});

test("a restart closes the viewers and reruns the command in the TUI's own pane", async t => {
	const h = setup(['pappardelle-web', 'pappardelle-app']);

	t.true(await restartAndVerifyTui(app, COMMAND, FAKE_CLI_PATH, h.deps));

	t.deepEqual(
		h.calls.filter(args => args[0] !== 'display-message'),
		[
			['list-panes', '-t', '=pappardelle-app:^', '-F', '#{pane_id}'],
			[
				'kill-pane',
				'-a',
				'-t',
				'%1',
				';',
				'respawn-pane',
				'-k',
				'-t',
				'%1',
				COMMAND,
			],
		],
	);
	t.is(
		h.printed.at(-1),
		`pappardelle-app is running ${FAKE_CLI_PATH} (${FAKE_SHA})`,
	);
	t.false(fs.existsSync(restartLockPath(h.root, 'app')));
});

test("a refused restart reports tmux's own error", async t => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'refused'});

	t.false(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.is(h.printed.at(-1), `Couldn't restart pappardelle-app: ${REFUSAL}`);
	t.false(fs.existsSync(restartLockPath(h.root, 'app')));
});

test('a TUI that comes up on another cli.js fails, naming both', async t => {
	const h = setup(['pappardelle-app'], {
		'pappardelle-app': {cliPath: '/old/dist/cli.js'},
	});

	t.false(await restartAndVerifyTui(app, COMMAND, FAKE_CLI_PATH, h.deps));
	t.is(
		h.printed.at(-1),
		`pappardelle-app is running /old/dist/cli.js, not ${FAKE_CLI_PATH}`,
	);
});

test('with no expected cli.js, whichever build comes up is reported', async t => {
	const h = setup(['pappardelle-app'], {
		'pappardelle-app': {cliPath: '/old/dist/cli.js'},
	});

	t.true(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.true(h.printed.at(-1)!.includes('is running /old/dist/cli.js'));
});

test('a TUI that exits during startup fails without waiting out the timeout', async t => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'exits'});
	h.deps.timing = {...FAST, readyTimeoutMs: 60_000};

	t.false(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.true(h.printed.at(-1)!.startsWith('pappardelle-app exited during startup'));
});

test('a TUI that never reports ready times out', async t => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'silent'});

	t.false(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.true(h.printed.at(-1)!.startsWith('pappardelle-app did not report ready'));
});

test('a marker left by the previous TUI does not count as ready', async t => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'silent'});
	fs.writeFileSync(
		path.join(h.root, 'app', 'tui.json'),
		JSON.stringify({
			pid: 1,
			cliPath: FAKE_CLI_PATH,
			sha: FAKE_SHA,
			paneId: '%0',
			startedAt: Date.now() - 1000,
		}),
	);

	t.false(await restartAndVerifyTui(app, COMMAND, null, h.deps));
});

test('a second restart waits for the first instead of overlapping it', async t => {
	const h = setup(['pappardelle-app']);
	fs.writeFileSync(restartLockPath(h.root, 'app'), `${process.pid}\n`);
	setTimeout(() => {
		t.deepEqual(restarted(h.calls, ['pappardelle-app']), []);
		fs.unlinkSync(restartLockPath(h.root, 'app'));
	}, 60);

	t.true(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.deepEqual(restarted(h.calls, ['pappardelle-app']), ['pappardelle-app']);
});

test('a restart that stays locked gives up and leaves the TUI alone', async t => {
	const h = setup(['pappardelle-app']);
	fs.writeFileSync(restartLockPath(h.root, 'app'), `${process.pid}\n`);

	t.false(await restartAndVerifyTui(app, COMMAND, null, h.deps));
	t.deepEqual(restarted(h.calls, ['pappardelle-app']), []);
	t.true(h.printed.at(-1)!.includes(`another restart (pid ${process.pid})`));
});

test('a lock left by a dead process is taken over', async t => {
	const h = setup(['pappardelle-app']);
	// Pids are capped far below this on every supported platform.
	fs.writeFileSync(restartLockPath(h.root, 'app'), '2147483646\n');

	t.true(await restartAndVerifyTui(app, COMMAND, null, h.deps));
});

test('several TUIs restart one at a time, the current session last', async t => {
	const sessions = ['pappardelle-app', 'pappardelle-web', 'pappardelle-api'];
	const h = setup(sessions, {'pappardelle-web': 'refused'});

	const failed = await restartTuis(
		sessions.map(session => ({
			session,
			repo: session.replace('pappardelle-', ''),
		})),
		COMMAND,
		{...h.deps, currentSession: () => 'pappardelle-app'},
	);

	t.deepEqual(failed, ['pappardelle-web']);
	t.deepEqual(restarted(h.calls, sessions), [
		'pappardelle-web',
		'pappardelle-api',
		'pappardelle-app',
	]);
});

// ============================================================================
// The TUI restarting itself (U)
// ============================================================================

function ownHarness(
	options: {
		current?: string | null;
		behavior?: Parameters<typeof fakeTuiTmux>[0]['behavior'];
	} = {},
) {
	const h = setup(['pappardelle-app'], options.behavior);
	const killed: string[] = [];
	let keyWaits = 0;
	return {
		...h,
		killed,
		keyWaits: () => keyWaits,
		deps: {
			...h.deps,
			currentSession: () =>
				options.current === undefined ? 'pappardelle-app' : options.current,
			killSession(name: string) {
				killed.push(name);
			},
			waitForKey() {
				keyWaits++;
			},
			sleep() {},
		},
	};
}

const own = {repoName: 'app', command: COMMAND, hasPaneLayout: true};

test('U reruns its own pane and leaves the lock for the next restart to clear', t => {
	const h = ownHarness();

	restartOwnTui(own, h.deps);

	t.deepEqual(restarted(h.calls, ['pappardelle-app']), ['pappardelle-app']);
	t.deepEqual(h.killed, []);
	t.is(h.keyWaits(), 0);
	t.true(fs.existsSync(restartLockPath(h.root, 'app')));
});

test('U shows why tmux refused and waits for a key instead of killing the session', t => {
	const h = ownHarness({behavior: {'pappardelle-app': 'refused'}});

	restartOwnTui(own, h.deps);

	t.deepEqual(h.killed, []);
	t.is(h.keyWaits(), 1);
	t.true(h.printed.at(-1)!.startsWith(`Couldn't restart: ${REFUSAL}.`));
	t.false(fs.existsSync(restartLockPath(h.root, 'app')));
});

test("U inside the user's own tmux session closes the layout and restarts nothing", t => {
	const h = ownHarness({current: 'work'});

	restartOwnTui(own, h.deps);

	t.deepEqual(h.killed, ['pappardelle-app']);
	t.deepEqual(restarted(h.calls, ['pappardelle-app']), []);
});

test('U without a pane layout leaves tmux alone', t => {
	const h = ownHarness({current: null});

	restartOwnTui({...own, hasPaneLayout: false}, h.deps);

	t.deepEqual(h.killed, []);
	t.deepEqual(h.calls, []);
});

// ============================================================================
// Launch commands
// ============================================================================

test('after an install, restarts go through the shim when there is one', t => {
	const options = {
		execPath: '/node',
		cliPath: '/work/pappardelle/dist/cli.js',
		home: '/home/me',
	};

	t.is(
		installedLaunchCommand({...options, exists: () => true}),
		"'/home/me/.local/bin/pappardelle'",
	);
	t.is(
		installedLaunchCommand({...options, exists: () => false}),
		"'/node' '/work/pappardelle/dist/cli.js'",
	);
});

test('a TUI started from the installed release launches through the shim', t => {
	t.is(
		tuiLaunchCommand({
			execPath: '/old/node',
			cliPath: '/home/me/.pappardelle/repo/dist/cli.js',
			args: [],
			home: '/home/me',
			exists: file => file === '/home/me/.local/bin/pappardelle',
		}),
		"'/home/me/.local/bin/pappardelle'",
	);
});

test('a dev build keeps its own node and cli.js', t => {
	t.is(
		tuiLaunchCommand({
			execPath: '/old/node',
			cliPath: '/work/pappardelle/dist/cli.js',
			args: ['--foo'],
			home: '/home/me',
			exists: () => true,
		}),
		"'/old/node' '/work/pappardelle/dist/cli.js' --foo",
	);
});

test('the release falls back to node and cli.js when the shim is missing', t => {
	t.is(
		tuiLaunchCommand({
			execPath: '/old/node',
			cliPath: '/home/me/.pappardelle/repo/dist/cli.js',
			args: [],
			home: '/home/me',
			exists: () => false,
		}),
		"'/old/node' '/home/me/.pappardelle/repo/dist/cli.js'",
	);
});
