import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import type {AgentState, AgentStateReport} from './agent-state.ts';
import {
	fireJob,
	listJobs,
	loadJob,
	parseWhen,
	queuedMessage,
	rearmMissingTimers,
	RETRY_MS,
	type TimerWhen,
	queueMessage,
	saveJob,
	type Job,
	type SendOutcome,
} from './schedule.ts';
import {
	launchdPlist,
	onCalendar,
	systemdBackend,
	systemdUnitName,
	type TimerContext,
} from './schedule-timers.ts';

const NOW = new Date(2026, 10, 9, 12, 0);

function report(
	state: AgentState,
	resetAt: Date | null = null,
): AgentStateReport {
	return {
		key: 'STA-1',
		state,
		app: null,
		status: null,
		permission: null,
		question: null,
		usageLimit: resetAt
			? {resetText: '', resetAt, passed: resetAt <= NOW}
			: null,
		codexDialog: null,
		composer: null,
		screen: '',
	};
}

function harness(
	t: ExecutionContext,
	states: AgentStateReport[],
	sendOutcome: SendOutcome = 'sent',
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
	t.teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const store = {root, repo: 'repo'};
	const sent: string[] = [];
	const dismissed: string[] = [];
	const timers: Job[] = [];
	const removed: string[] = [];
	return {
		store,
		sent,
		dismissed,
		timers,
		removed,
		async fire(job: Job, now = NOW) {
			return fireJob(loadJob(store, job.id) ?? job, {
				store,
				now,
				readState: async () => states.shift() ?? report('idle'),
				async send(_key, text) {
					sent.push(text);
					return sendOutcome;
				},
				async dismissModelSwitch(key) {
					dismissed.push(key);
				},
				createTimer(next) {
					timers.push(next);
				},
				removeTimer(done) {
					removed.push(done.id);
				},
			});
		},
	};
}

const keepGoing = (until: string | null = null): Job => ({
	kind: 'keep_going',
	id: 'kg',
	key: 'STA-1',
	everySeconds: 600,
	nudge: 'keep going',
	until,
	idleChecks: 0,
});

test('keep_going nudges on the second idle check in a row, not the first', async t => {
	const h = harness(t, [report('idle'), report('idle')]);
	saveJob(h.store, keepGoing());
	t.is(await h.fire(keepGoing()), 'waiting');
	t.deepEqual(h.sent, []);
	t.is(await h.fire(keepGoing()), 'sent');
	t.deepEqual(h.sent, ['keep going']);
});

test('working between idle checks starts the count over', async t => {
	const h = harness(t, [report('idle'), report('working'), report('idle')]);
	saveJob(h.store, keepGoing());
	await h.fire(keepGoing());
	t.is(await h.fire(keepGoing()), 'skipped_working');
	t.is(await h.fire(keepGoing()), 'waiting');
	t.deepEqual(h.sent, []);
});

test('a queued message goes out in place of the nudge, once', async t => {
	const h = harness(t, [report('idle'), report('idle')]);
	saveJob(h.store, {...keepGoing(), idleChecks: 1});
	queueMessage(h.store, 'STA-1', 'do the review fixes next');
	await h.fire(keepGoing());
	t.deepEqual(h.sent, ['do the review fixes next']);
	saveJob(h.store, {...keepGoing(), idleChecks: 1});
	await h.fire(keepGoing());
	t.deepEqual(h.sent, ['do the review fixes next', 'keep going']);
});

test('a queued message survives a send that was refused', async t => {
	const h = harness(t, [report('idle')], 'draft');
	saveJob(h.store, {...keepGoing(), idleChecks: 1});
	queueMessage(h.store, 'STA-1', 'the next step');
	t.is(await h.fire(keepGoing()), 'skipped_draft');
	t.is(queuedMessage(h.store, 'STA-1'), 'the next step');
});

test('keep_going waits out a usage limit, then sends continue', async t => {
	const reset = new Date(2026, 10, 9, 12, 30);
	const h = harness(t, [
		report('usage_limit', reset),
		report('usage_limit', reset),
	]);
	saveJob(h.store, keepGoing());
	t.is(await h.fire(keepGoing()), 'waiting');
	t.is(await h.fire(keepGoing(), new Date(2026, 10, 9, 12, 31, 30)), 'sent');
	t.deepEqual(h.sent, ['continue']);
});

