import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {parseSuperviseArgs, SuperviseUsageError} from './supervise-args.ts';
import {
	runSuperviseCommand,
	type SuperviseDeps,
	type WatchResult,
} from './supervise-command.ts';
import type {SuperviseEntry} from './supervise-log.ts';
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
function spaces(initial: Record<string, string>) {
	const screens = {...initial};
	const logged: SuperviseEntry[] = [];
	const out: string[] = [];
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

		return {status: 1, stdout: ''};
	};

	const deps: SuperviseDeps = {
		repo: () => 'repo',
		resolveKey: raw => (/^\d+$/.test(raw) ? `STA-${raw}` : raw),
		hookKey: async key => `no-such-hook-${key}`,
		runner,
		serverRunner: () => ({status: 1, stdout: ''}),
		now: () => new Date(clock),
		async sleep(ms) {
			clock += ms;
		},
		async waitForStatusChange(ms) {
			clock += ms;
			between.shift()?.();
		},
		send: async () => 'sent',
		sendKeys: () => 'sent',
		typeText: () => 'sent',
		classify: async () => ({allow: true}),
		policy: {scratchRoots: ['/tmp/q-']},
		store: () => ({root: '/nonexistent', repo: 'repo'}),
		timers: () => ({create() {}, remove() {}}),
		caller: '9',
		readStdin: () => undefined,
		out: text => out.push(text),
		err() {},
		log(_repo, _caller, entry) {
			logged.push(entry);
		},
	};
	return {
		screens,
		logged,
		onWait(...steps: Array<() => void>) {
			between = steps;
		},
		async watch(...argv: string[]): Promise<WatchResult> {
			await runSuperviseCommand(['watch', ...argv, '--json'], deps);
			return JSON.parse(out.at(-1)!) as WatchResult;
		},
	};
}

test('without a cursor, spaces already blocked come back at once, the caller left out', async t => {
	const h = spaces({
		'STA-1': permission('rm -rf /tmp/q-a'),
		'STA-2': idle,
		'STA-9': question,
	});
	const result = await h.watch('--until', 'blocked');
	t.is(result.result, 'changed');
	t.deepEqual(
		result.changes.map(change => [change.key, change.from, change.to]),
		[['STA-1', null, 'permission']],
	);
	t.is(result.changes[0]!.permission?.command, 'rm -rf /tmp/q-a');
	t.like(h.logged[0], {
		action: 'watch',
		key: 'STA-1',
		detail: 'new -> permission',
	});
});

test('a change while the supervisor was busy is returned by the next call', async t => {
	const h = spaces({'STA-1': permission('ls'), 'STA-2': idle});
	const first = await h.watch('--until', 'blocked');
	// The supervisor answers STA-1; meanwhile STA-2 asks a question.
	h.screens['STA-1'] = idle;
	h.screens['STA-2'] = question;
	const next = await h.watch('--until', 'blocked', '--since', first.cursor);
	t.deepEqual(
		next.changes.map(change => [change.key, change.from, change.to]),
		[['STA-2', 'idle', 'question']],
	);
	t.truthy(next.changes[0]!.question);
});

test('a space still on the prompt the cursor saw is not reported again, and the timeout is its own result', async t => {
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
	t.deepEqual(again, {
		result: 'timed_out',
		changes: [],
		cursor: first.cursor,
	});
});

test('leaving a prompt and landing on a new one is reported', async t => {
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
	t.like(next.changes[0], {key: 'STA-1', from: 'idle', to: 'permission'});
	t.is(next.result, 'changed');
	t.is(next.changes[0]!.permission?.command, 'ls -la');
});

test('with no targets, only a change from the first look counts', async t => {
	const h = spaces({'STA-1': idle, 'STA-2': permission('ls')});
	h.onWait(() => {
		h.screens['STA-1'] = question;
	});
	const result = await h.watch();
	t.deepEqual(
		result.changes.map(change => [change.key, change.from, change.to]),
		[['STA-1', 'idle', 'question']],
	);
});

test('named spaces only, and a space in the cursor that closed reports no_session', async t => {
	const h = spaces({'STA-1': idle, 'STA-2': idle});
	const first = await h.watch('--timeout', '1');
	t.is(first.result, 'timed_out');
	delete h.screens['STA-2'];
	const closed = await h.watch('--since', first.cursor);
	t.deepEqual(
		closed.changes.map(change => [change.key, change.from, change.to]),
		[['STA-2', 'idle', 'no_session']],
	);

	h.screens['STA-3'] = question;
	const named = await h.watch('STA-1', '--until', 'question', '--timeout', '1');
	t.is(named.result, 'timed_out');
});

test('the cursor survives a round trip and junk is refused', t => {
	const cursor = {'STA-1': 'idle', main: 'permission'} as const;
	t.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
	t.is(decodeCursor('not a cursor'), null);
	t.is(decodeCursor(encodeCursor({'STA-1': 'asleep'} as never)), null);
	t.throws(() => parseSuperviseArgs(['watch', '--since', 'nope']), {
		instanceOf: SuperviseUsageError,
	});
	t.throws(
		() => parseSuperviseArgs(['watch', '--until', 'permission_prompt']),
		{
			instanceOf: SuperviseUsageError,
		},
	);
	t.throws(() => parseSuperviseArgs(['watch', '--timeout', '601']), {
		instanceOf: SuperviseUsageError,
	});
});

test('a new prompt where the last one was answered is news, though the state is the same', async t => {
	const h = spaces({'STA-1': permission('cksum a')});
	const first = await h.watch('--until', 'blocked');
	// Answered; by the next call the agent already asks again.
	h.screens['STA-1'] = permission('cksum b');
	const next = await h.watch('--until', 'blocked', '--since', first.cursor);
	t.like(next.changes[0], {key: 'STA-1', from: 'permission', to: 'permission'});
	t.is(next.changes[0]!.permission?.command, 'cksum b');
});

test('a named space with no session comes back at once', async t => {
	const h = spaces({'STA-1': idle});
	const result = await h.watch('STA-77', '--until', 'blocked');
	t.deepEqual(
		result.changes.map(change => [change.key, change.from, change.to]),
		[['STA-77', null, 'no_session']],
	);
});

test('a closed space leaves the cursor once reported, and junk after a cursor is refused', async t => {
	const h = spaces({'STA-1': idle, 'STA-2': idle});
	const first = await h.watch('--timeout', '1');
	delete h.screens['STA-2'];
	const closed = await h.watch('--since', first.cursor);
	t.deepEqual(Object.keys(decodeCursor(closed.cursor)!), ['STA-1']);
	t.is(decodeCursor(`${first.cursor}!!`), null);
});
