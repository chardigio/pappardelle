import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {until, watcherReady} from '../test/helpers/wait.ts';
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
async function watching(s: TestState): Promise<string[]> {
	const selected: string[] = [];
	teardown(s.daos.highlight.watch(request => selected.push(request.issueKey)));
	await watcherReady();
	return selected;
}

/** Long enough for a request that was going to be reported to have been. */
const settle = async () => delay(150);

// ============================================================================
// What every highlight store does, whichever way it is stored
// ============================================================================

contractTest('a request writes the key to the target file', async s => {
	expect(targetFile(s)).toBe(
		path.join(s.stateDir, 'repos', 'repo', 'highlight-target'),
	);
	await s.daos.highlight.request({issueKey: 'STA-313', focus: false});
	expect(fs.readFileSync(targetFile(s), 'utf8')).toBe('STA-313\n');
	await s.daos.highlight.request({issueKey: 'STA-200', focus: false});
	expect(fs.readFileSync(targetFile(s), 'utf8')).toBe('STA-200\n');
});

contractTest(
	'a focus request is written with its marker and reaches a listener as one',
	async s => {
		const requests: HighlightRequest[] = [];
		teardown(s.daos.highlight.watch(request => requests.push(request)));
		await watcherReady();
		await s.daos.highlight.request({issueKey: 'main', focus: true});
		expect(fs.readFileSync(targetFile(s), 'utf8')).toBe('main\tfocus\n');
		await until(() => requests.length > 0, {what: 'a highlight request'});
		expect(requests[0]).toStrictEqual({issueKey: 'main', focus: true});
	},
);

// The sous-chef key runs this line from tmux, without starting Pappardelle.
contractTest(
	'the shell form of a request reaches a watching listener',
	async s => {
		const requests: HighlightRequest[] = [];
		teardown(s.daos.highlight.watch(request => requests.push(request)));
		await watcherReady();
		await exec('sh', [
			'-c',
			s.daos.highlight.shellRequest({issueKey: 'main', focus: true}),
		]);
		await until(() => requests.length > 0, {what: 'a highlight request'});
		expect(requests[0]).toStrictEqual({issueKey: 'main', focus: true});
	},
);

contractTest('a request reaches a watching listener', async s => {
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-500', focus: false});
	await until(() => selected.length > 0, {what: 'a highlight request'});
	expect(selected[0]).toBe('STA-500');
});

// The user asks for a space, moves the selection away, and asks again.
contractTest('asking for the same key twice selects it twice', async s => {
	const selected = await watching(s);
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > 0, {what: 'a highlight request'});
	await settle();
	const first = selected.length;
	await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => selected.length > first, {what: 'a highlight request'});
	expect([...new Set(selected)]).toStrictEqual(['STA-1']);
});

contractTest(
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

contractTest('clearing removes the target file', async s => {
	await s.daos.highlight.request({issueKey: 'STA-100', focus: false});
	await s.daos.highlight.clear();
	expect(fs.existsSync(targetFile(s))).toBe(false);
	expect(await s.daos.highlight.clear()).toBeUndefined();
});

contractTest('a request after a clear is reported', async s => {
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

contractTest('a listener that stopped watching is not told', async s => {
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
for (const sqlite of [false, true]) {
	test(`${sqlite ? 'sqlite' : 'json'}: a request from another process reaches a watching listener`, async () => {
		const s = testState({sqlite});
		const selected = await watching(s);
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
		await until(() => selected.length > 0, {what: 'a highlight request'});
		expect(selected[0]).toBe('STA-700');
	});
}

test('the two stores leave the same target file for the same requests', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState({sqlite});
		/* eslint-disable no-await-in-loop -- The history is a sequence. */
		await s.daos.highlight.request({issueKey: 'STA-1', focus: false});
		await s.daos.highlight.clear();
		await s.daos.highlight.request({issueKey: 'STA-2', focus: false});
		await s.daos.highlight.request({issueKey: 'STA-3', focus: false});
		/* eslint-enable no-await-in-loop */
		files.push(fs.readFileSync(targetFile(s), 'utf8'));
	}

	expect(files[0]).toBe(files[1]);
	expect(files[0]).toBe('STA-3\n');
});

// ============================================================================
// findSpaceIndexByIssueKey
// ============================================================================

const makeSpace = (name: string): SpaceData => ({
	name,
	worktreePath: `/worktrees/${name}`,
});

test('findSpaceIndexByIssueKey finds exact match', () => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-300'),
	];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-200')).toBe(1);
});

test('findSpaceIndexByIssueKey returns -1 when not found', () => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-999')).toBe(-1);
});

test('findSpaceIndexByIssueKey handles empty spaces array', () => {
	expect(findSpaceIndexByIssueKey([], 'STA-100')).toBe(-1);
});

test('findSpaceIndexByIssueKey is case-insensitive', () => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	expect(findSpaceIndexByIssueKey(spaces, 'sta-200')).toBe(1);
});

test('findSpaceIndexByIssueKey matches first occurrence', () => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-100'),
	];
	expect(findSpaceIndexByIssueKey(spaces, 'STA-100')).toBe(0);
});
