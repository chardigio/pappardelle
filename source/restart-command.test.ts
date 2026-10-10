import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	hardRestart,
	restartRepo,
	type RestartCommandDeps,
} from './restart-command.ts';
import {
	FAKE_CLI_PATH,
	FAKE_SHA,
	FAST,
	type FakeTuiBehavior,
	REFUSAL,
	fakeTuiTmux,
} from '../test/helpers/fake-tui-tmux.ts';
import type {OuterTmuxRunner} from './tmux.ts';

let counter = 0;

type Harness = {
	deps: RestartCommandDeps;
	// Outer and inner tmux calls in the order they happened, tagged by server.
	calls: string[];
	detached: string[][][];
	attached: string[];
	printed: string[];
	confirmCalls: string[];
};

function harness(
	options: {
		sessions?: string[];
		behavior?: Record<string, FakeTuiBehavior>;
		repos?: string[];
		innerSessions?: string[] | null;
		currentSession?: string | null;
		onInnerServer?: boolean;
		inTmux?: boolean;
		isTTY?: boolean;
		confirmAnswer?: boolean;
	} = {},
): Harness {
	const repoStateRoot = path.join(
		os.tmpdir(),
		`restart-command-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(repoStateRoot, {recursive: true});
	for (const repo of options.repos ?? []) {
		fs.mkdirSync(path.join(repoStateRoot, repo));
	}

	const h: Harness = {
		calls: [],
		detached: [],
		attached: [],
		printed: [],
		confirmCalls: [],
		deps: undefined as unknown as RestartCommandDeps,
	};
	const outer = fakeTuiTmux({
		repoStateRoot,
		sessions: options.sessions,
		behavior: options.behavior,
	});
	const tmux: OuterTmuxRunner = args => {
		h.calls.push(`outer ${args.join(' ')}`);
		return outer.tmux(args);
	};

	const innerTmux: OuterTmuxRunner = args => {
		h.calls.push(`inner ${args.join(' ')}`);
		if (args[0] === 'list-sessions') {
			return options.innerSessions === null
				? {status: 1, stdout: ''}
				: {
						status: 0,
						stdout: (options.innerSessions ?? []).join('\n') + '\n',
					};
		}

		return {status: options.innerSessions === null ? 1 : 0, stdout: ''};
	};

	h.deps = {
		tmux,
		innerTmux,
		repoStateRoot,
		launchCommand: COMMAND,
		cliPath: FAKE_CLI_PATH,
		timing: FAST,
		currentSession: () => options.currentSession ?? null,
		onInnerServer: options.onInnerServer ?? false,
		inTmux: options.inTmux ?? true,
		attach(sessionName) {
			h.attached.push(sessionName);
			return 0;
		},
		runDetached(steps) {
			h.detached.push(steps);
		},
		isTTY: options.isTTY ?? false,
		async confirm(question) {
			h.confirmCalls.push(question);
			return options.confirmAnswer ?? false;
		},
		print(line) {
			h.printed.push(line);
		},
	};
	return h;
}

const COMMAND = "'/node' '/build/dist/cli.js'";

const restartOf = (pane: string) =>
	`outer kill-pane -a -t ${pane} ; respawn-pane -k -t ${pane} ${COMMAND}`;

// Calls that change a tmux server, as opposed to reading from one.
function mutations(h: Harness): string[] {
	return h.calls.filter(call => !/ (list-|display-message)/.test(call));
}

// ============================================================================
// restart
// ============================================================================

test("restart reruns only this repo's TUI, on the build that ran the command", async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
	});

	t.is(await restartRepo('app', h.deps), 0);
	t.deepEqual(mutations(h), [restartOf('%0')]);
	t.deepEqual(h.attached, []);
	t.is(
		h.printed.at(-1),
		`pappardelle-app is running ${FAKE_CLI_PATH} (${FAKE_SHA})`,
	);
});

test('restart never talks to the inner server', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		onInnerServer: true,
	});

	t.is(await restartRepo('app', h.deps), 0);
	t.deepEqual(
		h.calls.filter(call => call.startsWith('inner')),
		[],
	);
	t.deepEqual(h.detached, []);
});

test('restart from a plain terminal attaches to the restarted TUI', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		inTmux: false,
	});

	await restartRepo('app', h.deps);

	t.deepEqual(h.attached, ['pappardelle-app']);
});

test('restart with no TUI running launches nothing', async t => {
	const h = harness({
		sessions: ['pappardelle-web'],
		repos: ['app', 'web'],
		inTmux: false,
	});

	t.is(await restartRepo('app', h.deps), 0);
	t.deepEqual(mutations(h), []);
	t.deepEqual(h.attached, []);
	t.true(h.printed.at(-1)!.startsWith('No running Pappardelle TUI for app'));
});

for (const [name, behavior, message] of [
	['tmux refuses', 'refused', `Couldn't restart pappardelle-app: ${REFUSAL}`],
	[
		'the TUI comes up on another build',
		{cliPath: '/old/dist/cli.js'},
		`pappardelle-app is running /old/dist/cli.js, not ${FAKE_CLI_PATH}`,
	],
	[
		'the TUI exits during startup',
		'exits',
		'pappardelle-app exited during startup; see ~/.pappardelle/logs',
	],
	[
		'the TUI never reports ready',
		'silent',
		'pappardelle-app did not report ready within 0s',
	],
] as const) {
	test(`restart fails and says why when ${name}`, async t => {
		const h = harness({
			sessions: ['pappardelle-app'],
			repos: ['app'],
			behavior: {'pappardelle-app': behavior},
			inTmux: false,
		});

		t.is(await restartRepo('app', h.deps), 1);
		t.is(h.printed.at(-1), message);
		t.deepEqual(h.attached, []);
	});
}

