import {execFile} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {spaceData} from '../test/helpers/space-fixtures.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {until, watcherReady} from '../test/helpers/wait.ts';
import {
	findSpaceIndexByIssueKey,
	highlightShellCommand,
	type HighlightRequest,
} from './highlight.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const exec = promisify(execFile);
const daosUrl = new URL('state-daos.ts', import.meta.url).href;

/** The keys a watcher is told to select, in order. */
async function watching(s: TestState): Promise<string[]> {
	const selected: string[] = [];
	teardown(s.daos.highlight.watch(request => selected.push(request.issueKey)));
	await watcherReady();
	return selected;
}

/** Long enough for a request that was going to be reported to have been. */
const settle = async () => delay(150);

const rows = (s: TestState) =>
	openStateDb(stateDbPath(s.stateDir))
		.db.query<
			{key: string; requested_at: number},
			[]
		>("SELECT key, requested_at FROM highlight_targets WHERE repo = 'repo'")
		.all();

storeTest('a focus request reaches a listener as one', async s => {
	const requests: HighlightRequest[] = [];
	teardown(s.daos.highlight.watch(request => requests.push(request)));
	await watcherReady();
	await s.daos.highlight.request({issueKey: 'main', focus: true});
	await until(() => requests.length > 0, {what: 'a highlight request'});
	expect(requests[0]).toStrictEqual({issueKey: 'main', focus: true});
});

// The sous-chef key runs this line from tmux, whose environment is not the
// TUI's: HOME and PAPPARDELLE_STATE_DB there name another database.
test('the shell form of a request reaches a watching listener', async () => {
	const home = tempDir('papp-highlight-home-');
	const s = testState({stateDir: path.join(home, '.pappardelle')});
	const elsewhere = tempDir('papp-highlight-other-');
	const requests: HighlightRequest[] = [];
	teardown(s.daos.highlight.watch(request => requests.push(request)));
	await watcherReady();
	await exec(
		'sh',
		[
			'-c',
			highlightShellCommand('repo', stateDbPath(s.stateDir), {
				issueKey: 'main',
				focus: true,
			}),
		],
		{
			env: {
				...process.env,
				HOME: elsewhere,
				PAPPARDELLE_STATE_DB: path.join(elsewhere, 'state.db'),
			},
			timeout: 30_000,
		},
	);
	await until(() => requests.length > 0, {what: 'a highlight request'});
	expect(requests[0]).toStrictEqual({issueKey: 'main', focus: true});
});

storeTest('a request reaches a watching listener', async s => {
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-500', focus: false});
	await until(() => selected.length > 0, {what: 'a highlight request'});
	expect(selected[0]).toBe('STA-500');
});

// The user asks for a space, moves the selection away, and asks again.
storeTest('asking for the same key twice selects it twice', async s => {
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > 0, {what: 'a highlight request'});
	await settle();
	const first = selected.length;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > first, {what: 'a highlight request'});
	expect([...new Set(selected)]).toStrictEqual(['STA-1']);
});

storeTest(
	'a request made before the watcher subscribed is not reported, and the next one is',
	async s => {
		await s.daos.highlight.request({issueKey: 'OLD-1', focus: false});
		await settle();
		const selected = await watching(s);
		// Another store changing is not a request.
		await s.daos.stateColors.set('Done', '#74d09f');
		await settle();
		expect(selected).toStrictEqual([]);
		await s.daos.highlight.request({issueKey: 'NEW-1', focus: false});
		await until(() => selected.length > 0, {what: 'a highlight request'});
		expect([...new Set(selected)]).toStrictEqual(['NEW-1']);
	},
);

test('a request is one row per repo, stamped by the clock', async () => {
	const clock = {now: 1000};
	const s = testState({clock: () => new Date(clock.now)});
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	clock.now = 5000;
	await s.daos.highlight.request({issueKey: 'STA-2', focus: false});
	expect(rows(s)).toStrictEqual([{key: 'STA-2', requested_at: 5000}]);
});

test('a request is newer than the one it replaces when the clock has not moved', async () => {
	const clock = {now: 1000};
	const s = testState({clock: () => new Date(clock.now)});
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length === 1, {what: 'a highlight request'});
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length === 2, {what: 'a highlight request'});
	expect(rows(s)).toStrictEqual([{key: 'STA-1', requested_at: 1001}]);
	clock.now = 500;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length === 3, {what: 'a highlight request'});
	expect(rows(s)).toStrictEqual([{key: 'STA-1', requested_at: 1002}]);
});

storeTest('clearing removes the request', async s => {
	await s.daos.highlight.request({issueKey: 'STA-100', focus: false});
	await s.daos.highlight.clear();
	expect(rows(s)).toStrictEqual([]);
});

storeTest('a request after a clear is reported', async s => {
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > 0, {what: 'a highlight request'});
	await s.daos.highlight.clear();
	await settle();
	const first = selected.length;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > first, {what: 'a highlight request'});
	expect(selected.at(-1)).toBe('STA-1');
});

storeTest('a listener that stopped watching is not told', async s => {
	let calls = 0;
	const unwatch = s.daos.highlight.watch(() => {
		calls++;
	});
	unwatch();
	await s.daos.highlight.request({issueKey: 'STA-600', focus: false});
	await settle();
	expect(calls).toBe(0);
});

// `pappardelle highlight KEY` runs in another terminal than the TUI.
test('a request from another process reaches a watching listener', async () => {
	const s = testState();
	const selected = await watching(s);
	await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {createStateDaos} from ${JSON.stringify(daosUrl)};
const {highlight} = createStateDaos({repo: 'repo', stateDir: ${JSON.stringify(s.stateDir)}});
await highlight.request({issueKey: 'STA-700', focus: false});
`,
		],
		{timeout: 30_000},
	);
	await until(() => selected.length > 0, {what: 'a highlight request'});
	expect(selected[0]).toBe('STA-700');
});

// ============================================================================
// findSpaceIndexByIssueKey
// ============================================================================

test('findSpaceIndexByIssueKey finds exact match', () => {
	const spaces = [
		spaceData('STA-100'),
		spaceData('STA-200'),
		spaceData('STA-300'),
	];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-200')).toBe(1);
});

test('findSpaceIndexByIssueKey returns -1 when not found', () => {
	const spaces = [spaceData('STA-100'), spaceData('STA-200')];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-999')).toBe(-1);
});

test('findSpaceIndexByIssueKey handles empty spaces array', () => {
	expect(findSpaceIndexByIssueKey([], 'STA-100')).toBe(-1);
});

test('findSpaceIndexByIssueKey is case-insensitive', () => {
	const spaces = [spaceData('STA-100'), spaceData('STA-200')];
	expect(findSpaceIndexByIssueKey(spaces, 'sta-200')).toBe(1);
});

test('findSpaceIndexByIssueKey matches first occurrence', () => {
	const spaces = [
		spaceData('STA-100'),
		spaceData('STA-200'),
		spaceData('STA-100'),
	];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-100')).toBe(0);
});
