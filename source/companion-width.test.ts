import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
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
	t: {teardown: (fn: () => void) => void},
	state: TestState,
	answer: (space: string) => Omit<LayoutAck, 'id'>,
): string[] {
	const seen: string[] = [];
	const {companionRequests} = state.daos;
	const unwatch = companionRequests.watch(request => {
		seen.push(`${request.kind}:${request.space}`);
		void companionRequests.answer({id: request.id, ...answer(request.space)});
	});
	t.teardown(unwatch);
	return seen;
}

const requestOptions = (state: TestState) => ({
	widths: state.daos.companionWidths,
	requests: state.daos.companionRequests,
});

contractTest(
	'widths are stored per space and reset removes only that space',
	async (t, state) => {
		const widths = state.daos.companionWidths;
		t.is(widths.get('A'), null);
		await widths.set('A', 60);
		await widths.set('B', '30%');
		await widths.set('C', '12.5%');
		t.is(widths.get('A'), 60);
		t.is(widths.get('C'), '12.5%');
		await widths.set('A', null);
		t.deepEqual(widths.all(), {B: '30%', C: '12.5%'});
		t.is(widths.get('A'), null);
	},
);

contractTest('invalid entries in the store are ignored', (t, state) => {
	const file = widthsFile(state);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, JSON.stringify({A: 60, B: 'wide', C: -4, D: '25%'}));
	t.deepEqual(state.daos.companionWidths.all(), {A: 60, D: '25%'});
});

contractTest(
	'a width stored by a process that only writes the file is read next',
	async (t, state) => {
		const widths = state.daos.companionWidths;
		await widths.set('A', 60);
		t.is(widths.get('A'), 60);
		fs.writeFileSync(widthsFile(state), JSON.stringify({A: 44, B: '20%'}));
		t.deepEqual(widths.all(), {A: 44, B: '20%'});
		await widths.set('C', 30);
		t.deepEqual(JSON.parse(fs.readFileSync(widthsFile(state), 'utf8')), {
			A: 44,
			B: '20%',
			C: 30,
		});
	},
);

contractTest(
	'concurrent writers to different spaces all land',
	async (t, state) => {
		const widths = state.daos.companionWidths;
		const keys = Array.from({length: 12}, (_, i) => `S-${i}`);
		await Promise.all(keys.map(async (key, i) => widths.set(key, 30 + i)));
		t.deepEqual(Object.keys(widths.all()).sort(), [...keys].sort());
	},
);

// The CLI stores a width while the TUI stores another space's after a drag.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: two processes storing widths both keep theirs`, async t => {
		const state = testState(t, {sqlite});
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
		t.is(Object.keys(stored).length, 30);
		t.deepEqual(JSON.parse(fs.readFileSync(widthsFile(state), 'utf8')), stored);
	});
}

test('the two stores leave the same widths file for the same history', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState(t, {sqlite});
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

	t.deepEqual(files.slice(0, 2), files.slice(2));
	t.is(files[1], '{"A":62,"C":45}\n');
});

contractTest(
	'with no TUI running the width is stored and says so',
	async (t, state) => {
		const result = await requestCompanionWidth({
			...requestOptions(state),
			space: 'A',
			width: 50,
			tuiIsRunning: () => false,
		});
		t.deepEqual(result, {outcome: 'no-tui'});
		t.is(state.daos.companionWidths.get('A'), 50);
		t.deepEqual(requestFiles(state), []);
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
		async (t, state) => {
			const seen = fakeTui(t, state, () => answer);
			const result = await requestCompanionWidth({
				...requestOptions(state),
				space: 'A',
				width: 50,
				tuiIsRunning: () => true,
			});
			t.deepEqual(result, expected);
			t.true(seen.includes('width:A'));
		},
	);
}

contractTest(
	'an applied answer without the column width is a failure',
	async (t, state) => {
		fakeTui(t, state, () => ({result: 'applied'}));
		t.deepEqual(
			await requestCompanionWidth({
				...requestOptions(state),
				space: 'A',
				width: 50,
				tuiIsRunning: () => true,
			}),
			{outcome: 'failed'},
		);
	},
);

contractTest(
	'a TUI that never answers ends in no-ack after the retries',
	async (t, state) => {
		const started = Date.now();
		const result = await requestCompanionWidth({
			...requestOptions(state),
			space: 'A',
			width: 50,
			tuiIsRunning: () => true,
			attemptMs: 60,
			attempts: 3,
			pollMs: 10,
		});
		t.deepEqual(result, {outcome: 'no-ack'});
		t.true(Date.now() - started >= 180);
		t.is(state.daos.companionWidths.get('A'), 50);
	},
);

contractTest(
	'a TUI that missed the request answers when it is made again',
	async (t, state) => {
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
		t.teardown(unwatch);
		t.deepEqual(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'A',
				tuiIsRunning: () => true,
				attemptMs: 200,
				attempts: 5,
				pollMs: 5,
			}),
			{outcome: 'stored'},
		);
	},
);