// ============================================================================
// restart --hard
// ============================================================================

test('--hard --yes kills the inner server before restarting every TUI', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		innerSessions: ['claude-app-STA-1'],
		currentSession: 'pappardelle-app',
	});

	t.is(await hardRestart(true, h.deps), 0);
	t.deepEqual(mutations(h), [
		'inner kill-server',
		restartOf('%1'),
		restartOf('%0'),
	]);
});

test('--hard fails when a TUI is not confirmed running afterwards', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		behavior: {'pappardelle-web': 'silent'},
	});

	t.is(await hardRestart(true, h.deps), 1);
	t.true(h.printed.some(line => line.startsWith('pappardelle-app is running')));
});

test('--hard asks on a TTY and does nothing when declined', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: ['claude-app-STA-1', 'companion-app-STA-1'],
		isTTY: true,
		confirmAnswer: false,
	});

	t.is(await hardRestart(false, h.deps), 0);
	t.true(h.confirmCalls[0]!.startsWith('End 2 Claude/companion sessions'));
	t.true(h.confirmCalls[0]!.includes('pappardelle-app'));
	t.deepEqual(mutations(h), []);
});

test('--hard with no TUIs running only mentions the Claude sessions', async t => {
	const h = harness({innerSessions: ['claude-app-STA-1'], isTTY: true});

	await hardRestart(false, h.deps);

	t.is(
		h.confirmCalls[0],
		'End 1 Claude/companion session (they resume with --continue)? [y/N] ',
	);
});

test('--hard without a TTY or --yes refuses', async t => {
	const h = harness({sessions: ['pappardelle-app'], repos: ['app']});

	t.is(await hardRestart(false, h.deps), 1);
	t.deepEqual(h.confirmCalls, []);
	t.deepEqual(mutations(h), []);
});

test('--hard from a claude pane hands the kill and restarts to a detached child, kill first', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		onInnerServer: true,
	});

	t.is(await hardRestart(true, h.deps), 0);
	t.deepEqual(mutations(h), []);
	const restart = (pane: string) => [
		'kill-pane',
		'-a',
		'-t',
		pane,
		';',
		'respawn-pane',
		'-k',
		'-t',
		pane,
		COMMAND,
	];
	t.deepEqual(h.detached, [
		[['-L', 'pappardelle_inner', 'kill-server'], restart('%0'), restart('%1')],
	]);
});

test('--hard with no inner server still restarts the TUIs', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: null,
	});

	t.is(await hardRestart(true, h.deps), 0);
	t.true(mutations(h).includes(restartOf('%0')));
});
