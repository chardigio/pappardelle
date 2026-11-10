import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'ava';
import {
	getCompanionWidth,
	readCompanionWidths,
	requestCompanionLayout,
	requestCompanionWidth,
	setCompanionWidth,
	watchLayoutRequests,
	writeLayoutAck,
	type LayoutAck,
} from './companion-width.ts';

const REPO = 'repo';

function tempBase(t: {teardown: (fn: () => void) => void}): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-width-'));
	t.teardown(() => {
		fs.rmSync(base, {recursive: true, force: true});
	});
	return base;
}

/** A running TUI that answers every request it sees with `answer`. */
function fakeTui(
	t: {teardown: (fn: () => void) => void},
	baseDir: string,
	answer: (space: string) => Omit<LayoutAck, 'id'>,
): string[] {
	const seen: string[] = [];
	const unwatch = watchLayoutRequests(
		REPO,
		request => {
			seen.push(`${request.kind}:${request.space}`);
			writeLayoutAck(REPO, {id: request.id, ...answer(request.space)}, baseDir);
		},
		baseDir,
	);
	t.teardown(unwatch);
	return seen;
}

test('widths are stored per space and reset removes only that space', async t => {
	const base = tempBase(t);
	await setCompanionWidth(REPO, 'A', 60, base);
	await setCompanionWidth(REPO, 'B', '30%', base);
	t.is(getCompanionWidth(REPO, 'A', base), 60);
	await setCompanionWidth(REPO, 'A', null, base);
	t.deepEqual(readCompanionWidths(REPO, base), {B: '30%'});
});

test('invalid entries in the store are ignored', t => {
	const base = tempBase(t);
	const file = path.join(base, 'repos', REPO, 'companion-widths.json');
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, JSON.stringify({A: 60, B: 'wide', C: -4, D: '25%'}));
	t.deepEqual(readCompanionWidths(REPO, base), {A: 60, D: '25%'});
});

test('concurrent writers to different spaces all land', async t => {
	const base = tempBase(t);
	const keys = Array.from({length: 12}, (_, i) => `S-${i}`);
	await Promise.all(
		keys.map(async (key, i) => setCompanionWidth(REPO, key, 30 + i, base)),
	);
	t.deepEqual(
		Object.keys(readCompanionWidths(REPO, base)).sort(),
		[...keys].sort(),
	);
});

test('with no TUI running the width is stored and says so', async t => {
	const base = tempBase(t);
	const result = await requestCompanionWidth({
		repoName: REPO,
		space: 'A',
		width: 50,
		tuiIsRunning: () => false,
		baseDir: base,
	});
	t.deepEqual(result, {outcome: 'no-tui'});
	t.is(getCompanionWidth(REPO, 'A', base), 50);
});

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
	test(`the TUI's ${name} answer comes back to the CLI`, async t => {
		const base = tempBase(t);
		const seen = fakeTui(t, base, () => answer);
		const result = await requestCompanionWidth({
			repoName: REPO,
			space: 'A',
			width: 50,
			tuiIsRunning: () => true,
			baseDir: base,
		});
		t.deepEqual(result, expected);
		t.true(seen.includes('width:A'));
	});
}

test('a TUI that never answers ends in no-ack after the retries', async t => {
	const base = tempBase(t);
	const started = Date.now();
	const result = await requestCompanionWidth({
		repoName: REPO,
		space: 'A',
		width: 50,
		tuiIsRunning: () => true,
		baseDir: base,
		attemptMs: 60,
		attempts: 3,
		pollMs: 10,
	});
	t.deepEqual(result, {outcome: 'no-ack'});
	t.true(Date.now() - started >= 180);
	t.is(getCompanionWidth(REPO, 'A', base), 50);
});

test('quick requests each get their own answer', async t => {
	const base = tempBase(t);
	// Answers each request once, after a pause long enough for the other
	// request to be written meanwhile.
	const handled = new Set<string>();
	const unwatch = watchLayoutRequests(
		REPO,
		request => {
			if (handled.has(request.id)) return;
			handled.add(request.id);
			setTimeout(() => {
				writeLayoutAck(
					REPO,
					{
						id: request.id,
						result: request.space === 'A' ? 'applied' : 'stored',
					},
					base,
				);
			}, 40);
		},
		base,
	);
	t.teardown(unwatch);
	const request = async (space: string) =>
		requestCompanionLayout({
			repoName: REPO,
			space,
			tuiIsRunning: () => true,
			baseDir: base,
			attemptMs: 300,
			pollMs: 5,
		});
	const results = await Promise.all([request('A'), request('B')]);
	t.deepEqual(results, [{outcome: 'applied'}, {outcome: 'stored'}]);
	t.deepEqual(
		fs.readdirSync(path.join(base, 'repos', REPO, 'companion-requests')),
		[],
	);
});

test('a layout request leaves the widths store alone', async t => {
	const base = tempBase(t);
	await setCompanionWidth(REPO, 'A', 50, base);
	const seen = fakeTui(t, base, () => ({result: 'no-pane'}));
	t.deepEqual(
		await requestCompanionLayout({
			repoName: REPO,
			space: 'A',
			tuiIsRunning: () => true,
			baseDir: base,
		}),
		{outcome: 'no-pane'},
	);
	t.deepEqual(seen, ['layout:A']);
	t.deepEqual(readCompanionWidths(REPO, base), {A: 50});
});

test('an answer to a request the CLI stopped waiting for is not left on disk', async t => {
	const base = tempBase(t);
	const late: Array<() => void> = [];
	const unwatch = watchLayoutRequests(
		REPO,
		request => {
			late.push(() => {
				writeLayoutAck(REPO, {id: request.id, result: 'applied'}, base);
			});
		},
		base,
	);
	t.teardown(unwatch);
	t.deepEqual(
		await requestCompanionLayout({
			repoName: REPO,
			space: 'A',
			tuiIsRunning: () => true,
			baseDir: base,
			attemptMs: 30,
			attempts: 1,
			pollMs: 5,
		}),
		{outcome: 'no-ack'},
	);
	for (const answer of late) answer();
	t.deepEqual(
		fs.readdirSync(path.join(base, 'repos', REPO, 'companion-requests')),
		[],
	);
});
