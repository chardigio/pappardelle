import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {
	FAST,
	type FakeTuiBehavior,
	REFUSAL,
	fakeTuiTmux,
	tuiStateRoot,
	restarted,
} from '../test/helpers/fake-tui-tmux.ts';
import {runUpdateCommand, type UpdateCommandDeps} from './update-command.ts';

type Harness = {
	deps: UpdateCommandDeps;
	sessions: string[];
	tmuxCalls: string[][];
	printed: string[];
	confirmCalls: string[];
};

function harness(
	options: {
		installerStatus?: number;
		sessions?: string[];
		listFails?: boolean;
		behavior?: Record<string, FakeTuiBehavior>;
		repos?: string[];
		currentSession?: string | null;
		isTTY?: boolean;
		confirmAnswer?: boolean;
	} = {},
): Harness {
	const {repoStateRoot, tuiMarker} = tuiStateRoot(options.repos ?? []);

	const printed: string[] = [];
	const confirmCalls: string[] = [];
	const {tmux, calls: tmuxCalls} = fakeTuiTmux({
		tuiMarker,
		sessions: options.sessions,
		listFails: options.listFails,
		behavior: options.behavior,
	});

	return {
		sessions: options.sessions ?? [],
		tmuxCalls,
		printed,
		confirmCalls,
		deps: {
			installedVersion: 'v1.2.3',
			runInstaller: () => options.installerStatus ?? 0,
			tmux,
			repoStateRoot,
			tuiMarker,
			launchCommand: () => SHIM,
			timing: FAST,
			currentSession: () => options.currentSession ?? null,
			isTTY: options.isTTY ?? false,
			async confirm(question) {
				confirmCalls.push(question);
				return options.confirmAnswer ?? false;
			},
			print(line) {
				printed.push(line);
			},
		},
	};
}

const SHIM = "'/home/me/.local/bin/pappardelle'";

function restartedTuis(h: Harness): string[] {
	return restarted(h.tmuxCalls, h.sessions);
}

test('a failed install returns its status and leaves tmux alone', async () => {
	const h = harness({
		installerStatus: 3,
		sessions: ['pappardelle-app'],
		repos: ['app'],
	});

	expect(await runUpdateCommand({restartTuis: true}, h.deps)).toBe(3);
	expect(h.tmuxCalls).toStrictEqual([]);
});

test('only pappardelle sessions with a repo state dir count as running TUIs', async () => {
	const h = harness({
		sessions: [
			'pappardelle-app',
			'pappardelle-decoy',
			'claude-app-STA-1',
			'pappardelle-web',
		],
		repos: ['app', 'web'],
	});

	await runUpdateCommand({restartTuis: true}, h.deps);

	expect(restartedTuis(h)).toStrictEqual([
		'pappardelle-app',
		'pappardelle-web',
	]);
});

test('--restart-tuis restarts the session running the command last', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web', 'pappardelle-api'],
		repos: ['app', 'web', 'api'],
		currentSession: 'pappardelle-app',
	});

	expect(await runUpdateCommand({restartTuis: true}, h.deps)).toBe(0);
	expect(restartedTuis(h)).toStrictEqual([
		'pappardelle-web',
		'pappardelle-api',
		'pappardelle-app',
	]);
});

test('--no-restart-tuis leaves TUIs running and names them in a restart hint', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		isTTY: true,
	});

	expect(await runUpdateCommand({restartTuis: false}, h.deps)).toBe(0);
	expect(restartedTuis(h)).toStrictEqual([]);
	expect(h.confirmCalls).toStrictEqual([]);
	const hint = h.printed.at(-1)!;
	expect(hint.includes('pappardelle-app')).toBe(true);
	expect(hint.includes('pappardelle-web')).toBe(true);
});

