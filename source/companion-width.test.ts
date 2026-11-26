import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {storeTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {watcherReady} from '../test/helpers/wait.ts';
import {
	requestCompanionLayout,
	requestCompanionWidth,
	type LayoutAck,
} from './companion-width.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

/** The ids of the requests still stored. */
const requestRows = (state: TestState) =>
	openStateDb(stateDbPath(state.stateDir))
		.db.query<{id: string}, []>('SELECT id FROM companion_requests')
		.all()
		.map(row => row.id);

/** A running TUI that answers every request it sees with `answer`. */
function fakeTui(
	state: TestState,
	answer: (space: string) => Omit<LayoutAck, 'id'>,
): string[] {
	const seen: string[] = [];
	const {companionRequests} = state.daos;
	const unwatch = companionRequests.watch(request => {
		seen.push(`${request.kind}:${request.space}`);
		void companionRequests.answer({id: request.id, ...answer(request.space)});
	});
	teardown(unwatch);
	return seen;
}

const requestOptions = (state: TestState) => ({
	widths: state.daos.companionWidths,
	requests: state.daos.companionRequests,
});

storeTest(
	'widths are stored per space and reset removes only that space',
	async state => {
		const widths = state.daos.companionWidths;
		expect(widths.get('A')).toBe(null);
		await widths.set('A', 60);
		await widths.set('B', '30%');
		await widths.set('C', '12.5%');
		expect(widths.get('A')).toBe(60);
		expect(widths.get('C')).toBe('12.5%');
		await widths.set('A', null);
		expect(widths.all()).toStrictEqual({B: '30%', C: '12.5%'});
		expect(widths.get('A')).toBe(null);
	},
);

storeTest('concurrent writers to different spaces all land', async state => {
	const widths = state.daos.companionWidths;
	const keys = Array.from({length: 12}, (_, i) => `S-${i}`);
	await Promise.all(keys.map(async (key, i) => widths.set(key, 30 + i)));
	expect(Object.keys(widths.all()).sort()).toStrictEqual([...keys].sort());
});

// The CLI stores a width while the TUI stores another space's after a drag.
test('two processes storing widths both keep theirs', async () => {
	const state = testState();
	const worker = async (prefix: string) =>
		exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {companionWidths} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}});
for (let i = 0; i < 15; i++) await companionWidths.set(${JSON.stringify(prefix)} + i, 30 + i);
`,
			],
			{timeout: 30_000},
		);
	await Promise.all([worker('A-'), worker('B-')]);
	expect(Object.keys(state.daos.companionWidths.all()).length).toBe(30);
});

storeTest(
	'with no TUI running the width is stored and says so',
	async state => {
		const result = await requestCompanionWidth({
			...requestOptions(state),
			space: 'A',
			width: 50,
			tuiIsRunning: () => false,
		});
		expect(result).toStrictEqual({outcome: 'no-tui'});
		expect(state.daos.companionWidths.get('A')).toBe(50);
		expect(requestRows(state)).toStrictEqual([]);
	},
);

for (const [name, answer, expected] of [
	[
		'applied',
		{result: 'applied', columns: 48},
		{outcome: 'applied', columns: 48},
	],
	['stored', {result: 'stored'}, {outcome: 'stored'}],
	['failed', {result: 'failed'}, {outcome: 'failed'}],
	['no-pane', {result: 'no-pane'}, {outcome: 'no-pane'}],
	['deferred', {result: 'deferred'}, {outcome: 'deferred'}],
] as const) {
	storeTest(`the TUI's ${name} answer comes back to the CLI`, async state => {
		const seen = fakeTui(state, () => answer);
		const result = await requestCompanionWidth({
			...requestOptions(state),
			space: 'A',
			width: 50,
			tuiIsRunning: () => true,
		});
		expect(result).toStrictEqual(expected);
		expect(seen.includes('width:A')).toBe(true);
	});
}

storeTest(
	'an applied answer without the column width is a failure',
	async state => {
		fakeTui(state, () => ({result: 'applied'}));
		expect(
			await requestCompanionWidth({
				...requestOptions(state),
				space: 'A',
				width: 50,
				tuiIsRunning: () => true,
			}),
		).toStrictEqual({outcome: 'failed'});
	},
);

storeTest(
	'a TUI that never answers ends in no-ack after the retries',
	async state => {
		const {companionRequests} = state.daos;
		let made = 0;
		const result = await requestCompanionWidth({
			widths: state.daos.companionWidths,
			requests: {
				async send(request) {
					made++;
					await companionRequests.send(request);
				},
				answerTo: id => companionRequests.answerTo(id),
				withdraw: async id => companionRequests.withdraw(id),
				watch: onRequest => companionRequests.watch(onRequest),
				answer: async ack => companionRequests.answer(ack),
			},
			space: 'A',
			width: 50,
			tuiIsRunning: () => true,
			attemptMs: 20,
			attempts: 3,
			pollMs: 5,
		});
		expect(result).toStrictEqual({outcome: 'no-ack'});
		expect(made).toBe(3);
		expect(state.daos.companionWidths.get('A')).toBe(50);
	},
);