contractTest(
	'a request left by a CLI that stopped waiting is not handed to a TUI that starts later',
	async (t, state) => {
		const {companionRequests} = state.daos;
		await companionRequests.send({id: 'left', space: 'A', kind: 'layout'});
		const seen = new Set<string>();
		const unwatch = companionRequests.watch(request => {
			seen.add(request.id);
			void companionRequests.answer({id: request.id, result: 'stored'});
		});
		t.teardown(unwatch);
		t.deepEqual(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'B',
				tuiIsRunning: () => true,
				pollMs: 5,
			}),
			{outcome: 'stored'},
		);
		t.is(seen.size, 1);
		t.false(seen.has('left'));
		t.is(companionRequests.answerTo('left'), null);
	},
);

contractTest('quick requests each get their own answer', async (t, state) => {
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
	t.teardown(unwatch);
	const request = async (space: string) =>
		requestCompanionLayout({
			requests: companionRequests,
			space,
			tuiIsRunning: () => true,
			attemptMs: 300,
			pollMs: 5,
		});
	const results = await Promise.all([request('A'), request('B')]);
	t.deepEqual(results, [{outcome: 'applied'}, {outcome: 'stored'}]);
	t.deepEqual(requestFiles(state), []);
});

contractTest(
	'a layout request leaves the widths store alone',
	async (t, state) => {
		await state.daos.companionWidths.set('A', 50);
		const seen = fakeTui(t, state, () => ({result: 'no-pane'}));
		t.deepEqual(
			await requestCompanionLayout({
				requests: state.daos.companionRequests,
				space: 'A',
				tuiIsRunning: () => true,
			}),
			{outcome: 'no-pane'},
		);
		t.deepEqual([...new Set(seen)], ['layout:A']);
		t.deepEqual(state.daos.companionWidths.all(), {A: 50});
	},
);

contractTest(
	'an answer to a request the CLI stopped waiting for is not kept',
	async (t, state) => {
		const {companionRequests} = state.daos;
		const late = new Map<string, () => Promise<void>>();
		const unwatch = companionRequests.watch(request => {
			late.set(request.id, async () =>
				companionRequests.answer({id: request.id, result: 'applied'}),
			);
		});
		t.teardown(unwatch);
		t.deepEqual(
			await requestCompanionLayout({
				requests: companionRequests,
				space: 'A',
				tuiIsRunning: () => true,
				attemptMs: 60,
				attempts: 1,
				pollMs: 5,
			}),
			{outcome: 'no-ack'},
		);
		t.is(late.size, 1);
		const [[id, answer]] = [...late] as [[string, () => Promise<void>]];
		await answer();
		t.deepEqual(requestFiles(state), []);
		t.is(companionRequests.answerTo(id), null);
	},
);

contractTest(
	'a request and its answer are files while the CLI waits, and gone after',
	async (t, state) => {
		const {companionRequests} = state.daos;
		const request = {id: 'r1', space: 'A', kind: 'width'} as const;
		await companionRequests.send(request);
		await companionRequests.answer({id: 'r1', result: 'applied', columns: 48});
		t.deepEqual(requestFiles(state).sort(), ['r1.ack.json', 'r1.json']);
		const dir = path.join(
			state.stateDir,
			'repos',
			'repo',
			'companion-requests',
		);
		t.deepEqual(
			JSON.parse(fs.readFileSync(path.join(dir, 'r1.json'), 'utf8')),
			request,
		);
		t.deepEqual(
			JSON.parse(fs.readFileSync(path.join(dir, 'r1.ack.json'), 'utf8')),
			{id: 'r1', result: 'applied', columns: 48},
		);
		t.deepEqual(companionRequests.answerTo('r1'), {
			id: 'r1',
			result: 'applied',
			columns: 48,
		});
		// Asking again keeps the answer that already arrived.
		await companionRequests.send(request);
		t.is(companionRequests.answerTo('r1')?.result, 'applied');
		await companionRequests.withdraw('r1');
		t.deepEqual(requestFiles(state), []);
		t.is(companionRequests.answerTo('r1'), null);
	},
);

// The TUI and the CLI are different processes.
test('sqlite: a request made by another process reaches the watcher, and its answer the other process', async t => {
	const state = testState(t, {sqlite: true});
	const seen = fakeTui(t, state, () => ({result: 'applied', columns: 51}));
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
	t.deepEqual(JSON.parse(stdout), {outcome: 'applied', columns: 51});
	t.true(seen.includes('width:A'));
	t.is(state.daos.companionWidths.get('A'), '40%');
	t.deepEqual(
		openStateDb(stateDbPath(state.stateDir))
			.db.query('SELECT * FROM companion_requests')
			.all(),
		[],
	);
	t.deepEqual(requestFiles(state), []);
});
