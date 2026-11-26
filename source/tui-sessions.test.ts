import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {tmuxTest} from '../test/helpers/tmux-test.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {
	FAKE_CLI_PATH,
	FAKE_SHA,
	FAST,
	REFUSAL,
	fakeTuiTmux,
	restarted,
	tuiStateRoot,
} from '../test/helpers/fake-tui-tmux.ts';
import {restartLockPath} from './tui-marker.ts';
import {
	closeTuiLayout,
	installedLaunchCommand,
	listRunningTuis,
	paneRespawned,
	restartAndVerifyTui,
	restartOwnTui,
	restartTuis,
	tuiLaunchCommand,
} from './tui-sessions.ts';

const COMMAND =
	"'/node' '--no-env-file' '--config=/dev/null' '/build/dist/cli.js'";

function setup(
	sessions: string[],
	behavior: Parameters<typeof fakeTuiTmux>[0]['behavior'] = {},
	tuiPane: Record<string, string> = {},
) {
	const {repoStateRoot: root, tuiMarker} = tuiStateRoot(
		sessions.map(name => name.replace(/^pappardelle-/, '')),
	);
	const printed: string[] = [];
	const {tmux, calls} = fakeTuiTmux({
		tuiMarker,
		sessions,
		behavior,
		tuiPane,
	});
	return {
		root,
		calls,
		printed,
		deps: {
			tmux,
			repoStateRoot: root,
			tuiMarker,
			timing: FAST,
			print(line: string) {
				printed.push(line);
			},
		},
	};
}

const app = {session: 'pappardelle-app', repo: 'app'};

test('only pappardelle sessions of a known repo count as TUIs', () => {
	const {tuiMarker} = tuiStateRoot(['app', 'web']);
	const {tmux} = fakeTuiTmux({
		tuiMarker,
		sessions: [
			'pappardelle-app',
			'pappardelle-decoy',
			'claude-app-STA-1',
			'pappardelle-web',
		],
	});

	expect(listRunningTuis(tmux, ['app', 'web'])).toStrictEqual([
		{session: 'pappardelle-app', repo: 'app'},
		{session: 'pappardelle-web', repo: 'web'},
	]);
});

test('a dotted repo name matches with or without tmux rewriting the dot', () => {
	const {tuiMarker} = tuiStateRoot(['my.repo', 'next.js']);
	const {tmux} = fakeTuiTmux({
		tuiMarker,
		sessions: ['pappardelle-my_repo', 'pappardelle-next.js'],
	});

	expect(listRunningTuis(tmux, ['my.repo', 'next.js'])).toStrictEqual([
		{session: 'pappardelle-my_repo', repo: 'my.repo'},
		{session: 'pappardelle-next.js', repo: 'next.js'},
	]);
});

test('when two repos could own a session, the one named exactly like it does', () => {
	for (const repos of [
		['my.app', 'my_app'],
		['my_app', 'my.app'],
	]) {
		const {tuiMarker} = tuiStateRoot(repos);
		const {tmux} = fakeTuiTmux({
			tuiMarker,
			sessions: ['pappardelle-my_app'],
		});
		// Neither order may change the answer.
		expect(listRunningTuis(tmux, repos)).toStrictEqual([
			{session: 'pappardelle-my_app', repo: 'my_app'},
		]);
	}
});

test("a restart closes the viewers and reruns the command in the TUI's own pane", async () => {
	const h = setup(['pappardelle-web', 'pappardelle-app']);

	expect(await restartAndVerifyTui(app, COMMAND, FAKE_CLI_PATH, h.deps)).toBe(
		true,
	);

	expect(h.calls.filter(args => args[0] !== 'display-message')).toStrictEqual([
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
			'-c',
			'#{session_path}',
			COMMAND,
		],
	]);
	expect(h.printed.at(-1)).toBe(
		`pappardelle-app is running ${FAKE_CLI_PATH} (${FAKE_SHA})`,
	);
	expect(fs.existsSync(restartLockPath(h.root, 'app'))).toBe(false);
});

test("a refused restart reports tmux's own error", async () => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'refused'});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(h.printed.at(-1)).toBe(`Couldn't restart pappardelle-app: ${REFUSAL}`);
	expect(fs.existsSync(restartLockPath(h.root, 'app'))).toBe(false);
});

test('a TUI that comes up on another cli.js fails, naming both', async () => {
	const h = setup(['pappardelle-app'], {
		'pappardelle-app': {cliPath: '/old/dist/cli.js'},
	});

	expect(await restartAndVerifyTui(app, COMMAND, FAKE_CLI_PATH, h.deps)).toBe(
		false,
	);
	expect(h.printed.at(-1)).toBe(
		`pappardelle-app is running /old/dist/cli.js, not ${FAKE_CLI_PATH}`,
	);
});