test('keep_going never types over a draft', async t => {
	const h = harness(t, [report('draft')]);
	saveJob(h.store, {...keepGoing(), idleChecks: 1});
	t.is(await h.fire(keepGoing()), 'skipped_draft');
	t.deepEqual(h.sent, []);
});

test('keep_going past its end removes itself', async t => {
	const job = keepGoing(new Date(2026, 10, 9, 11, 0).toISOString());
	const h = harness(t, []);
	saveJob(h.store, job);
	t.is(await h.fire(job), 'expired');
	t.deepEqual(listJobs(h.store), []);
	t.deepEqual(h.removed, ['kg']);
});

test('after_limit sends once the reset has passed, though Codex still shows the limit', async t => {
	const job: Job = {
		kind: 'after_limit',
		id: 'al',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'continue',
		arm: 0,
	};
	const h = harness(t, [report('usage_limit', new Date(2026, 10, 9, 11, 58))]);
	saveJob(h.store, job);
	t.is(await h.fire(job), 'sent');
	t.deepEqual(h.sent, ['continue']);
	t.deepEqual(listJobs(h.store), []);
});

test('--at refuses clock times that do not exist', t => {
	t.is(parseWhen('25:00', NOW), null);
	t.is(parseWhen('9:99', NOW), null);
});

const afterLimit: Job = {
	kind: 'after_limit',
	id: 'al',
	key: 'STA-1',
	at: NOW.toISOString(),
	message: 'continue',
	arm: 0,
};

test('after_limit moves to a later reset, keeping its id under a new timer', async t => {
	const later = new Date(2026, 10, 10, 4, 28);
	const h = harness(t, [report('usage_limit', later)]);
	saveJob(h.store, afterLimit);
	t.is(await h.fire(afterLimit), 'waiting');
	t.deepEqual(h.sent, []);
	t.deepEqual(listJobs(h.store), [
		{
			...afterLimit,
			at: new Date(later.getTime() + 60_000).toISOString(),
			arm: 1,
		},
	]);
	t.like(h.timers[0], {id: 'al', arm: 1});
	t.deepEqual(h.removed, ['al']);
});

test('a one-shot whose send is refused tries again in five minutes', async t => {
	const h = harness(
		t,
		[report('usage_limit', new Date(2026, 10, 9, 11, 58))],
		'draft',
	);
	saveJob(h.store, afterLimit);
	queueMessage(h.store, 'STA-1', 'the next step');
	t.is(await h.fire(afterLimit), 'retrying');
	t.like(listJobs(h.store)[0], {
		at: new Date(NOW.getTime() + RETRY_MS).toISOString(),
		arm: 1,
	});
	t.is(queuedMessage(h.store, 'STA-1'), 'the next step');
});

test('a one-shot for a space with no agent session is dropped', async t => {
	const h = harness(t, [report('no_session')]);
	saveJob(h.store, afterLimit);
	t.is(await h.fire(afterLimit), 'no_session');
	t.deepEqual(h.sent, []);
	t.deepEqual(listJobs(h.store), []);
});

test('a wake-up keeps the current model when Codex offers to switch, then sends', async t => {
	const atLimit = {
		...report('dialog', new Date(2026, 10, 9, 11, 58)),
		codexDialog: {kind: 'model_switch' as const, title: 'Switch?'},
	};
	const h = harness(t, [atLimit, atLimit]);
	saveJob(h.store, afterLimit);
	t.is(await h.fire(afterLimit), 'sent');
	t.deepEqual(h.dismissed, ['STA-1']);
	saveJob(h.store, keepGoing());
	t.is(await h.fire(keepGoing()), 'sent');
	t.deepEqual(h.sent, ['continue', 'continue']);
});

test('keep_going leaves any other Codex dialog to a person', async t => {
	const h = harness(t, [
		{...report('dialog'), codexDialog: {kind: 'other', title: 'Trust?'}},
	]);
	saveJob(h.store, {...keepGoing(), idleChecks: 1});
	t.is(await h.fire(keepGoing()), 'waiting');
	t.deepEqual(h.sent, []);
	t.deepEqual(h.dismissed, []);
});

