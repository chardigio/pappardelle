import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {Database} from 'bun:sqlite';
import {test, expect} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {parseAgentScreen, parseAgyQuota} from './agent-screen.ts';
import {
	classifyAgent,
	type AgentState,
	type AgentStateReport,
} from './agent-state.ts';
import {
	fireJob,
	parseWhen,
	rearmMissingTimers,
	RETRY_MS,
	type TimerWhen,
	type Job,
	type SendOutcome,
} from './schedule.ts';
import {SqliteScheduleDao} from './schedule-sqlite.ts';
import {
	launchdPlist,
	onCalendar,
	systemdBackend,
	systemdUnitName,
	type TimerContext,
} from './schedule-timers.ts';
import {closeStateDb, openStateDb} from './state-db.ts';

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
		agyDialog: null,
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
				async dismissDialog(key) {
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

const keepGoing = (
	until: string | null = null,
): Extract<Job, {kind: 'keep_going'}> => ({
	kind: 'keep_going',
	id: 'kg',
	key: 'STA-1',
	everySeconds: 600,
	nudge: 'keep going',
	until,
	idleChecks: 0,
});

storeTest(
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

storeTest('working between idle checks starts the count over', async state => {
	const h = harness(state, [report('idle'), report('working'), report('idle')]);
	await h.store.save(keepGoing());
	await h.fire(keepGoing());
	expect(await h.fire(keepGoing())).toBe('skipped_working');
	expect(await h.fire(keepGoing())).toBe('waiting');
	expect(h.sent).toStrictEqual([]);
});

storeTest(
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

storeTest('a queued message survives a send that was refused', async state => {
	const h = harness(state, [report('idle')], 'draft');
	await h.store.save({...keepGoing(), idleChecks: 1});
	await h.store.queue('STA-1', 'the next step');
	expect(await h.fire(keepGoing())).toBe('skipped_draft');
	expect(h.store.queued('STA-1')).toBe('the next step');
});

storeTest(
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

storeTest('keep_going never types over a draft', async state => {
	const h = harness(state, [report('draft')]);
	await h.store.save({...keepGoing(), idleChecks: 1});
	expect(await h.fire(keepGoing())).toBe('skipped_draft');
	expect(h.sent).toStrictEqual([]);
});

storeTest('keep_going past its end removes itself', async state => {
	const job = keepGoing(new Date(2026, 10, 9, 11, 0).toISOString());
	const h = harness(state, []);
	await h.store.save(job);
	expect(await h.fire(job)).toBe('expired');
	expect(h.store.list()).toStrictEqual([]);
	expect(h.removed).toStrictEqual(['kg']);
});

storeTest(
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

storeTest(
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

storeTest(
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
			deferReason: 'draft',
			deferCount: 1,
		});
		// A second refusal increments deferCount and persists across JSON & SQLite.
		expect(await h.fire(afterLimit)).toBe('retrying');
		expect(h.store.load('al')).toMatchObject({
			arm: 2,
			deferReason: 'draft',
			deferCount: 2,
		});
		expect(h.store.queued('STA-1')).toBe('the next step');
	},
);

storeTest(
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

storeTest(
	'a one-shot for a space with no agent session is dropped',
	async state => {
		const h = harness(state, [report('no_session')]);
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit)).toBe('no_session');
		expect(h.sent).toStrictEqual([]);
		expect(h.store.list()).toStrictEqual([]);
	},
);

storeTest(
	'schedules never send into an exited pane: keep_going waits and one-shots drop',
	async state => {
		const kg = harness(state, [report('exited')]);
		await kg.store.save({...keepGoing(), idleChecks: 1});
		expect(await kg.fire(keepGoing())).toBe('waiting');
		expect(kg.sent).toStrictEqual([]);
		expect(kg.store.load('kg')).toMatchObject({
			kind: 'keep_going',
			idleChecks: 0,
		});

		const oneShot = harness(state, [report('exited')]);
		await oneShot.store.save(atJob);
		expect(await oneShot.fire(atJob)).toBe('exited');
		expect(oneShot.sent).toStrictEqual([]);
		expect(oneShot.store.load('at1')).toBe(null);
		expect(oneShot.removed).toStrictEqual(['at1']);
	},
);

storeTest(
	'a wake-up keeps the current model when Codex offers to switch, then sends',
	async state => {
		const atLimit = {
			...report('dialog', new Date(2026, 10, 9, 11, 58)),
			codexDialog: {
				kind: 'model_switch' as const,
				title: 'Switch?',
				options: 2,
				selected: 1,
			},
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

storeTest(
	'a wake-up dismisses agy Models & Quota panel with Escape before sending',
	async state => {
		const openQuota = {
			...report('dialog'),
			agyDialog: 'quota_panel' as const,
		};
		const exhaustedQuota = {
			...report('usage_limit', new Date(2026, 10, 9, 11, 58)),
			agyDialog: 'quota_panel' as const,
		};
		const h = harness(state, [openQuota, exhaustedQuota, openQuota, openQuota]);
		const atJob: Job = {
			kind: 'at',
			id: 'at-q',
			key: 'STA-1',
			at: NOW.toISOString(),
			message: 'resume work',
			arm: 0,
		};
		await h.store.save(atJob);
		expect(await h.fire(atJob)).toBe('sent');
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit)).toBe('sent');
		await h.store.save(keepGoing());
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(await h.fire(keepGoing())).toBe('sent');
		expect(h.dismissed).toStrictEqual(['STA-1', 'STA-1', 'STA-1']);
		expect(h.sent).toStrictEqual(['resume work', 'continue', 'keep going']);

		// When the agent is working behind an open Models & Quota panel, keep_going skips without pressing Escape.
		const workingQuota = {
			...report('dialog'),
			agyDialog: 'quota_panel' as const,
			status: {
				status: 'working' as const,
				app: 'antigravity',
				source: 'osc' as const,
			},
		};
		const working = harness(state, [workingQuota]);
		await working.store.save({...keepGoing(), idleChecks: 1});
		expect(await working.fire(keepGoing())).toBe('skipped_working');
		expect(working.dismissed).toStrictEqual([]);
		expect(working.sent).toStrictEqual([]);
	},
);

test('a schedules table from before the defer columns keeps its jobs and stores deferrals', async () => {
	const dir = tempDir('schedule-migrate-');
	const dbPath = path.join(dir, 'state.sqlite');
	const raw = new Database(dbPath, {create: true});
	raw.run(`CREATE TABLE json_sync (
		path TEXT PRIMARY KEY,
		ino TEXT NOT NULL,
		size INTEGER NOT NULL,
		mtime_ns TEXT NOT NULL,
		malformed INTEGER NOT NULL DEFAULT 0 CHECK (malformed IN (0, 1))
	) STRICT`);
	raw.run(`CREATE TABLE schedules (
		repo TEXT NOT NULL,
		id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('at', 'after_limit', 'keep_going')),
		key TEXT NOT NULL,
		at TEXT,
		message TEXT,
		arm INTEGER,
		every_seconds INTEGER,
		nudge TEXT,
		until TEXT,
		idle_checks INTEGER,
		PRIMARY KEY (repo, id)
	) STRICT`);
	raw.run(
		`INSERT INTO schedules (repo, id, kind, key, at, message, arm)
		VALUES ('repo', 'old1', 'at', 'STA-1', ?, 'ping', 0)`,
		[NOW.toISOString()],
	);
	raw.run('PRAGMA user_version = 7');
	raw.close();

	const stateDb = openStateDb(dbPath);
	teardown(() => {
		closeStateDb(dbPath);
	});
	expect(
		stateDb.db
			.query<
				{defer_reason: string | null; defer_count: number | null},
				[string]
			>('SELECT defer_reason, defer_count FROM schedules WHERE id = ?')
			.get('old1'),
	).toStrictEqual({defer_reason: null, defer_count: null});

	const dao = new SqliteScheduleDao(() => stateDb, 'repo');
	expect(dao.load('old1')).toStrictEqual({
		kind: 'at',
		id: 'old1',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'ping',
		arm: 0,
	});

	await dao.save({
		kind: 'at',
		id: 'old1',
		key: 'STA-1',
		at: NOW.toISOString(),
		message: 'ping',
		arm: 1,
		deferReason: 'prompt',
		deferCount: 2,
	});
	expect(dao.load('old1')).toMatchObject({
		arm: 1,
		deferReason: 'prompt',
		deferCount: 2,
	});
});

storeTest(
	'keep_going leaves any other Codex dialog to a person',
	async state => {
		const h = harness(state, [
			{
				...report('dialog'),
				codexDialog: {kind: 'other', title: 'Trust?', options: 2, selected: 1},
			},
		]);
		await h.store.save({...keepGoing(), idleChecks: 1});
		expect(await h.fire(keepGoing())).toBe('waiting');
		expect(h.sent).toStrictEqual([]);
		expect(h.dismissed).toStrictEqual([]);
	},
);

storeTest(
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

const byId = (jobs: Job[]) =>
	[...jobs].sort((a, b) => a.id.localeCompare(b.id));

storeTest(
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
		expect(
			store
				.list()
				.map(job => job.id)
				.sort(),
		).toStrictEqual(['al', 'kg']);
		await store.delete('never-saved');
	},
);

storeTest(
	'a queued message is kept per space until it is cleared',
	async state => {
		const store = state.daos.schedules;
		expect(store.queued('STA-1')).toBe(null);
		await store.queue('STA-1', 'first\nwith a second line');
		await store.queue('team/space 2', 'other');
		await store.queue('STA-1', 'replaced');
		expect(store.queued('STA-1')).toBe('replaced');
		expect(store.queued('team/space 2')).toBe('other');
		await store.clearQueued('STA-1');
		expect(store.queued('STA-1')).toBe(null);
		expect(store.queued('team/space 2')).toBe('other');
	},
);

// `schedule fire` runs from a timer service, a process of its own.
test('a job saved by one process is read, re-armed and removed by another', async () => {
	const state = testState();
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
const {schedules} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}});
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

storeTest('keep_going skips and at retries over an agy draft', async state => {
	const screen = parseAgentScreen(agentScreenFixture('agy-draft-normal'), NOW);
	const draftReport: AgentStateReport = {
		...report(classifyAgent(null, screen)),
		composer: screen.composer,
	};
	const kg = harness(state, [draftReport]);
	await kg.store.save({...keepGoing(), idleChecks: 1});
	expect(await kg.fire(keepGoing())).toBe('skipped_draft');
	expect(kg.sent).toStrictEqual([]);

	const atJobAgy: Job = {...atJob, id: 'at-agy', key: 'STA-1'};
	const at = harness(state, [draftReport], 'draft');
	await at.store.save(atJobAgy);
	expect(await at.fire(atJobAgy)).toBe('retrying');
	expect(at.timers[0]).toMatchObject({arm: 1});
});

storeTest(
	'after_limit with an agy ISO reset waits before reset and sends continue after',
	async state => {
		const before = new Date('2026-11-24T09:00:00Z');
		const after = new Date('2026-11-24T09:12:00Z');
		const quotaOutput = [
			'Gemini Models\tWeekly Limit Remaining\t98%\t2026-12-01T04:14:49Z',
			'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
		].join('\n');
		const beforeQuota = parseAgyQuota(quotaOutput, before);
		const afterQuota = parseAgyQuota(quotaOutput, after);
		const beforeReport: AgentStateReport = {
			...report('usage_limit'),
			usageLimit: beforeQuota.kind === 'limited' ? beforeQuota.limit : null,
		};
		const afterReport: AgentStateReport = {
			...report('usage_limit'),
			usageLimit: afterQuota.kind === 'limited' ? afterQuota.limit : null,
		};
		const h = harness(state, [beforeReport, afterReport]);
		await h.store.save(afterLimit);
		expect(await h.fire(afterLimit, before)).toBe('waiting');
		expect(h.timers[0]).toMatchObject({at: '2026-11-24T09:11:11.000Z'});
		expect(await h.fire(afterLimit, after)).toBe('sent');
		expect(h.sent).toStrictEqual(['continue']);
	},
);
