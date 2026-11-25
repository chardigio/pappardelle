import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {
	StateColorCache,
	getStateColorsPath,
} from './providers/state-color-cache.ts';
import {createStateDaos} from './state-daos.ts';

const colorsFile = (s: TestState) => getStateColorsPath('repo', s.stateDir);

const readFile = (file: string) =>
	JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

test('get returns null for unknown state', () => {
	const cache = new StateColorCache();
	expect(cache.get('Unknown')).toBe(null);
});

test('update stores color in memory', () => {
	const cache = new StateColorCache();
	cache.update('Done', '#74d09f');
	expect(cache.get('Done')).toBe('#74d09f');
});

// ============================================================================
// What every color store does, whichever way it is stored
// ============================================================================

contractTest('update persists to disk', s => {
	expect(colorsFile(s)).toBe(
		path.join(s.stateDir, 'repos', 'repo', 'state-colors.json'),
	);
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('In Progress', '#f2c94c');
	expect(readFile(colorsFile(s))).toStrictEqual({'In Progress': '#f2c94c'});
});

contractTest('a new cache loads the colors an earlier one stored', s => {
	const first = new StateColorCache(s.daos.stateColors);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');

	const second = new StateColorCache(s.daos.stateColors);
	expect(second.get('Done')).toBe('#aaa');
	expect(second.get('Todo')).toBe('#bbb');
});

contractTest('a cache loads a file left by another process', s => {
	fs.writeFileSync(
		colorsFile(s),
		JSON.stringify({Done: '#aaa', Todo: '#bbb', Broken: 7}) + '\n',
	);

	const cache = new StateColorCache(s.daos.stateColors);
	expect(cache.get('Done')).toBe('#aaa');
	expect(cache.get('Todo')).toBe('#bbb');
	expect(cache.get('Broken')).toBe(null);
});

contractTest('update does not write when color is unchanged', s => {
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('Done', '#74d09f');

	const stat1 = fs.statSync(colorsFile(s), {bigint: true});
	cache.update('Done', '#74d09f');
	const stat2 = fs.statSync(colorsFile(s), {bigint: true});

	expect(stat1.mtimeNs).toBe(stat2.mtimeNs);
	expect(stat1.ino).toBe(stat2.ino);
});

contractTest(
	'invalid JSON on disk is ignored, and replaced by the next update',
	s => {
		fs.writeFileSync(colorsFile(s), '{{not json');

		const cache = new StateColorCache(s.daos.stateColors);
		expect(cache.get('Done')).toBe(null);
		cache.update('Done', '#74d09f');
		expect(readFile(colorsFile(s))).toStrictEqual({Done: '#74d09f'});
	},
);

contractTest('missing file on disk is silently ignored', s => {
	const cache = new StateColorCache(s.daos.stateColors);
	expect(cache.get('Done')).toBe(null);
});

contractTest('multiple updates accumulate in the persisted file', s => {
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('Done', '#aaa');
	cache.update('In Progress', '#bbb');
	cache.update('Todo', '#ccc');
	cache.update('Done', '#ddd');

	expect(readFile(colorsFile(s))).toStrictEqual({
		Done: '#ddd',
		'In Progress': '#bbb',
		Todo: '#ccc',
	});
});

test('the two stores leave the same file for the same updates', () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState({sqlite});
		fs.writeFileSync(colorsFile(s), JSON.stringify({Backlog: '#111'}) + '\n');
		const cache = new StateColorCache(s.daos.stateColors);
		cache.update('Done', '#aaa');
		cache.update('In Progress', '#bbb');
		cache.update('Backlog', '#222');
		cache.update('Done', '#ccc');
		files.push(fs.readFileSync(colorsFile(s), 'utf8'));
	}

	expect(files[0]).toBe(files[1]);
	expect(files[0]).toBe(
		'{"Backlog":"#222","Done":"#ccc","In Progress":"#bbb"}\n',
	);
});

// ============================================================================
// Repo-namespaced state color cache
// ============================================================================

for (const sqlite of [false, true]) {
	const name = sqlite ? 'sqlite' : 'json';

	test(`${name}: each repo has colors of its own`, () => {
		const {stateDir} = testState({sqlite});
		const repoA = createStateDaos({repo: 'repo-a', stateDir, sqlite});
		const repoB = createStateDaos({repo: 'repo-b', stateDir, sqlite});
		new StateColorCache(repoA.stateColors).update('Done', '#aaa');
		new StateColorCache(repoB.stateColors).update('Done', '#bbb');

		expect(new StateColorCache(repoA.stateColors).get('Done')).toBe('#aaa');
		expect(readFile(getStateColorsPath('repo-b', stateDir))).toStrictEqual({
			Done: '#bbb',
		});
	});

	// Before state was kept per repo there was one color file for all of them.
	test(`${name}: the pre-repo color file moves to the first repo that starts`, () => {
		const {stateDir} = testState({sqlite});
		const legacyPath = path.join(stateDir, 'state-colors.json');
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n',
		);

		const {stateColors} = createStateDaos({repo: 'my-repo', stateDir, sqlite});
		const cache = new StateColorCache(stateColors);
		expect(cache.get('Done')).toBe('#aaa');
		expect(cache.get('Todo')).toBe('#bbb');
		expect(fs.existsSync(legacyPath)).toBe(false);
		expect(fs.existsSync(getStateColorsPath('my-repo', stateDir))).toBe(true);
	});

	test(`${name}: a repo that already has colors keeps them, and the pre-repo file is dropped`, () => {
		const {stateDir} = testState({sqlite});
		const legacyPath = path.join(stateDir, 'state-colors.json');
		fs.writeFileSync(legacyPath, JSON.stringify({Done: '#old'}) + '\n');
		const repoPath = getStateColorsPath('my-repo', stateDir);
		fs.mkdirSync(path.dirname(repoPath), {recursive: true});
		fs.writeFileSync(repoPath, JSON.stringify({Done: '#new'}) + '\n');

		const {stateColors} = createStateDaos({repo: 'my-repo', stateDir, sqlite});
		expect(fs.existsSync(legacyPath)).toBe(false);
		expect(new StateColorCache(stateColors).get('Done')).toBe('#new');
	});
}