test('with no expected cli.js, whichever build comes up is reported', async () => {
	const h = setup(['pappardelle-app'], {
		'pappardelle-app': {cliPath: '/old/dist/cli.js'},
	});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(true);
	expect(h.printed.at(-1)!.includes('is running /old/dist/cli.js')).toBe(true);
});

test('a TUI that exits during startup fails without waiting out the timeout', async () => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'exits'});
	h.deps.timing = {...FAST, readyTimeoutMs: 60_000};

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(
		h.printed.at(-1)!.startsWith('pappardelle-app exited during startup'),
	).toBe(true);
});

test('a TUI that never reports ready times out', async () => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'silent'});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(
		h.printed.at(-1)!.startsWith('pappardelle-app did not report ready'),
	).toBe(true);
});

test('a marker left by the previous TUI does not count as ready', async () => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'silent'});
	await h.deps.tuiMarker('app').write({
		pid: 1,
		cliPath: FAKE_CLI_PATH,
		sha: FAKE_SHA,
		paneId: '%0',
		startedAt: Date.now() - 1000,
	});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
});

test("a marker written from another pane does not count as this TUI's", async () => {
	const h = setup(['pappardelle-app'], {'pappardelle-app': 'silent'});
	setTimeout(() => {
		void h.deps.tuiMarker('app').write({
			pid: 1,
			cliPath: FAKE_CLI_PATH,
			sha: FAKE_SHA,
			paneId: '%7',
			startedAt: Date.now(),
		});
	}, 30);

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(
		h.printed.at(-1)!.startsWith('pappardelle-app did not report ready'),
	).toBe(true);
});

test('a TUI whose panes were rearranged is restarted in the pane its marker names', async () => {
	const h = setup(['pappardelle-app'], {}, {'pappardelle-app': '%5'});
	await h.deps.tuiMarker('app').write({
		pid: 1,
		cliPath: FAKE_CLI_PATH,
		sha: FAKE_SHA,
		paneId: '%5',
		startedAt: Date.now() - 1000,
	});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(true);
	expect(
		h.calls.filter(args => args[0] === 'kill-pane').map(args => args[3]),
	).toStrictEqual(['%5']);
});

test('a marker naming a pane that left the window falls back to the first pane', async () => {
	const h = setup(['pappardelle-app']);
	await h.deps.tuiMarker('app').write({
		pid: 1,
		cliPath: FAKE_CLI_PATH,
		sha: FAKE_SHA,
		paneId: '%44',
		startedAt: Date.now() - 1000,
	});

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(true);
	expect(
		h.calls.filter(args => args[0] === 'kill-pane').map(args => args[3]),
	).toStrictEqual(['%0']);
});

test('a state dir the lock cannot be created in fails at once with the reason', async () => {
	const h = setup(['pappardelle-app']);
	fs.rmSync(path.join(h.root, 'app'), {recursive: true});
	fs.writeFileSync(path.join(h.root, 'app'), 'not a directory');
	h.deps.timing = {...FAST, lockTimeoutMs: 60_000};

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(h.printed.at(-1)!).toMatch(
		/^Couldn't restart pappardelle-app: E(EXIST|NOTDIR)/,
	);
	expect(restarted(h.calls, ['pappardelle-app'])).toStrictEqual([]);
});

test('a second restart waits for the first instead of overlapping it', async () => {
	const h = setup(['pappardelle-app']);
	// The release below can run late when the suite is busy.
	h.deps.timing = {...FAST, lockTimeoutMs: 60_000};
	fs.writeFileSync(restartLockPath(h.root, 'app'), `${process.pid}\n`);
	setTimeout(() => {
		expect(restarted(h.calls, ['pappardelle-app'])).toStrictEqual([]);
		fs.unlinkSync(restartLockPath(h.root, 'app'));
	}, 60);

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(true);
	expect(restarted(h.calls, ['pappardelle-app'])).toStrictEqual([
		'pappardelle-app',
	]);
});

test('a restart that stays locked gives up and leaves the TUI alone', async () => {
	const h = setup(['pappardelle-app']);
	fs.writeFileSync(restartLockPath(h.root, 'app'), `${process.pid}\n`);

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(false);
	expect(restarted(h.calls, ['pappardelle-app'])).toStrictEqual([]);
	expect(
		h.printed.at(-1)!.includes(`another restart (pid ${process.pid})`),
	).toBe(true);
});

test('a lock left by a dead process is taken over', async () => {
	const h = setup(['pappardelle-app']);
	// Pids are capped far below this on every supported platform.
	fs.writeFileSync(restartLockPath(h.root, 'app'), '2147483646\n');

	expect(await restartAndVerifyTui(app, COMMAND, null, h.deps)).toBe(true);
});