storeTest(
	'a TUI that missed the request answers when it is made again',
	async state => {
		const {companionRequests} = state.daos;
		// The first time a request is reported is dropped, as on a busy machine.
		const reported = new Set<string>();
		const unwatch = companionRequests.watch(request => {
			if (!reported.has(request.id)) {
				reported.add(request.id);
				return;
			}

			void companionRequests.answer({id: request.id, result: 'stored'});
		});
		teardown(unwatch);
		expect(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'A',
				tuiIsRunning: () => true,
				attemptMs: 200,
				attempts: 5,
				pollMs: 5,
			}),
		).toStrictEqual({outcome: 'stored'});
	},
);

storeTest(
	'a request left by a CLI that stopped waiting is not handed to a TUI that starts later',
	async state => {
		const {companionRequests} = state.daos;
		await companionRequests.send({id: 'left', space: 'A', kind: 'layout'});
		const seen = new Set<string>();
		const unwatch = companionRequests.watch(request => {
			seen.add(request.id);
			void companionRequests.answer({id: request.id, result: 'stored'});
		});
		teardown(unwatch);
		expect(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'B',
				tuiIsRunning: () => true,
				pollMs: 5,
			}),
		).toStrictEqual({outcome: 'stored'});
		expect(seen.size).toBe(1);
		expect(seen.has('left')).toBe(false);
		expect(companionRequests.answerTo('left')).toBe(null);
	},
);

storeTest('quick requests each get their own answer', async state => {
	const {companionRequests} = state.daos;
	// Answers each request once, after a pause long enough for the other
	// request to be made meanwhile.
	const handled = new Set<string>();
	const unwatch = companionRequests.watch(request => {
		if (handled.has(request.id)) return;
		handled.add(request.id);
		setTimeout(() => {
			void companionRequests.answer({
				id: request.id,
				result: request.space === 'A' ? 'applied' : 'stored',
			});
		}, 40);
	});
	teardown(unwatch);
	const request = async (space: string) =>
		requestCompanionLayout({
			requests: companionRequests,
			space,
			tuiIsRunning: () => true,
			attemptMs: 300,
			pollMs: 5,
		});
	const results = await Promise.all([request('A'), request('B')]);
	expect(results).toStrictEqual([{outcome: 'applied'}, {outcome: 'stored'}]);
	expect(requestRows(state)).toStrictEqual([]);
});

storeTest('a layout request leaves the widths store alone', async state => {
	await state.daos.companionWidths.set('A', 50);
	const seen = fakeTui(state, () => ({result: 'no-pane'}));
	expect(
		await requestCompanionLayout({
			requests: state.daos.companionRequests,
			space: 'A',
			tuiIsRunning: () => true,
		}),
	).toStrictEqual({outcome: 'no-pane'});
	expect([...new Set(seen)]).toStrictEqual(['layout:A']);
	expect(state.daos.companionWidths.all()).toStrictEqual({A: 50});
});

storeTest(
	'an answer to a request the CLI stopped waiting for is not kept',
	async state => {
		const {companionRequests} = state.daos;
		const late = new Map<string, () => Promise<void>>();
		const unwatch = companionRequests.watch(request => {
			late.set(request.id, async () =>
				companionRequests.answer({id: request.id, result: 'applied'}),
			);
		});
		teardown(unwatch);
		await watcherReady();
		expect(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'A',
				tuiIsRunning: () => true,
				// Past the watchers' 2-second fallback poll: macOS can deliver the
				// change later than a shorter wait.
				attemptMs: 3000,
				attempts: 1,
				pollMs: 5,
			}),
		).toStrictEqual({outcome: 'no-ack'});
		expect(late.size).toBe(1);
		const [[id, answer]] = [...late] as [[string, () => Promise<void>]];
		await answer();
		expect(requestRows(state)).toStrictEqual([]);
		expect(companionRequests.answerTo(id)).toBe(null);
	},
);

storeTest(
	'a request keeps its answer while the CLI waits, and both are gone once withdrawn',
	async state => {
		const {companionRequests} = state.daos;
		const request = {id: 'r1', space: 'A', kind: 'width'} as const;
		await companionRequests.send(request);
		expect(companionRequests.answerTo('r1')).toBe(null);
		await companionRequests.answer({id: 'r1', result: 'applied', columns: 48});
		expect(companionRequests.answerTo('r1')).toStrictEqual({
			id: 'r1',
			result: 'applied',
			columns: 48,
		});
		// Asking again keeps the answer that already arrived.
		await companionRequests.send(request);
		expect(companionRequests.answerTo('r1')?.result).toBe('applied');
		await companionRequests.withdraw('r1');
		expect(requestRows(state)).toStrictEqual([]);
		expect(companionRequests.answerTo('r1')).toBe(null);
	},
);

// The TUI and the CLI are different processes.
test('a request made by another process reaches the watcher, and its answer the other process', async () => {
	const state = testState();
	const seen = fakeTui(state, () => ({result: 'applied', columns: 51}));
	const {stdout} = await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
import {requestCompanionWidth} from ${JSON.stringify(new URL('companion-width.ts', import.meta.url).href)};
const daos = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}});
console.log(JSON.stringify(await requestCompanionWidth({
	widths: daos.companionWidths, requests: daos.companionRequests,
	space: 'A', width: '40%', tuiIsRunning: () => true,
})));
`,
		],
		{timeout: 30_000},
	);
	expect(JSON.parse(stdout)).toStrictEqual({outcome: 'applied', columns: 51});
	expect(seen.includes('width:A')).toBe(true);
	expect(state.daos.companionWidths.get('A')).toBe('40%');
	expect(requestRows(state)).toStrictEqual([]);
});
