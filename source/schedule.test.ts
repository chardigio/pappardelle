import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import type {AgentState, AgentStateReport} from './agent-state.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {
	fireJob,
	parseWhen,
	rearmMissingTimers,
	RETRY_MS,
	type TimerWhen,
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
	state: TestState,
	states: AgentStateReport[],
	sendOutcome: SendOutcome = 'sent',
) {
	const store = state.daos.schedules;
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
			return fireJob(store.load(job.id) ?? job, {
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

contractTest(
	'keep_going nudges on the second idle check in a row, not the first',
	async state => {
		const h = harness(state, [report('idle'), report('idle')]);
		await h.store.save(keepGoing());
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(h.sent).toStrictEqual([]);
		expect(await h.fire(keepGoing())).toBe('sent');
		expect(h.sent).toStrictEqual(['keep going']);
	},
);

contractTest(
	'working between idle checks starts the count over',
	async state => {
		const h = harness(state, [
			report('idle'),
			report('working'),
			report('idle'),
		]);
		await h.store.save(keepGoing());
		await h.fire(keepGoing());
		expect(await h.fire(keepGoing())).toBe('skipped_working');
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(h.sent).toStrictEqual([]);
	},
);

contractTest(
	'a queued message goes out in place of the nudge, once',
	async state => {
		const h = harness(state, [report('idle'), report('idle')]);
		await h.store.save({...keepGoing(), idleChecks: 1});
		await h.store.queue('STA-1', 'do the review fixes next');
		await h.fire(keepGoing());
		expect(h.sent).toStrictEqual(['do the review fixes next']);
		await h.store.save({...keepGoing(), idleChecks: 1});
		await h.fire(keepGoing());
		expect(h.sent).toStrictEqual(['do the review fixes next', 'keep going']);
	},
);

contractTest(
	'a queued message survives a send that was refused',
	async state => {
		const h = harness(state, [report('idle')], 'draft');
		await h.store.save({...keepGoing(), idleChecks: 1});
		await h.store.queue('STA-1', 'the next step');
		expect(await h.fire(keepGoing())).toBe('skipped_draft');
		expect(h.store.queued('STA-1')).toBe('the next step');
	},
);

contractTest(
	'keep_going waits out a usage limit, then sends continue',
	async state => {
		const reset = new Date(2026, 10, 9, 12, 30);
		const h = harness(state, [
			report('usage_limit', reset),
			report('usage_limit', reset),
		]);
		await h.store.save(keepGoing());
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(await h.fire(keepGoing(), new Date(2026, 10, 9, 12, 31, 30))).toBe(
			'sent',
		);
		expect(h.sent).toStrictEqual(['continue']);
	},
);

contractTest('keep_going never types over a draft', async state => {
	const h = harness(state, [report('draft')]);
	await h.store.save({...keepGoing(), idleChecks: 1});
	expect(await h.fire(keepGoing())).toBe('skipped_draft');
	expect(h.sent).toStrictEqual([]);
});

contractTest('keep_going past its end removes itself', async state => {
	const job = keepGoing(new Date(2026, 10, 9, 11, 0).toISOString());
	const h = harness(state, []);
	await h.store.save(job);
	expect(await h.fire(job)).toBe('expired');
	expect(h.store.list()).toStrictEqual([]);
	expect(h.removed).toStrictEqual(['kg']);
});

contractTest(
	'after_limit sends once the reset has passed, though Codex still shows the limit',
	async state => {
		const job: Job = {
			kind: 'after_limit',
			id: 'al',
			key: 'STA-1',
			at: NOW.toISOString(),
			message: 'continue',
			arm: 0,
		};
		const h = harness(state, [
			report('usage_limit', new Date(2026, 10, 9, 11, 58)),
		]);
		await h.store.save(job);
		expect(await h.fire(job)).toBe('sent');
		expect(h.sent).toStrictEqual(['continue']);
		expect(h.store.list()).toStrictEqual([]);
	},
);

test('--at refuses clock times that do not exist', () => {
	expect(parseWhen('25:00', NOW)).toBe(null);
	expect(parseWhen('9:99', NOW)).toBe(null);
});

const afterLimit: Job = {
	kind: 'after_limit',
	id: 'al',
	key: 'STA-1',
	at: NOW.toISOString(),
	message: 'continue',
	arm: 0,
};

contractTest(
	'after_limit moves to a later reset, keeping its id under a new timer',
	async state => {
		const later = new Date(2026, 10, 10, 4, 28);
		const h = harness(state, [report('usage_limit', later)]);
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit)).toBe('waiting');
		expect(h.sent).toStrictEqual([]);
		expect(h.store.list()).toStrictEqual([
			{
				...afterLimit,
				at: new Date(later.getTime() + 60_000).toISOString(),
				arm: 1,
			},
		]);
		expect(h.timers[0]).toMatchObject({id: 'al', arm: 1});
		expect(h.removed).toStrictEqual(['al']);
	},
);

contractTest(
	'a one-shot whose send is refused tries again in five minutes',
	async state => {
		const h = harness(
			state,
			[report('usage_limit', new Date(2026, 10, 9, 11, 58))],
			'draft',
		);
		await h.store.save(afterLimit);
		await h.store.queue('STA-1', 'the next step');
		expect(await h.fire(afterLimit)).toBe('retrying');
		expect(h.store.list()[0]).toMatchObject({
			at: new Date(NOW.getTime() + RETRY_MS).toISOString(),
			arm: 1,
		});
		expect(h.store.queued('STA-1')).toBe('the next step');
	},
);

contractTest(
	'a one-shot whose text stays unsubmitted in the input box is done, so a retry never sends it twice',
	async state => {
		const h = harness(state, [report('idle')], 'unsubmitted');
		await h.store.save(afterLimit);
		await h.store.queue('STA-1', 'the next step');
		expect(await h.fire(afterLimit)).toBe('unsubmitted');
		expect(h.store.list()).toStrictEqual([]);
		expect(h.removed).toStrictEqual(['al']);
		expect(h.store.queued('STA-1')).toBe(null);
	},
);

contractTest(
	'a one-shot for a space with no agent session is dropped',
	async state => {
		const h = harness(state, [report('no_session')]);
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit)).toBe('no_session');
		expect(h.sent).toStrictEqual([]);
		expect(h.store.list()).toStrictEqual([]);
	},
);

