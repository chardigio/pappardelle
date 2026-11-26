import type {SuperviseDeps} from '../../source/supervise-command.ts';
import type {SuperviseEntry} from '../../source/supervise-log.ts';
import {idowIdentities} from './state.ts';
import {unreachable} from './unreachable.ts';

/**
 * Supervise deps for repo `repo` with one space, STA-1, whose agent is
 * unknown to the hooks. A dep the test does not pass fails the test when
 * called, so each test states what its command reads.
 */
export function superviseDeps(overrides: Partial<SuperviseDeps> = {}): {
	deps: SuperviseDeps;
	logged: SuperviseEntry[];
	out: string[];
	err: string[];
} {
	const logged: SuperviseEntry[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const deps: SuperviseDeps = {
		repo: () => 'repo',
		identities: idowIdentities('repo', () => ['STA-1']),
		resolveKey: raw => raw,
		hookKey: async key => key,
		readHook: async () => ({status: 'unknown'}),
		readHookState: () => unreachable('readHookState is not stubbed'),
		readSnapshot: () => unreachable('readSnapshot is not stubbed'),
		runner: () => unreachable('runner is not stubbed'),
		serverRunner: () => ({status: 1, stdout: ''}),
		now: () => new Date(2026, 10, 9, 12, 0),
		async sleep() {},
		async waitForStatusChange() {},
		send: async () => 'sent',
		sendKeys: () => 'sent',
		typeText: () => 'sent',
		classify: () => unreachable('classify is not stubbed'),
		policy: () => unreachable('policy is not stubbed'),
		store: () => unreachable('store is not stubbed'),
		holds: () => unreachable('holds is not stubbed'),
		newHoldId: () => unreachable('newHoldId is not stubbed'),
		timers: () => unreachable('timers is not stubbed'),
		caller: 'main',
		readStdin: () => undefined,
		out: text => out.push(text),
		err: text => err.push(text),
		log(_repo, _caller, entry) {
			logged.push(entry);
		},
		...overrides,
	};
	return {deps, logged, out, err};
}
