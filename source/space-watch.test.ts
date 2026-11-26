import fs from 'node:fs';
import path from 'node:path';
import {idowIdentities} from '../test/helpers/state.ts';
import {superviseDeps} from '../test/helpers/supervise-deps.ts';
import {test, expect} from 'bun:test';
import {parseSuperviseArgs, SuperviseUsageError} from './supervise-args.ts';
import {runSuperviseCommand, type WatchResult} from './supervise-command.ts';
import type {ClaudeStatusInfo} from './claude-status.ts';
import {decodeCursor, encodeCursor} from './space-watch.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const fixture = (name: string) =>
	fs.readFileSync(
		path.join(
			import.meta.dirname,
			'..',
			'test',
			'fixtures',
			'agent-screens',
			`${name}.txt`,
		),
		'utf8',
	);

const idle = fixture('claude-idle');
const question = fixture('claude-question-two');
const permission = (command: string) =>
	[
		'────────────────────',
		' Bash command',
		' Clean up',
		'╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
		` ${command}`,
		'╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
		' Do you want to proceed?',
		' ❯ 1. Yes',
		'   2. No',
		' Esc to cancel · Tab to amend',
	].join('\n');

/**
 * Agent sessions in repo `repo`, keyed by space, each showing its screen.
 * `between` runs each time the watch sleeps, to change screens mid-wait.
 */
function spaces(
	initial: Record<string, string>,
	/** The spaces with an identity; by default every one with a screen. */
	identified?: string[],
	initialPanes: Record<string, string> = {},
	initialHooks: Record<string, ClaudeStatusInfo> = {},
) {
	const screens = {...initial};
	const paneListings = {...initialPanes};
	const hooks = {...initialHooks};
	let clock = new Date(2026, 10, 9, 12, 0).getTime();
	let between: Array<() => void> = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			return {
				status: 0,
				stdout: Object.keys(screens)
					.map(key => `agent-repo-${key}\n`)
					.join(''),
			};
		}

		if (args[0] === 'capture-pane') {
			const target = args.at(-1)!;
			const key = /^=agent-repo-(.*):$/.exec(target)?.[1] ?? '';
			const screen = screens[key];
			return screen === undefined
				? {status: 1, stdout: ''}
				: {status: 0, stdout: screen};
		}

		if (args[0] === 'list-panes') {
			const target = args[args.indexOf('-t') + 1] ?? '';
			const key = /^=agent-repo-(.*):$/.exec(target)?.[1] ?? '';
			const listing = paneListings[key];
			return listing === undefined
				? {status: 1, stdout: ''}
				: {status: 0, stdout: listing};
		}

		return {status: 1, stdout: ''};
	};

	const {deps, logged, out} = superviseDeps({
		identities: idowIdentities(
			'repo',
			() => identified ?? Object.keys(screens),
		),
		resolveKey: raw => (/^\d+$/.test(raw) ? `STA-${raw}` : raw),
		readHook: async key => hooks[key] ?? {status: 'unknown'},
		readSnapshot: async () => null,
		runner,
		now: () => new Date(clock),
		async sleep(ms) {
			clock += ms;
		},
		async waitForStatusChange(ms) {
			clock += ms;
			between.shift()?.();
		},
		caller: '9',
	});
	return {
		screens,
		paneListings,
		hooks,
		logged,
		onWait(...steps: Array<() => void>) {
			between = steps;
		},
		async watch(...argv: string[]): Promise<WatchResult> {
			await runSuperviseCommand(['watch', ...argv, '--json'], deps);
			return JSON.parse(out.at(-1)!) as WatchResult;
		},
		async watchText(...argv: string[]): Promise<string> {
			await runSuperviseCommand(['watch', ...argv], deps);
			return out.at(-1)!;
		},
	};
}