contractTest(
	'a wake-up keeps the current model when Codex offers to switch, then sends',
	async state => {
		const atLimit = {
			...report('dialog', new Date(2026, 10, 9, 11, 58)),
			codexDialog: {kind: 'model_switch' as const, title: 'Switch?'},
		};
		const h = harness(state, [atLimit, atLimit]);
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit)).toBe('sent');
		expect(h.dismissed).toStrictEqual(['STA-1']);
		await h.store.save(keepGoing());
		expect(await h.fire(keepGoing())).toBe('sent');
		expect(h.sent).toStrictEqual(['continue', 'continue']);
	},
);

contractTest(
	'keep_going leaves any other Codex dialog to a person',
	async state => {
		const h = harness(state, [
			{...report('dialog'), codexDialog: {kind: 'other', title: 'Trust?'}},
		]);
		await h.store.save({...keepGoing(), idleChecks: 1});
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(h.sent).toStrictEqual([]);
		expect(h.dismissed).toStrictEqual([]);
	},
);

contractTest(
	'jobs whose timers a reboot dropped get new ones; a missed time fires soon',
	async state => {
		const store = state.daos.schedules;
		const missed: Job = {
			...afterLimit,
			at: new Date(2026, 10, 9, 8).toISOString(),
		};
		const loaded: Job = {...keepGoing(), id: 'loaded'};
		await store.save(missed);
		await store.save(loaded);
		await store.save(keepGoing());
		const created: Array<[Job, TimerWhen]> = [];
		const rearmed = await rearmMissingTimers(
			store,
			{
				exists: job => job.id === 'loaded',
				create(job, when) {
					created.push([job, when]);
				},
			},
			NOW,
		);
		expect(rearmed.map(job => job.id).sort()).toStrictEqual(['al', 'kg']);
		expect(created.find(([job]) => job.id === 'al')).toStrictEqual([
			{...missed, at: new Date(NOW.getTime() + 60_000).toISOString(), arm: 1},
			{at: new Date(NOW.getTime() + 60_000)},
		]);
		expect(store.load('al')).toMatchObject({arm: 1});
		expect(created.find(([job]) => job.id === 'kg')?.[1]).toStrictEqual({
			everySeconds: 600,
		});
	},
);

