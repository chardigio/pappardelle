import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {runRestartCommand, type RestartCommandDeps} from './restart-command.ts';
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
	const tmux: OuterTmuxRunner = args => {
		h.calls.push(`outer ${args.join(' ')}`);
		return args[0] === 'list-sessions'
			? {status: 0, stdout: (options.sessions ?? []).join('\n') + '\n'}
			: {status: 0, stdout: ''};
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

function mutations(h: Harness): string[] {
	return h.calls.filter(call => !call.includes('list-sessions'));
}

// ============================================================================
// restart
// ============================================================================

test("restart respawns only this repo's TUI window", async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
	});

	t.is(await runRestartCommand({repoName: 'app'}, h.deps), 0);
	t.deepEqual(mutations(h), ['outer respawn-window -k -t =pappardelle-app:^']);
	t.deepEqual(h.attached, []);
});

test('restart from a plain terminal attaches to the respawned TUI', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		inTmux: false,
	});

	await runRestartCommand({repoName: 'app'}, h.deps);

	t.deepEqual(h.attached, ['pappardelle-app']);
});

test('restart with no TUI running launches nothing', async t => {
	const h = harness({
		sessions: ['pappardelle-web'],
		repos: ['app', 'web'],
		inTmux: false,
	});

	t.is(await runRestartCommand({repoName: 'app'}, h.deps), 0);
	t.deepEqual(mutations(h), []);
	t.deepEqual(h.attached, []);
	t.true(h.printed.at(-1)!.startsWith('No running Pappardelle TUI for app'));
});

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

	t.is(
		await runRestartCommand({hard: true, yes: true, repoName: null}, h.deps),
		0,
	);
	t.deepEqual(mutations(h), [
		'inner kill-server',
		'outer respawn-window -k -t =pappardelle-web:^',
		'outer respawn-window -k -t =pappardelle-app:^',
	]);
});

test('--hard asks on a TTY and does nothing when declined', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: ['claude-app-STA-1', 'companion-app-STA-1'],
		isTTY: true,
		confirmAnswer: false,
	});

	t.is(await runRestartCommand({hard: true, repoName: null}, h.deps), 0);
	t.true(h.confirmCalls[0]!.startsWith('End 2 Claude/companion sessions'));
	t.true(h.confirmCalls[0]!.includes('pappardelle-app'));
	t.deepEqual(mutations(h), []);
});

test('--hard without a TTY or --yes refuses', async t => {
	const h = harness({sessions: ['pappardelle-app'], repos: ['app']});

	t.is(await runRestartCommand({hard: true, repoName: null}, h.deps), 1);
	t.deepEqual(h.confirmCalls, []);
	t.deepEqual(mutations(h), []);
});

test('--hard from a claude pane hands the kill and respawns to a detached child, kill first', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		onInnerServer: true,
	});

	t.is(
		await runRestartCommand({hard: true, yes: true, repoName: null}, h.deps),
		0,
	);
	t.deepEqual(mutations(h), []);
	t.deepEqual(h.detached, [
		[
			['-L', 'pappardelle_inner', 'kill-server'],
			['respawn-window', '-k', '-t', '=pappardelle-app:^'],
			['respawn-window', '-k', '-t', '=pappardelle-web:^'],
		],
	]);
});

test('--hard with no inner server still restarts the TUIs', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		innerSessions: null,
	});

	t.is(
		await runRestartCommand({hard: true, yes: true, repoName: null}, h.deps),
		0,
	);
	t.true(
		mutations(h).includes('outer respawn-window -k -t =pappardelle-app:^'),
	);
});