test('on a TTY with no flag, a yes to the prompt restarts the TUIs', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		isTTY: true,
		confirmAnswer: true,
	});

	await runUpdateCommand({}, h.deps);

	expect(h.confirmCalls.length).toBe(1);
	expect(
		h.confirmCalls[0]!.startsWith('Restart 2 running Pappardelle TUIs'),
	).toBe(true);
	expect(restartedTuis(h)).toStrictEqual([
		'pappardelle-app',
		'pappardelle-web',
	]);
});

test('on a TTY with no flag, a no to the prompt prints the hint instead', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		isTTY: true,
		confirmAnswer: false,
	});

	await runUpdateCommand({}, h.deps);

	expect(h.confirmCalls.length).toBe(1);
	expect(restartedTuis(h)).toStrictEqual([]);
	expect(h.printed.at(-1)!.includes('pappardelle-app')).toBe(true);
});

test('without a TTY or a flag, it never prompts and prints the hint', async () => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		isTTY: false,
	});

	await runUpdateCommand({}, h.deps);

	expect(h.confirmCalls).toStrictEqual([]);
	expect(restartedTuis(h)).toStrictEqual([]);
	expect(h.printed.at(-1)!.includes('pappardelle-app')).toBe(true);
});

test('no running TUIs means no prompt and no hint', async () => {
	const h = harness({sessions: ['claude-app-STA-1'], isTTY: true});

	expect(await runUpdateCommand({}, h.deps)).toBe(0);
	expect(h.confirmCalls).toStrictEqual([]);
	expect(h.printed.some(line => line.includes('old build'))).toBe(false);
});

test('a tmux server that is not running is treated as no TUIs', async () => {
	const h = harness({listFails: true, repos: ['app']});

	expect(await runUpdateCommand({restartTuis: true}, h.deps)).toBe(0);
	expect(restartedTuis(h)).toStrictEqual([]);
});

test('the opening line names the version being replaced when known', async () => {
	const h = harness();
	await runUpdateCommand({}, h.deps);
	expect(h.printed[0]!.includes('v1.2.3')).toBe(true);

	const unknown = harness();
	unknown.deps.installedVersion = null;
	await runUpdateCommand({}, unknown.deps);
	expect(unknown.printed[0]!.includes('currently on')).toBe(false);
});

test('--restart-tuis reruns each TUI through the shim and reports its build', async () => {
	const h = harness({sessions: ['pappardelle-app'], repos: ['app']});

	expect(await runUpdateCommand({restartTuis: true}, h.deps)).toBe(0);
	expect(h.tmuxCalls.find(args => args[0] === 'kill-pane')!.at(-1)).toBe(SHIM);
	expect(h.printed.at(-1)!.startsWith('pappardelle-app is running ')).toBe(
		true,
	);
});

test('a TUI that fails to restart or report ready fails the update and is named', async () => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web', 'pappardelle-api'],
		repos: ['app', 'web', 'api'],
		behavior: {'pappardelle-app': 'refused', 'pappardelle-api': 'silent'},
	});

	expect(await runUpdateCommand({restartTuis: true}, h.deps)).toBe(1);
	expect(
		h.printed.includes(`Couldn't restart pappardelle-app: ${REFUSAL}`),
	).toBe(true);
	expect(
		h.printed.some(line => line.startsWith('pappardelle-web is running')),
	).toBe(true);
	const summary = h.printed.at(-1)!;
	expect(
		summary.includes('pappardelle-app, pappardelle-api are not confirmed'),
	).toBe(true);
	expect(summary.includes('pappardelle-web')).toBe(false);
});

test('the restart command is chosen after the install, which is what creates the shim', async () => {
	const h = harness({sessions: ['pappardelle-app'], repos: ['app']});
	let installed = false;
	h.deps.runInstaller = () => {
		installed = true;
		return 0;
	};
	h.deps.launchCommand = () => (installed ? SHIM : "'/old/node' '/old/cli.js'");

	await runUpdateCommand({restartTuis: true}, h.deps);

	expect(h.tmuxCalls.find(args => args[0] === 'kill-pane')!.at(-1)).toBe(SHIM);
});