test('--at takes a time of day as its next occurrence', () => {
	expect(parseWhen('13:15', NOW)).toStrictEqual(new Date(2026, 10, 9, 13, 15));
	expect(parseWhen('09:00', NOW)).toStrictEqual(new Date(2026, 10, 10, 9, 0));
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

test('a systemd one-shot fires at local time and unloads once it has', () => {
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
	expect(calls[0]).toStrictEqual([
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
	expect(systemdUnitName('a.b', job)).toBe('pappardelle-a.b-ab12');
	expect(systemdUnitName('a.b', {...job, arm: 2})).toBe(
		'pappardelle-a.b-ab12-2',
	);
	expect(onCalendar(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
});

test('a launchd agent runs the same command on the calendar date', () => {
	const plist = launchdPlist(
		context(),
		{kind: 'at', id: 'ab12', key: 'STA-1', at: '', message: 'hi', arm: 0},
		{at: new Date(2026, 10, 14, 7, 51)},
	);
	expect(plist).toMatch(
		/<key>Label<\/key>\n\t<string>dev\.pappardelle\.my_repo\.ab12<\/string>/,
	);
	expect(plist).toMatch(
		/<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/opt\/pappardelle\/dist\/pappardelle<\/string>\n\t\t<string>schedule<\/string>\n\t\t<string>fire<\/string>\n\t\t<string>ab12<\/string>/,
	);
	expect(plist).toMatch(
		/<key>Month<\/key>\n\t\t<integer>11<\/integer>\n\t\t<key>Day<\/key>\n\t\t<integer>14<\/integer>\n\t\t<key>Hour<\/key>\n\t\t<integer>7<\/integer>\n\t\t<key>Minute<\/key>\n\t\t<integer>51<\/integer>/,
	);
	expect(plist).toMatch(
		/<key>WorkingDirectory<\/key>\n\t<string>\/src\/repo<\/string>/,
	);
});

test('a launchd time with seconds fires at the start of the next minute', () => {
	const plist = launchdPlist(
		context(),
		{kind: 'at', id: 'ab12', key: 'STA-1', at: '', message: 'hi', arm: 0},
		{at: new Date(2026, 10, 14, 7, 51, 20)},
	);
	expect(plist).toMatch(/<key>Minute<\/key>\n\t\t<integer>52<\/integer>/);
});

// ============================================================================
// The store
// ============================================================================

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

const atJob: Job = {
	kind: 'at',
	id: 'at1',
	key: 'STA-2',
	at: NOW.toISOString(),
	message: 'run the review',
	arm: 0,
};

const repoDir = (state: TestState) =>
	path.join(state.stateDir, 'repos', 'repo');
const jobFile = (state: TestState, id: string) =>
	path.join(repoDir(state), 'schedules', `${id}.json`);
const queueFile = (state: TestState, key: string) =>
	path.join(repoDir(state), 'queued', `${encodeURIComponent(key)}.txt`);

const byId = (jobs: Job[]) =>
	[...jobs].sort((a, b) => a.id.localeCompare(b.id));

contractTest(
	'a job of each kind is saved, listed, replaced and deleted',
	async state => {
		const store = state.daos.schedules;
		expect(store.load('kg')).toBe(null);
		expect(store.list()).toStrictEqual([]);
		const jobs = [atJob, afterLimit, keepGoing('2026-11-10T08:00:00.000Z')];
		for (const job of jobs) await store.save(job);
		for (const job of jobs) expect(store.load(job.id)).toStrictEqual(job);
		expect(byId(store.list())).toStrictEqual(byId(jobs));

		await store.save({...atJob, at: '2026-11-09T13:00:00.000Z', arm: 1});
		expect(store.load('at1')).toMatchObject({
			at: '2026-11-09T13:00:00.000Z',
			arm: 1,
		});
		await store.save({...keepGoing(), idleChecks: 1});
		expect(store.load('kg')).toStrictEqual({...keepGoing(), idleChecks: 1});

		await store.delete('at1');
		expect(store.load('at1')).toBe(null);
		expect(fs.existsSync(jobFile(state, 'at1'))).toBe(false);
		expect(
			store
				.list()
				.map(job => job.id)
				.sort(),
		).toStrictEqual(['al', 'kg']);
		await store.delete('never-saved');
	},
);

contractTest(
	'a job file written or removed by another writer is what is read next',
	async state => {
		const store = state.daos.schedules;
		await store.save(atJob);
		expect(store.list()).toStrictEqual([atJob]);
		// A timer service running without the database re-arms the job, and
		// another saves a second one.
		const rearmed = {...atJob, arm: 3};
		fs.writeFileSync(jobFile(state, 'at1'), JSON.stringify(rearmed));
		fs.writeFileSync(jobFile(state, 'kg'), JSON.stringify(keepGoing()));
		expect(store.load('at1')).toStrictEqual(rearmed);
		expect(byId(store.list())).toStrictEqual(byId([rearmed, keepGoing()]));
		fs.rmSync(jobFile(state, 'at1'));
		expect(store.load('at1')).toBe(null);
		expect(store.list()).toStrictEqual([keepGoing()]);
	},
);

contractTest(
	'a queued message is kept per space until it is cleared',
	async state => {
		const store = state.daos.schedules;
		expect(store.queued('STA-1')).toBe(null);
		await store.queue('STA-1', 'first\nwith a second line');
		await store.queue('team/space 2', 'other');
		await store.queue('STA-1', 'replaced');
		expect(store.queued('STA-1')).toBe('replaced');
		expect(store.queued('team/space 2')).toBe('other');
		expect(fs.readFileSync(queueFile(state, 'team/space 2'), 'utf8')).toBe(
			'other',
		);
		await store.clearQueued('STA-1');
		expect(store.queued('STA-1')).toBe(null);
		expect(fs.existsSync(queueFile(state, 'STA-1'))).toBe(false);
		expect(store.queued('team/space 2')).toBe('other');

		// A process without the database queues and clears through the files.
		fs.writeFileSync(queueFile(state, 'STA-1'), 'from a file');
		expect(store.queued('STA-1')).toBe('from a file');
		fs.rmSync(queueFile(state, 'team/space 2'));
		expect(store.queued('team/space 2')).toBe(null);
	},
);

test('the two stores leave the same job and queue files for the same history', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState({sqlite});
		const store = state.daos.schedules;
		await store.save(atJob);
		await store.save(keepGoing('2026-11-10T08:00:00.000Z'));
		await store.save(afterLimit);
		await store.save({...afterLimit, arm: 1});
		await store.delete('at1');
		await store.queue('STA-1', 'next');
		await store.queue('STA-2', 'gone');
		await store.clearQueued('STA-2');
		const read = (dir: string) =>
			Object.fromEntries(
				fs
					.readdirSync(path.join(repoDir(state), dir))
					.sort()
					.map(file => [
						file,
						fs.readFileSync(path.join(repoDir(state), dir, file), 'utf8'),
					]),
			);
		files.push({schedules: read('schedules'), queued: read('queued')});
	}

	expect(files[0]).toStrictEqual(files[1]);
	expect(Object.keys(files[0]!.schedules)).toStrictEqual([
		'al.json',
		'kg.json',
	]);
	expect(files[0]!.queued).toStrictEqual({'STA-1.txt': 'next'});
});

// `schedule fire` runs from a timer service, a process of its own.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a job saved by one process is read, re-armed and removed by another`, async () => {
		const state = testState({sqlite});
		const store = state.daos.schedules;
		await store.save(atJob);
		await store.save(keepGoing());
		await store.queue('STA-2', 'queued for the timer');
		const {stdout} = await exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {schedules} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}, sqlite: ${sqlite}});
const job = schedules.load('at1');
const queued = schedules.queued(job.key);
await schedules.save({...job, arm: job.arm + 1});
await schedules.delete('kg');
await schedules.clearQueued(job.key);
console.log(JSON.stringify({job, queued}));
`,
			],
			{timeout: 30_000},
		);
		expect(JSON.parse(stdout)).toStrictEqual({
			job: atJob,
			queued: 'queued for the timer',
		});
		expect(store.list()).toStrictEqual([{...atJob, arm: 1}]);
		expect(store.queued('STA-2')).toBe(null);
	});
}