test('without a cursor, spaces already blocked come back at once, the caller left out', async () => {
	const h = spaces({
		'STA-1': permission('rm -rf /tmp/q-a'),
		'STA-2': idle,
		'STA-9': question,
	});
	const result = await h.watch('--until', 'blocked');
	expect(result.result).toBe('changed');
	expect(
		result.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-1', null, 'permission']]);
	expect(result.changes[0]!.permission?.command).toBe('rm -rf /tmp/q-a');
	expect(h.logged[0]).toMatchObject({
		action: 'watch',
		key: 'STA-1',
		detail: 'new -> permission',
	});
});

test('watching every space watches exactly those with a live stored agent session', async () => {
	// STA-2 has an identity and no session; STA-3 a session and no identity.
	const h = spaces({'STA-1': permission('ls'), 'STA-3': permission('ls')}, [
		'STA-1',
		'STA-2',
	]);
	const result = await h.watch('--until', 'blocked');
	expect(result.changes.map(change => change.key)).toStrictEqual(['STA-1']);
});

test('a change while the supervisor was busy is returned by the next call', async () => {
	const h = spaces({'STA-1': permission('ls'), 'STA-2': idle});
	const first = await h.watch('--until', 'blocked');
	// The supervisor answers STA-1; meanwhile STA-2 asks a question.
	h.screens['STA-1'] = idle;
	h.screens['STA-2'] = question;
	const next = await h.watch('--until', 'blocked', '--since', first.cursor);
	expect(
		next.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-2', 'idle', 'question']]);
	expect(next.changes[0]!.question).toBeTruthy();
});

test('a space still on the prompt the cursor saw is not reported again, and the timeout is its own result', async () => {
	const h = spaces({'STA-1': permission('ls'), 'STA-2': idle});
	const first = await h.watch('--until', 'blocked');
	const again = await h.watch(
		'--until',
		'blocked',
		'--since',
		first.cursor,
		'--timeout',
		'10',
	);
	expect(again).toStrictEqual({
		result: 'timed_out',
		changes: [],
		cursor: first.cursor,
	});
});

test('leaving a prompt and landing on a new one is reported', async () => {
	const h = spaces({'STA-1': permission('ls')});
	const first = await h.watch('--until', 'permission');
	h.onWait(
		() => {
			h.screens['STA-1'] = idle;
		},
		() => {
			h.screens['STA-1'] = permission('ls -la');
		},
	);
	const next = await h.watch('--until', 'permission', '--since', first.cursor);
	expect(next.changes[0]).toMatchObject({
		key: 'STA-1',
		from: 'idle',
		to: 'permission',
	});
	expect(next.result).toBe('changed');
	expect(next.changes[0]!.permission?.command).toBe('ls -la');
});

test('with no targets, only a change from the first look counts', async () => {
	const h = spaces({'STA-1': idle, 'STA-2': permission('ls')});
	h.onWait(() => {
		h.screens['STA-1'] = question;
	});
	const result = await h.watch();
	expect(
		result.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-1', 'idle', 'question']]);
});

test('named spaces only, and a space in the cursor that closed reports no_session', async () => {
	const h = spaces({'STA-1': idle, 'STA-2': idle});
	const first = await h.watch('--timeout', '1');
	expect(first.result).toBe('timed_out');
	delete h.screens['STA-2'];
	const closed = await h.watch('--since', first.cursor);
	expect(
		closed.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-2', 'idle', 'no_session']]);

	h.screens['STA-3'] = question;
	const named = await h.watch('STA-1', '--until', 'question', '--timeout', '1');
	expect(named.result).toBe('timed_out');
});

test('the cursor survives a round trip and junk is refused', () => {
	const cursor = {'STA-1': 'idle', main: 'permission'} as const;
	expect(decodeCursor(encodeCursor(cursor))).toStrictEqual(cursor);
	expect(decodeCursor('not a cursor')).toBe(null);
	expect(decodeCursor(encodeCursor({'STA-1': 'asleep'} as never))).toBe(null);
	expect(() => parseSuperviseArgs(['watch', '--since', 'nope'])).toThrow(
		SuperviseUsageError,
	);
	expect(() =>
		parseSuperviseArgs(['watch', '--until', 'permission_prompt']),
	).toThrow(SuperviseUsageError);
	expect(() => parseSuperviseArgs(['watch', '--timeout', '601'])).toThrow(
		SuperviseUsageError,
	);
});

test('a new prompt where the last one was answered is news, though the state is the same', async () => {
	const h = spaces({'STA-1': permission('cksum a')});
	const first = await h.watch('--until', 'blocked');
	// Answered; by the next call the agent already asks again.
	h.screens['STA-1'] = permission('cksum b');
	const next = await h.watch('--until', 'blocked', '--since', first.cursor);
	expect(next.changes[0]).toMatchObject({
		key: 'STA-1',
		from: 'permission',
		to: 'permission',
	});
	expect(next.changes[0]!.permission?.command).toBe('cksum b');
});

test('a named space with no session comes back at once', async () => {
	const h = spaces({'STA-1': idle});
	const result = await h.watch('STA-77', '--until', 'blocked');
	expect(
		result.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-77', null, 'no_session']]);
});

test('a closed space leaves the cursor once reported, and junk after a cursor is refused', async () => {
	const h = spaces({'STA-1': idle, 'STA-2': idle});
	const first = await h.watch('--timeout', '1');
	delete h.screens['STA-2'];
	const closed = await h.watch('--since', first.cursor);
	expect(Object.keys(decodeCursor(closed.cursor)!)).toStrictEqual(['STA-1']);
	expect(decodeCursor(`${first.cursor}!!`)).toBe(null);
});

test('a space whose agent exited wakes a blocked watch once and stays in the cursor', async () => {
	const h = spaces(
		{'STA-1': fixture('claude-working')},
		['STA-1'],
		{'STA-1': '11\t%1\t%1\t42\t0\t1\t42.marker\tclaude\n'},
		{'STA-1': {status: 'processing'}},
	);
	h.onWait(() => {
		h.screens['STA-1'] = '[user@host STA-1]$ ';
		h.paneListings['STA-1'] = '11\t%1\t%1\t42\t0\t1\t42.marker\tbash\n';
		h.hooks['STA-1'] = {status: 'ended'};
	});
	const first = await h.watch('--until', 'blocked');
	expect(first.result).toBe('changed');
	expect(
		first.changes.map(change => [change.key, change.from, change.to]),
	).toStrictEqual([['STA-1', 'working', 'exited']]);
	expect(decodeCursor(first.cursor)).toStrictEqual({'STA-1': 'exited'});

	const next = await h.watch(
		'--until',
		'blocked',
		'--since',
		first.cursor,
		'--timeout',
		'1',
	);
	expect(next.result).toBe('timed_out');
	expect(next.changes).toStrictEqual([]);
});

test('watch labels agy dialogs in text and treats a new agy dialog as a change', async () => {
	const h = spaces({'STA-1': fixture('agy-trust')}, ['STA-1']);
	const text = await h.watchText('--until', 'blocked');
	expect(text).toContain('STA-1: new -> dialog');
	expect(text).toContain('  Dialog: Trust this folder?');

	const first = await h.watch('--until', 'blocked');
	expect(first.changes[0]).toMatchObject({
		key: 'STA-1',
		to: 'dialog',
		agyDialog: 'trust',
	});

	// Transitioning directly to a different agy dialog still wakes watch.
	h.screens['STA-1'] = fixture('agy-subagent-manage');
	const next = await h.watch('--until', 'blocked', '--since', first.cursor);
	expect(next.result).toBe('changed');
	expect(next.changes[0]).toMatchObject({
		key: 'STA-1',
		from: 'dialog',
		to: 'dialog',
		agyDialog: 'subagent_manage',
	});
});
