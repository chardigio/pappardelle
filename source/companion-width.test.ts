import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
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

const widthsFile = (state: TestState) =>
	path.join(state.stateDir, 'repos', 'repo', 'companion-widths.json');

const requestFiles = (state: TestState) => {
	try {
		return fs.readdirSync(
			path.join(state.stateDir, 'repos', 'repo', 'companion-requests'),
		);
	} catch {
		return [];
	}
};

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

contractTest(
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

contractTest('invalid entries in the store are ignored', state => {
	const file = widthsFile(state);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, JSON.stringify({A: 60, B: 'wide', C: -4, D: '25%'}));
	expect(state.daos.companionWidths.all()).toStrictEqual({A: 60, D: '25%'});
});

contractTest(
	'a width stored by a process that only writes the file is read next',
	async state => {
		const widths = state.daos.companionWidths;
		await widths.set('A', 60);
		expect(widths.get('A')).toBe(60);
		fs.writeFileSync(widthsFile(state), JSON.stringify({A: 44, B: '20%'}));
		expect(widths.all()).toStrictEqual({A: 44, B: '20%'});
		await widths.set('C', 30);
		expect(
			JSON.parse(fs.readFileSync(widthsFile(state), 'utf8')),
		).toStrictEqual({
			A: 44,
			B: '20%',
			C: 30,
		});
	},
);

contractTest('concurrent writers to different spaces all land', async state => {
	const widths = state.daos.companionWidths;
	const keys = Array.from({length: 12}, (_, i) => `S-${i}`);
	await Promise.all(keys.map(async (key, i) => widths.set(key, 30 + i)));
	expect(Object.keys(widths.all()).sort()).toStrictEqual([...keys].sort());
});

// The CLI stores a width while the TUI stores another space's after a drag.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: two processes storing widths both keep theirs`, async () => {
		const state = testState({sqlite});
		const worker = async (prefix: string) =>
			exec(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {companionWidths} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}, sqlite: ${sqlite}});
for (let i = 0; i < 15; i++) await companionWidths.set(${JSON.stringify(prefix)} + i, 30 + i);
`,
				],
				{timeout: 30_000},
			);
		await Promise.all([worker('A-'), worker('B-')]);
		const stored = state.daos.companionWidths.all();
		expect(Object.keys(stored).length).toBe(30);
		expect(
			JSON.parse(fs.readFileSync(widthsFile(state), 'utf8')),
		).toStrictEqual(stored);
	});
}

test('the two stores leave the same widths file for the same history', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState({sqlite});
		const widths = state.daos.companionWidths;
		await widths.set('missing', null);
		files.push(fs.readFileSync(widthsFile(state), 'utf8'));
		await widths.set('A', 60);
		await widths.set('B', '30%');
		await widths.set('C', 45);
		await widths.set('A', 62);
		await widths.set('B', null);
		await widths.set('C', 45);
		files.push(fs.readFileSync(widthsFile(state), 'utf8'));
	}

	expect(files.slice(0, 2)).toStrictEqual(files.slice(2));
	expect(files[1]).toBe('{"A":62,"C":45}\n');
});

contractTest(
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
		expect(requestFiles(state)).toStrictEqual([]);
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
	contractTest(
		`the TUI's ${name} answer comes back to the CLI`,
		async state => {
			const seen = fakeTui(state, () => answer);
			const result = await requestCompanionWidth({
				...requestOptions(state),
				space: 'A',
				width: 50,
				tuiIsRunning: () => true,
			});
			expect(result).toStrictEqual(expected);
			expect(seen.includes('width:A')).toBe(true);
		},
	);
}

contractTest(
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

contractTest(
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

contractTest(
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

contractTest(
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

contractTest('quick requests each get their own answer', async state => {
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
	expect(requestFiles(state)).toStrictEqual([]);
});

contractTest('a layout request leaves the widths store alone', async state => {
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

contractTest(
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
		expect(requestFiles(state)).toStrictEqual([]);
		expect(companionRequests.answerTo(id)).toBe(null);
	},
);

contractTest(
	'a request and its answer are files while the CLI waits, and gone after',
	async state => {
		const {companionRequests} = state.daos;
		const request = {id: 'r1', space: 'A', kind: 'width'} as const;
		await companionRequests.send(request);
		await companionRequests.answer({id: 'r1', result: 'applied', columns: 48});
		expect(requestFiles(state).sort()).toStrictEqual([
			'r1.ack.json',
			'r1.json',
		]);
		const dir = path.join(
			state.stateDir,
			'repos',
			'repo',
			'companion-requests',
		);
		expect(
			JSON.parse(fs.readFileSync(path.join(dir, 'r1.json'), 'utf8')),
		).toStrictEqual(request);
		expect(
			JSON.parse(fs.readFileSync(path.join(dir, 'r1.ack.json'), 'utf8')),
		).toStrictEqual({id: 'r1', result: 'applied', columns: 48});
		expect(companionRequests.answerTo('r1')).toStrictEqual({
			id: 'r1',
			result: 'applied',
			columns: 48,
		});
		// Asking again keeps the answer that already arrived.
		await companionRequests.send(request);
		expect(companionRequests.answerTo('r1')?.result).toBe('applied');
		await companionRequests.withdraw('r1');
		expect(requestFiles(state)).toStrictEqual([]);
		expect(companionRequests.answerTo('r1')).toBe(null);
	},
);

// The TUI and the CLI are different processes.
test('sqlite: a request made by another process reaches the watcher, and its answer the other process', async () => {
	const state = testState({sqlite: true});
	const seen = fakeTui(state, () => ({result: 'applied', columns: 51}));
	const {stdout} = await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
import {requestCompanionWidth} from ${JSON.stringify(new URL('companion-width.ts', import.meta.url).href)};
const daos = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(state.stateDir)}, sqlite: true});
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
	expect(
		openStateDb(stateDbPath(state.stateDir))
			.db.query('SELECT * FROM companion_requests')
			.all(),
	).toStrictEqual([]);
	expect(requestFiles(state)).toStrictEqual([]);
});
