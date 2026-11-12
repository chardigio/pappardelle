import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {
	findSpaceIndexByIssueKey,
	getHighlightFilePath,
	type HighlightRequest,
} from './highlight.ts';
import type {SpaceData} from './types.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

const targetFile = (s: TestState) => getHighlightFilePath('repo', s.stateDir);

/** The keys a watcher is told to select, in order. */
function watching(t: ExecutionContext, s: TestState): string[] {
	const selected: string[] = [];
	t.teardown(
		s.daos.highlight.watch(request => selected.push(request.issueKey)),
	);
	return selected;
}

/** Long enough for a request that was going to be reported to have been. */
const settle = async () => delay(150);

// ============================================================================
// What every highlight store does, whichever way it is stored
// ============================================================================

contractTest('a request writes the key to the target file', async (t, s) => {
	t.is(
		targetFile(s),
		path.join(s.stateDir, 'repos', 'repo', 'highlight-target'),
	);
	await s.daos.highlight.request({issueKey: 'STA-313', focus: false});
	t.is(fs.readFileSync(targetFile(s), 'utf8'), 'STA-313\n');
	await s.daos.highlight.request({issueKey: 'STA-200', focus: false});
	t.is(fs.readFileSync(targetFile(s), 'utf8'), 'STA-200\n');
});

contractTest(
	'a focus request is written with its marker and reaches a listener as one',
	async (t, s) => {
		const requests: HighlightRequest[] = [];
		t.teardown(s.daos.highlight.watch(request => requests.push(request)));
		await s.daos.highlight.request({issueKey: 'main', focus: true});
		t.is(fs.readFileSync(targetFile(s), 'utf8'), 'main\tfocus\n');
		await waitUntil(() => requests.length > 0, 'a highlight request');
		t.deepEqual(requests[0], {issueKey: 'main', focus: true});
	},
);

// The sous-chef key runs this line from tmux, without starting Pappardelle.
contractTest(
	'the shell form of a request reaches a watching listener',
	async (t, s) => {
		const requests: HighlightRequest[] = [];
		t.teardown(s.daos.highlight.watch(request => requests.push(request)));
		await exec('sh', [
			'-c',
			s.daos.highlight.shellRequest({issueKey: 'main', focus: true}),
		]);
		await waitUntil(() => requests.length > 0, 'a highlight request');
		t.deepEqual(requests[0], {issueKey: 'main', focus: true});
	},
);

contractTest('a request reaches a watching listener', async (t, s) => {
	const selected = watching(t, s);
	await s.daos.highlight.request({issueKey: 'STA-500', focus: false});
	await waitUntil(() => selected.length > 0, 'a highlight request');
	t.is(selected[0], 'STA-500');
});

// The user asks for a space, moves the selection away, and asks again.
contractTest('asking for the same key twice selects it twice', async (t, s) => {
	const selected = watching(t, s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => selected.length > 0, 'a highlight request');
	await settle();
	const first = selected.length;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => selected.length > first, 'a highlight request');
	t.deepEqual([...new Set(selected)], ['STA-1']);
});

contractTest(
	'a request made before the watcher subscribed is not reported, and the next one is',
	async (t, s) => {
		await s.daos.highlight.request({issueKey: 'OLD-1', focus: false});
		await settle();
		const selected = watching(t, s);
		// Another store changing is not a request.
		await s.daos.stateColors.set('Done', '#74d09f');
		await settle();
		t.deepEqual(selected, []);
		await s.daos.highlight.request({issueKey: 'NEW-1', focus: false});
		await waitUntil(() => selected.length > 0, 'a highlight request');
		t.deepEqual([...new Set(selected)], ['NEW-1']);
	},
);

contractTest('clearing removes the target file', async (t, s) => {
	await s.daos.highlight.request({issueKey: 'STA-100', focus: false});
	await s.daos.highlight.clear();
	t.false(fs.existsSync(targetFile(s)));
	await t.notThrowsAsync(s.daos.highlight.clear());
});

contractTest('a request after a clear is reported', async (t, s) => {
	const selected = watching(t, s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => selected.length > 0, 'a highlight request');
	await s.daos.highlight.clear();
	await settle();
	const first = selected.length;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => selected.length > first, 'a highlight request');
	t.is(selected.at(-1), 'STA-1');
});

contractTest('a listener that stopped watching is not told', async (t, s) => {
	let calls = 0;
	const unwatch = s.daos.highlight.watch(() => {
		calls++;
	});
	unwatch();
	await s.daos.highlight.request({issueKey: 'STA-600', focus: false});
	await settle();
	t.is(calls, 0);
});

// `pappardelle highlight KEY` runs in another terminal than the TUI.
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a request from another process reaches a watching listener`, async t => {
		const s = testState(t, {sqlite});
		const selected = watching(t, s);
		await exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {highlight} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(s.stateDir)}, sqlite: ${sqlite}});
await highlight.request({issueKey: 'STA-700', focus: false});
`,
			],
			{timeout: 30_000},
		);
		await waitUntil(() => selected.length > 0, 'a highlight request');
		t.is(selected[0], 'STA-700');
	});
}

test('the two stores leave the same target file for the same requests', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState(t, {sqlite});
		/* eslint-disable no-await-in-loop -- The history is a sequence. */
		await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
		await s.daos.highlight.clear();
		await s.daos.highlight.request({issueKey: 'STA-2', focus: false});
		await s.daos.highlight.request({issueKey: 'STA-3', focus: false});
		/* eslint-enable no-await-in-loop */
		files.push(fs.readFileSync(targetFile(s), 'utf8'));
	}

	t.is(files[0], files[1]);
	t.is(files[0], 'STA-3\n');
});

// ============================================================================
// findSpaceIndexByIssueKey
// ============================================================================

const makeSpace = (name: string): SpaceData => ({
	name,
	worktreePath: `/worktrees/${name}`,
});

test('findSpaceIndexByIssueKey finds exact match', t => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-300'),
	];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-200'), 1);
});

test('findSpaceIndexByIssueKey returns -1 when not found', t => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-999'), -1);
});

test('findSpaceIndexByIssueKey handles empty spaces array', t => {
	t.is(findSpaceIndexByIssueKey([], 'STA-100'), -1);
});

test('findSpaceIndexByIssueKey is case-insensitive', t => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	t.is(findSpaceIndexByIssueKey(spaces, 'sta-200'), 1);
});

test('findSpaceIndexByIssueKey matches first occurrence', t => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-100'),
	];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-100'), 0);
});