test('jobs whose timers a reboot dropped get new ones; a missed time fires soon', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
	t.teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const store = {root, repo: 'repo'};
	const missed: Job = {
		...afterLimit,
		at: new Date(2026, 10, 9, 8).toISOString(),
	};
	const loaded: Job = {...keepGoing(), id: 'loaded'};
	saveJob(store, missed);
	saveJob(store, loaded);
	saveJob(store, keepGoing());
	const created: Array<[Job, TimerWhen]> = [];
	const rearmed = rearmMissingTimers(
		store,
		{
			exists: job => job.id === 'loaded',
			create(job, when) {
				created.push([job, when]);
			},
		},
		NOW,
	);
	t.deepEqual(rearmed.map(job => job.id).sort(), ['al', 'kg']);
	t.deepEqual(
		created.find(([job]) => job.id === 'al'),
		[
			{...missed, at: new Date(NOW.getTime() + 60_000).toISOString(), arm: 1},
			{at: new Date(NOW.getTime() + 60_000)},
		],
	);
	t.like(loadJob(store, 'al'), {arm: 1});
	t.deepEqual(created.find(([job]) => job.id === 'kg')?.[1], {
		everySeconds: 600,
	});
});

test('--at takes a time of day as its next occurrence', t => {
	t.deepEqual(parseWhen('13:15', NOW), new Date(2026, 10, 9, 13, 15));
	t.deepEqual(parseWhen('09:00', NOW), new Date(2026, 10, 10, 9, 0));
});

const context = (
	run: TimerContext['run'] = () => ({status: 0, stderr: ''}),
) => ({
	repo: 'my repo',
	cwd: '/src/repo',
	launch: ['/opt/pappardelle/dist/pappardelle'],
	env: {PATH: '/usr/bin'},
	run,
});

test('a systemd one-shot fires at local time and unloads once it has', t => {
	const calls: string[][] = [];
	const backend = systemdBackend(
		context((command, args) => {
			calls.push([command, ...args]);
			return {status: 0, stderr: ''};
		}),
	);
	const job: Job = {
		kind: 'at',
		id: 'ab12',
		key: 'STA-1',
		at: '',
		message: 'hi',
		arm: 0,
	};
	backend.create(job, {at: new Date(2026, 10, 9, 23, 59, 5)});
	t.deepEqual(calls[0], [
		'systemd-run',
		'--user',
		'--unit=pappardelle-my_repo-ab12',
		'--description=Pappardelle wake-up for STA-1',
		'--timer-property=RemainAfterElapse=no',
		'--timer-property=AccuracySec=1s',
		'--working-directory=/src/repo',
		'--setenv=PATH=/usr/bin',
		'--on-calendar=2026-11-09 23:59:05',
		'--',
		'/opt/pappardelle/dist/pappardelle',
		'schedule',
		'fire',
		'ab12',
	]);
	t.is(systemdUnitName('a.b', job), 'pappardelle-a.b-ab12');
	t.is(systemdUnitName('a.b', {...job, arm: 2}), 'pappardelle-a.b-ab12-2');
	t.is(onCalendar(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('a launchd agent runs the same command on the calendar date', t => {
	const plist = launchdPlist(
		context(),
		{kind: 'at', id: 'ab12', key: 'STA-1', at: '', message: 'hi', arm: 0},
		{at: new Date(2026, 10, 14, 7, 51)},
	);
	t.regex(
		plist,
		/<key>Label<\/key>\n\t<string>dev\.pappardelle\.my_repo\.ab12<\/string>/,
	);
	t.regex(
		plist,
		/<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/opt\/pappardelle\/dist\/pappardelle<\/string>\n\t\t<string>schedule<\/string>\n\t\t<string>fire<\/string>\n\t\t<string>ab12<\/string>/,
	);
	t.regex(
		plist,
		/<key>Month<\/key>\n\t\t<integer>11<\/integer>\n\t\t<key>Day<\/key>\n\t\t<integer>14<\/integer>\n\t\t<key>Hour<\/key>\n\t\t<integer>7<\/integer>\n\t\t<key>Minute<\/key>\n\t\t<integer>51<\/integer>/,
	);
	t.regex(
		plist,
		/<key>WorkingDirectory<\/key>\n\t<string>\/src\/repo<\/string>/,
	);
});

test('a launchd time with seconds fires at the start of the next minute', t => {
	const plist = launchdPlist(
		context(),
		{kind: 'at', id: 'ab12', key: 'STA-1', at: '', message: 'hi', arm: 0},
		{at: new Date(2026, 10, 14, 7, 51, 20)},
	);
	t.regex(plist, /<key>Minute<\/key>\n\t\t<integer>52<\/integer>/);
});
