import {test, expect} from 'bun:test';
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
	tuiStateRoot,
} from '../test/helpers/fake-tui-tmux.ts';
import type {OuterTmuxRunner} from './tmux.ts';

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
	const {repoStateRoot, tuiMarker} = tuiStateRoot(options.repos ?? []);

	const h: Harness = {
		calls: [],
		detached: [],
		attached: [],
		printed: [],
		confirmCalls: [],
		deps: undefined as unknown as RestartCommandDeps,
	};
	const outer = fakeTuiTmux({
		tuiMarker,
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
		tuiMarker,
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
	`outer kill-pane -a -t ${pane} ; respawn-pane -k -t ${pane} -c #{session_path} ${COMMAND}`;

// Calls that change a tmux server, as opposed to reading from one.
function mutations(h: Harness): string[] {
	return h.calls.filter(call => !/ (list-|display-message)/.test(call));
}

// ============================================================================
// restart
// ============================================================================

test("restart reruns only this repo's TUI, on the build that ran the command", async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
	});

	expect(await restartRepo('app', h.deps)).toBe(0);
	expect(mutations(h)).toStrictEqual([restartOf('%0')]);
	expect(h.attached).toStrictEqual([]);
	expect(h.printed.at(-1)).toBe(
		`pappardelle-app is running ${FAKE_CLI_PATH} (${FAKE_SHA})`,
	);
});

test('restart never talks to the inner server', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		onInnerServer: true,
	});

	expect(await restartRepo('app', h.deps)).toBe(0);
	expect(h.calls.filter(call => call.startsWith('inner'))).toStrictEqual([]);
	expect(h.detached).toStrictEqual([]);
});

test('restart from a plain terminal attaches to the restarted TUI', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		inTmux: false,
		isTTY: true,
	});

	await restartRepo('app', h.deps);

	expect(h.attached).toStrictEqual(['pappardelle-app']);
});

test('restart without a terminal confirms the TUI and skips attaching', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		inTmux: false,
		isTTY: false,
	});

	expect(await restartRepo('app', h.deps)).toBe(0);
	expect(h.attached).toStrictEqual([]);
});

test('restart with no TUI running launches nothing', async () => {
	const h = harness({
		sessions: ['pappardelle-web'],
		repos: ['app', 'web'],
		inTmux: false,
	});

	expect(await restartRepo('app', h.deps)).toBe(0);
	expect(mutations(h)).toStrictEqual([]);
	expect(h.attached).toStrictEqual([]);
	expect(
		h.printed.at(-1)!.startsWith('No running Pappardelle TUI for app'),
	).toBe(true);
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
	test(`restart fails and says why when ${name}`, async () => {
		const h = harness({
			sessions: ['pappardelle-app'],
			repos: ['app'],
			behavior: {'pappardelle-app': behavior},
			inTmux: false,
		});

		expect(await restartRepo('app', h.deps)).toBe(1);
		expect(h.printed.at(-1)).toBe(message);
		expect(h.attached).toStrictEqual([]);
	});
}

// ============================================================================
// restart --hard
// ============================================================================

test('--hard --yes kills the inner server before restarting every TUI', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		innerSessions: ['claude-app-STA-1'],
		currentSession: 'pappardelle-app',
	});

	expect(await hardRestart(true, h.deps)).toBe(0);
	expect(mutations(h)).toStrictEqual([
		'inner kill-server',
		restartOf('%1'),
		restartOf('%0'),
	]);
});

test('--hard fails when a TUI is not confirmed running afterwards', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		behavior: {'pappardelle-web': 'silent'},
	});

	expect(await hardRestart(true, h.deps)).toBe(1);
	expect(
		h.printed.some(line => line.startsWith('pappardelle-app is running')),
	).toBe(true);
});

test('--hard asks on a TTY and does nothing when declined', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: ['claude-app-STA-1', 'companion-app-STA-1'],
		isTTY: true,
		confirmAnswer: false,
	});

	expect(await hardRestart(false, h.deps)).toBe(0);
	expect(h.confirmCalls[0]!.startsWith('End 2 agent/companion sessions')).toBe(
		true,
	);
	expect(h.confirmCalls[0]!.includes('pappardelle-app')).toBe(true);
	expect(mutations(h)).toStrictEqual([]);
});

test('--hard with no TUIs running only mentions the agent sessions', async () => {
	const h = harness({innerSessions: ['claude-app-STA-1'], isTTY: true});

	await hardRestart(false, h.deps);

	expect(h.confirmCalls[0]).toBe(
		'End 1 agent/companion session (agents resume their conversations)? [y/N] ',
	);
});

test('--hard without a TTY or --yes refuses', async () => {
	const h = harness({sessions: ['pappardelle-app'], repos: ['app']});

	expect(await hardRestart(false, h.deps)).toBe(1);
	expect(h.confirmCalls).toStrictEqual([]);
	expect(mutations(h)).toStrictEqual([]);
});

test('--hard from a claude pane hands the kill and restarts to a detached child, kill first', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		onInnerServer: true,
	});

	expect(await hardRestart(true, h.deps)).toBe(0);
	expect(mutations(h)).toStrictEqual([]);
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
		'-c',
		'#{session_path}',
		COMMAND,
	];
	expect(h.detached).toStrictEqual([
		[['-L', 'pappardelle_inner', 'kill-server'], restart('%0'), restart('%1')],
	]);
});

test('--hard with no inner server still restarts the TUIs', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: null,
	});

	expect(await hardRestart(true, h.deps)).toBe(0);
	expect(mutations(h).includes(restartOf('%0'))).toBe(true);
});
