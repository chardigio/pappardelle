import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stateDaosByRepo} from '../../source/state-daos.ts';
import {closeStateDb, stateDbPath} from '../../source/state-db.ts';
import type {OuterTmuxRunner} from '../../source/tmux.ts';
import type {TuiMarkerDao} from '../../source/tui-marker.ts';
import {sqliteRun} from './state.ts';

const stateDirs: string[] = [];
process.once('exit', () => {
	for (const stateDir of stateDirs) {
		closeStateDb(stateDbPath(stateDir));
		fs.rmSync(stateDir, {recursive: true, force: true});
	}
});

/**
 * A repo state root with a directory for each of `repos`, and each repo's
 * marker store in the run's mode.
 */
export function tuiStateRoot(repos: string[]): {
	repoStateRoot: string;
	tuiMarker: (repo: string) => TuiMarkerDao;
} {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-tui-state-'));
	stateDirs.push(stateDir);
	const repoStateRoot = path.join(stateDir, 'repos');
	for (const repo of repos)
		fs.mkdirSync(path.join(repoStateRoot, repo), {recursive: true});
	fs.mkdirSync(repoStateRoot, {recursive: true});
	const daosFor = stateDaosByRepo({stateDir, sqlite: sqliteRun});
	return {repoStateRoot, tuiMarker: repo => daosFor(repo).tuiMarker};
}

// What a TUI does when its pane is restarted: come up and write its ready
// marker, come up on some other cli.js, never report, exit during startup, or
// have tmux refuse the restart outright.
export type FakeTuiBehavior =
	| 'ready'
	| {cliPath: string}
	| 'silent'
	| 'exits'
	| 'refused';

export const FAKE_CLI_PATH = '/build/dist/cli.js';
export const FAKE_SHA = 'abc1234';
export const REFUSAL = "can't find pane: %9";

const repoOf = (session: string) => session.replace(/^pappardelle-/, '');

// A default tmux server holding `sessions`. Each window lists pane %<index>
// first; `tuiPane` names a later pane for a TUI whose panes were rearranged.
export function fakeTuiTmux(options: {
	tuiMarker: (repo: string) => TuiMarkerDao;
	sessions?: string[];
	listFails?: boolean;
	behavior?: Record<string, FakeTuiBehavior>;
	tuiPane?: Record<string, string>;
}): {tmux: OuterTmuxRunner; calls: string[][]} {
	const sessions = options.sessions ?? [];
	const calls: string[][] = [];
	const paneOf = (session: string) => `%${sessions.indexOf(session)}`;
	const sessionOf = (paneId: string) =>
		sessions.find(
			name => paneOf(name) === paneId || options.tuiPane?.[name] === paneId,
		)!;
	const behaviorOf = (paneId: string): FakeTuiBehavior =>
		options.behavior?.[sessionOf(paneId)] ?? 'ready';

	const tmux: OuterTmuxRunner = args => {
		calls.push([...args]);
		switch (args[0] ?? '') {
			case 'list-sessions': {
				return options.listFails
					? {status: 1, stdout: ''}
					: {status: 0, stdout: sessions.join('\n') + '\n'};
			}

			case 'list-panes': {
				const session = args[2]!.replace(/^=(.*):\^$/, '$1');
				return {
					status: 0,
					stdout: `${paneOf(session)}\n${options.tuiPane?.[session] ?? '%90'}\n%91\n`,
				};
			}

			case 'kill-pane': {
				const paneId = args[3]!;
				const behavior = behaviorOf(paneId);
				if (behavior === 'refused') {
					return {status: 1, stdout: '', stderr: `${REFUSAL}\n`};
				}

				if (behavior === 'ready' || typeof behavior === 'object') {
					const session = sessionOf(paneId);
					void options.tuiMarker(repoOf(session)).write({
						pid: 4242,
						cliPath:
							typeof behavior === 'object' ? behavior.cliPath : FAKE_CLI_PATH,
						sha: FAKE_SHA,
						paneId,
						startedAt: Date.now(),
					});
				}

				return {status: 0, stdout: ''};
			}

			case 'display-message': {
				return {
					status: 0,
					stdout: behaviorOf(args[3]!) === 'exits' ? '1\n' : '0\n',
				};
			}

			default: {
				return {status: 0, stdout: ''};
			}
		}
	};

	return {tmux, calls};
}

// The sessions whose TUI pane was restarted, in order.
export function restarted(calls: string[][], sessions: string[]): string[] {
	return calls
		.filter(args => args[0] === 'kill-pane')
		.map(args => sessions[Number(args[3]!.slice(1))]!);
}

export const FAST = {lockTimeoutMs: 300, readyTimeoutMs: 300, pollMs: 10};
