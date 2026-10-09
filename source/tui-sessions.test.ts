import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {OuterTmuxRunner} from './tmux.ts';
import {listRunningTuis, respawnTuis} from './tui-sessions.ts';

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

function fakeTmux(
	sessions: string[],
	refuse: string[] = [],
): {tmux: OuterTmuxRunner; calls: string[][]} {
	const calls: string[][] = [];
	const tmux: OuterTmuxRunner = args => {
		calls.push([...args]);
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		}

		const refused = refuse.some(name => args.at(-1) === `=${name}:^`);
		return {status: refused ? 1 : 0, stdout: ''};
	};

	return {tmux, calls};
}

test('only pappardelle sessions with a repo state dir count as TUIs', t => {
	const {tmux} = fakeTmux([
		'pappardelle-app',
		'pappardelle-decoy',
		'claude-app-STA-1',
		'pappardelle-web',
	]);

	t.deepEqual(listRunningTuis(tmux, repoStateRoot(['app', 'web'])), [
		'pappardelle-app',
		'pappardelle-web',
	]);
});

test('a dotted repo name matches with or without tmux rewriting the dot', t => {
	const {tmux} = fakeTmux(['pappardelle-my_repo', 'pappardelle-next.js']);

	t.deepEqual(listRunningTuis(tmux, repoStateRoot(['my.repo', 'next.js'])), [
		'pappardelle-my_repo',
		'pappardelle-next.js',
	]);
});

test('respawns target the exact session and its first window, current session last', t => {
	const {tmux, calls} = fakeTmux([]);
	const printed: string[] = [];

	const failed = respawnTuis(
		['pappardelle-app', 'pappardelle-web', 'pappardelle-api'],
		{
			tmux,
			currentSession: () => 'pappardelle-app',
			print(line) {
				printed.push(line);
			},
		},
	);

	t.deepEqual(failed, []);
	t.deepEqual(calls, [
		['respawn-window', '-k', '-t', '=pappardelle-web:^'],
		['respawn-window', '-k', '-t', '=pappardelle-api:^'],
		['respawn-window', '-k', '-t', '=pappardelle-app:^'],
	]);
});

test('a session tmux refuses to respawn is reported and returned', t => {
	const {tmux} = fakeTmux([], ['pappardelle-web']);
	const printed: string[] = [];

	const failed = respawnTuis(['pappardelle-app', 'pappardelle-web'], {
		tmux,
		currentSession: () => null,
		print(line) {
			printed.push(line);
		},
	});

	t.deepEqual(failed, ['pappardelle-web']);
	t.true(printed.at(-1)!.startsWith("Couldn't restart pappardelle-web"));
});
