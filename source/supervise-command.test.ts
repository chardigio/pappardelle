import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {parseSuperviseArgs, SuperviseUsageError} from './supervise-args.ts';
import {
	POLICY_REFUSED_EXIT,
	runSuperviseCommand,
	type SuperviseDeps,
} from './supervise-command.ts';
import type {SuperviseEntry} from './supervise-log.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const fixtures = path.join(
	import.meta.dirname,
	'..',
	'test',
	'fixtures',
	'agent-screens',
);
const fixture = (name: string) =>
	fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8');

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
		'   2. Yes, and don’t ask again for: rm *',
		'   3. No',
		' Esc to cancel · Tab to amend',
	].join('\n');

/** An agent session showing each of `screens` in turn, the last one after. */
function harness(t: ExecutionContext, screens: string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-'));
	t.teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const pressed: string[][] = [];
	const logged: SuperviseEntry[] = [];
	const out: string[] = [];
	const err: string[] = [];
	let clock = new Date(2026, 10, 9, 12, 0).getTime();
	let reads = 0;
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: 'agent-repo-STA-1\n'};
		}

		if (args[0] === 'capture-pane') {
			const screen = screens[Math.min(reads++, screens.length - 1)]!;
			return {status: 0, stdout: screen};
		}

		return {status: 1, stdout: ''};
	};

	const deps: SuperviseDeps = {
		repo: () => 'repo',
		resolveKey: raw => raw,
		hookKey: async key => key,
		runner,
		serverRunner: () => ({status: 1, stdout: ''}),
		now: () => new Date(clock),
		async sleep(ms) {
			clock += ms;
		},
		async waitForStatusChange(ms) {
			clock += ms;
		},
		send: async () => 'sent',
		sendKeys(_key, keys) {
			pressed.push(keys);
			return 'sent';
		},
		policy: {scratchRoots: ['/tmp/q-']},
		store: () => ({root, repo: 'repo'}),
		timers: () => ({create() {}, remove() {}}),
		caller: 'STA-9',
		readStdin: () => undefined,
		out: text => out.push(text),
		err: text => err.push(text),
		log(_repo, _caller, entry) {
			logged.push(entry);
		},
	};
	return {
		pressed,
		logged,
		out,
		err,
		run: async (...argv: string[]) => runSuperviseCommand(argv, deps),
	};
}

test('approving a QA cleanup command presses 1 and logs the verdict', async t => {
	const h = harness(t, [permission('rm -rf /tmp/q-abc')]);
	t.is(await h.run('answer', 'STA-1', '--option', '1'), 0);
	t.deepEqual(h.pressed, [['1']]);
	t.like(h.logged[0], {
		action: 'answer',
		key: 'STA-1',
		command: 'rm -rf /tmp/q-abc',
		verdict: 'allowed',
	});
});

test('a command the policy refuses comes back for a person, and nothing is pressed', async t => {
	const h = harness(t, [permission('git push origin main')]);
	t.is(await h.run('answer', 'STA-1', '--option', '1'), POLICY_REFUSED_EXIT);
	t.deepEqual(h.pressed, []);
	t.regex(h.err.join('\n'), /git push origin main/);
	t.like(h.logged[0], {verdict: 'refused: git push'});
});

test("don't-ask-again needs --force even for a command the policy allows", async t => {
	const h = harness(t, [permission('rm -rf /tmp/q-abc')]);
	t.is(await h.run('answer', 'STA-1', '--option', '2'), POLICY_REFUSED_EXIT);
	t.is(await h.run('answer', 'STA-1', '--option', '2', '--force'), 0);
	t.deepEqual(h.pressed, [['2']]);
});

test('declining and Escape need no policy', async t => {
	const h = harness(t, [permission('git push')]);
	t.is(await h.run('answer', 'STA-1', '--option', '3'), 0);
	t.is(await h.run('answer', 'STA-1', '--keys', 'Escape'), 0);
	t.is(await h.run('answer', 'STA-1', '--keys', 'Enter'), POLICY_REFUSED_EXIT);
	t.deepEqual(h.pressed, [['3'], ['Escape']]);
});

test('answer refuses an agent that is not at a prompt', async t => {
	const h = harness(t, [fixture('claude-idle')]);
	t.is(await h.run('answer', 'STA-1', '--option', '1'), 1);
	t.regex(h.err[0]!, /STA-1 is idle, not at a prompt/);
	t.deepEqual(h.pressed, []);
});

test('wait returns the first matching state with its screen', async t => {
	const h = harness(t, [
		fixture('claude-working'),
		fixture('claude-working'),
		fixture('claude-idle'),
	]);
	t.is(await h.run('wait', 'STA-1', '--until', 'idle', '--json'), 0);
	t.like(JSON.parse(h.out[0]!), {state: 'idle', timedOut: false});
});

test('wait gives up at its timeout with the state as it is', async t => {
	const h = harness(t, [fixture('claude-working')]);
	t.is(
		await h.run('wait', 'STA-1', '--until', 'idle', '--timeout', '5', '--json'),
		0,
	);
	t.like(JSON.parse(h.out[0]!), {state: 'working', timedOut: true});
});

test('wait --until changed ignores the state it started in', async t => {
	const h = harness(t, [
		fixture('claude-idle'),
		fixture('claude-idle'),
		permission('ls'),
	]);
	await h.run('wait', 'STA-1', '--until', 'changed', '--json');
	t.like(JSON.parse(h.out[0]!), {state: 'permission', timedOut: false});
});

test('reading question tabs walks right through them and back', async t => {
	const h = harness(t, [
		fixture('claude-question-two'),
		fixture('claude-question-two-right'),
		fixture('claude-question-two-back'),
	]);
	t.is(await h.run('state', 'STA-1', '--tabs', '--json'), 0);
	const {tabs} = JSON.parse(h.out[0]!) as {tabs: Array<{question: string}>};
	t.deepEqual(
		tabs.map(tab => tab.question),
		['What is your favorite color?', 'What is your favorite fruit?'],
	);
	t.deepEqual(h.pressed, [['Right'], ['Left']]);
});

test('reading tabs fails loudly when the dialog does not come back', async t => {
	const h = harness(t, [
		fixture('claude-question-two'),
		fixture('claude-question-two-right'),
		fixture('claude-question-two-right'),
	]);
	t.is(await h.run('state', 'STA-1', '--tabs'), 1);
	t.regex(h.err[0]!, /did not return to its first tab/);
});

test('a timeout past the cap and a missing --until are usage errors', t => {
	t.throws(
		() =>
			parseSuperviseArgs([
				'wait',
				'STA-1',
				'--until',
				'idle',
				'--timeout',
				'601',
			]),
		{
			instanceOf: SuperviseUsageError,
		},
	);
	t.throws(() => parseSuperviseArgs(['wait', 'STA-1']), {
		instanceOf: SuperviseUsageError,
	});
	t.throws(() => parseSuperviseArgs(['schedule', 'STA-1', '--at', '10:00']), {
		instanceOf: SuperviseUsageError,
	});
	t.throws(
		() =>
			parseSuperviseArgs([
				'schedule',
				'STA-1',
				'--after-limit',
				'--keep-going',
			]),
		{instanceOf: SuperviseUsageError},
	);
});