test('several TUIs restart one at a time, the current session last', async () => {
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

	expect(failed).toStrictEqual(['pappardelle-web']);
	expect(restarted(h.calls, sessions)).toStrictEqual([
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
		gonePane?: string;
		splitPanes?: string[];
	} = {},
) {
	const h = setup(['pappardelle-app'], options.behavior, {
		'pappardelle-app': '%3',
	});
	// Key waits and session kills, in the order they happened.
	const events: string[] = [];
	const layoutCalls: string[][] = [];
	return {
		...h,
		events,
		layoutCalls,
		deps: {
			...h.deps,
			layoutTmux(args: readonly string[]) {
				layoutCalls.push([...args]);
				return {
					status: args.includes(options.gonePane ?? '') ? 1 : 0,
					stdout: '',
				};
			},
			splitPanes: () => options.splitPanes ?? [],
			currentSession: () =>
				options.current === undefined ? 'pappardelle-app' : options.current,
			killSession(name: string) {
				events.push(`kill ${name}`);
			},
			waitForKey() {
				events.push('wait for key');
			},
			sleep() {},
		},
	};
}

// Left set, the window's options keep the sous-chef key acting in the shell
// the user is returned to.
const SOUS_CHEF_CLEARED = [
	'set-option',
	'-w',
	'-u',
	'-t',
	'%3',
	'@pappardelle-sous-chef-key',
	';',
	'set-option',
	'-w',
	'-u',
	'-t',
	'%3',
	'@pappardelle-sous-chef',
];

const layout = {
	listPaneId: '%3',
	agentViewerPaneId: '%4',
	companionViewerPaneId: '%5',
};

const own = {
	repoName: 'app',
	paneId: '%3',
	command: COMMAND,
	paneLayout: layout,
};

test('U reruns its own pane and leaves the lock for the next restart to clear', () => {
	const h = ownHarness();

	restartOwnTui(own, h.deps);

	expect(h.calls).toStrictEqual([
		[
			'kill-pane',
			'-a',
			'-t',
			'%3',
			';',
			'respawn-pane',
			'-k',
			'-t',
			'%3',
			'-c',
			'#{session_path}',
			COMMAND,
		],
	]);
	expect(h.events).toStrictEqual([]);
	expect(fs.existsSync(restartLockPath(h.root, 'app'))).toBe(true);
});

test('U shows why tmux refused, waits for a key, then closes the TUI-less session', () => {
	const h = ownHarness({behavior: {'pappardelle-app': 'refused'}});

	restartOwnTui(own, h.deps);

	expect(h.printed.at(-1)!.startsWith(`Couldn't restart: ${REFUSAL}.`)).toBe(
		true,
	);
	expect(h.events).toStrictEqual(['wait for key', 'kill pappardelle-app']);
	expect(fs.existsSync(restartLockPath(h.root, 'app'))).toBe(false);
});

test('U that cannot create its lock reports that and restarts nothing', () => {
	const h = ownHarness();
	fs.rmSync(path.join(h.root, 'app'), {recursive: true});
	fs.writeFileSync(path.join(h.root, 'app'), 'not a directory');

	restartOwnTui(own, h.deps);

	expect(h.printed.at(-1)!).toMatch(/^Couldn't restart: E(EXIST|NOTDIR)/);
	expect(h.calls).toStrictEqual([]);
	expect(h.events).toStrictEqual(['wait for key', 'kill pappardelle-app']);
});

test("U inside the user's own tmux session closes only the viewer panes and restarts nothing", () => {
	const h = ownHarness({current: 'work'});

	restartOwnTui(own, h.deps);

	expect(h.events).toStrictEqual([]);
	expect(h.calls).toStrictEqual([]);
	expect(h.layoutCalls).toStrictEqual([
		['kill-pane', '-t', '%4'],
		['kill-pane', '-t', '%5'],
		SOUS_CHEF_CLEARED,
	]);
});

test('U without a pane layout leaves tmux alone', () => {
	const h = ownHarness({current: null});

	restartOwnTui({...own, paneLayout: null}, h.deps);

	expect(h.events).toStrictEqual([]);
	expect(h.calls).toStrictEqual([]);
	expect(h.layoutCalls).toStrictEqual([]);
});

// ============================================================================
// Quitting (q)
// ============================================================================

test('q in its own session closes the whole session', () => {
	const h = ownHarness();

	closeTuiLayout('app', layout, h.deps);

	expect(h.events).toStrictEqual(['kill pappardelle-app']);
	expect(h.layoutCalls).toStrictEqual([]);
});

// Left behind, the viewers make the rail pane narrow enough that the next
// pappardelle run in it splits the rail into a second layout.
test("q inside the user's own tmux session closes only the viewer panes", () => {
	const h = ownHarness({current: 'work'});

	closeTuiLayout('app', layout, h.deps);

	expect(h.events).toStrictEqual([]);
	expect(h.layoutCalls).toStrictEqual([
		['kill-pane', '-t', '%4'],
		['kill-pane', '-t', '%5'],
		SOUS_CHEF_CLEARED,
	]);
});

test("q inside the user's own tmux session also closes the companion split panes", () => {
	const h = ownHarness({current: 'work', splitPanes: ['%8', '%9']});

	closeTuiLayout('app', layout, h.deps);

	expect(h.layoutCalls).toStrictEqual([
		['kill-pane', '-t', '%4'],
		['kill-pane', '-t', '%5'],
		['kill-pane', '-t', '%8'],
		['kill-pane', '-t', '%9'],
		SOUS_CHEF_CLEARED,
	]);
});

test('q still closes the companion viewer when the agent viewer was closed by hand', () => {
	const h = ownHarness({current: 'work', gonePane: '%4'});

	closeTuiLayout('app', layout, h.deps);

	expect(h.layoutCalls.at(-2)).toStrictEqual(['kill-pane', '-t', '%5']);
});

test('q in a vertical layout closes its one viewer pane', () => {
	const h = ownHarness({current: 'work'});

	closeTuiLayout('app', {...layout, companionViewerPaneId: ''}, h.deps);

	expect(h.layoutCalls).toStrictEqual([
		['kill-pane', '-t', '%4'],
		SOUS_CHEF_CLEARED,
	]);
});

// ============================================================================
// Launch commands
// ============================================================================

test('after an install, restarts go through the shim when there is one', () => {
	const options = {
		execPath: '/bun',
		cliPath: '/work/pappardelle/source/cli.tsx',
		home: '/home/me',
	};

	expect(installedLaunchCommand({...options, exists: () => true})).toBe(
		"'/home/me/.local/bin/pappardelle'",
	);
	expect(installedLaunchCommand({...options, exists: () => false})).toBe(
		"'/bun' '--no-env-file' '--config=/dev/null' '/work/pappardelle/source/cli.tsx'",
	);
});

test('a source run keeps its own Bun and entry file', () => {
	expect(
		tuiLaunchCommand({
			execPath: '/old/bun',
			cliPath: '/work/pappardelle/source/cli.tsx',
			args: ['--foo'],
			home: '/home/me',
			exists: () => true,
		}),
	).toBe(
		"'/old/bun' '--no-env-file' '--config=/dev/null' '/work/pappardelle/source/cli.tsx' --foo",
	);
});

test('the release runs its executable itself when the shim is missing', () => {
	const release = '/home/me/.pappardelle/repo/dist/pappardelle';
	expect(
		tuiLaunchCommand({
			execPath: release,
			cliPath: release,
			args: [],
			home: '/home/me',
			exists: () => false,
		}),
	).toBe(`'${release}'`);
});

test('a standalone restart invokes the executable once and installed releases use the shim', () => {
	const binary = '/work/pappardelle/dist/pappardelle';
	expect(
		tuiLaunchCommand({
			execPath: binary,
			cliPath: binary,
			args: ['--no-layout'],
			home: '/home/me',
			exists: () => false,
		}),
	).toBe("'/work/pappardelle/dist/pappardelle' --no-layout");
	const installed = '/home/me/.pappardelle/repo/dist/pappardelle';
	expect(
		tuiLaunchCommand({
			execPath: installed,
			cliPath: installed,
			args: [],
			home: '/home/me',
			exists: () => true,
		}),
	).toBe("'/home/me/.local/bin/pappardelle'");
});

// ============================================================================
// A signal after the pane was respawned (pappardelle restart)
// ============================================================================

tmuxTest(
	'a pane counts as respawned only while another process runs in it',
	() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-respawn-'));
		const tmux = (args: readonly string[]) => {
			const result = spawnSync(
				'tmux',
				['-S', path.join(dir, 'outer'), '-f', '/dev/null', ...args],
				{encoding: 'utf8', env: {...process.env, TMUX: ''}, timeout: 5000},
			);
			return {
				error: result.error,
				status: result.status,
				stdout: result.stdout ?? '',
			};
		};

		teardown(() => {
			tmux(['kill-server']);
			fs.rmSync(dir, {recursive: true, force: true});
		});
		tmux(['new-session', '-d', '-s', 'fixture', 'sleep 60']);
		const read = (format: string) =>
			tmux(['display-message', '-p', '-t', '=fixture:', format]).stdout.trim();
		const paneId = read('#{pane_id}');
		const startedPid = read('#{pane_pid}');

		expect(paneRespawned(paneId, startedPid, tmux)).toBe(false);

		tmux(['respawn-pane', '-k', '-t', paneId, 'sleep 60']);
		expect(paneRespawned(paneId, startedPid, tmux)).toBe(true);

		tmux(['kill-session', '-t', '=fixture']);
		expect(paneRespawned(paneId, startedPid, tmux)).toBe(false);
	},
);
