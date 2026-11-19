import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
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

test('get returns null for unknown state', t => {
	const cache = new StateColorCache();
	t.is(cache.get('Unknown'), null);
});

test('update stores color in memory', t => {
	const cache = new StateColorCache();
	cache.update('Done', '#74d09f');
	t.is(cache.get('Done'), '#74d09f');
});

// ============================================================================
// What every color store does, whichever way it is stored
// ============================================================================

contractTest('update persists to disk', (t, s) => {
	t.is(
		colorsFile(s),
		path.join(s.stateDir, 'repos', 'repo', 'state-colors.json'),
	);
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('In Progress', '#f2c94c');
	t.deepEqual(readFile(colorsFile(s)), {'In Progress': '#f2c94c'});
});

contractTest('a new cache loads the colors an earlier one stored', (t, s) => {
	const first = new StateColorCache(s.daos.stateColors);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');

	const second = new StateColorCache(s.daos.stateColors);
	t.is(second.get('Done'), '#aaa');
	t.is(second.get('Todo'), '#bbb');
});

contractTest('a cache loads a file left by another process', (t, s) => {
	fs.writeFileSync(
		colorsFile(s),
		JSON.stringify({Done: '#aaa', Todo: '#bbb', Broken: 7}) + '\n',
	);

	const cache = new StateColorCache(s.daos.stateColors);
	t.is(cache.get('Done'), '#aaa');
	t.is(cache.get('Todo'), '#bbb');
	t.is(cache.get('Broken'), null);
});

contractTest('update does not write when color is unchanged', (t, s) => {
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('Done', '#74d09f');

	const stat1 = fs.statSync(colorsFile(s), {bigint: true});
	cache.update('Done', '#74d09f');
	const stat2 = fs.statSync(colorsFile(s), {bigint: true});

	t.is(stat1.mtimeNs, stat2.mtimeNs);
	t.is(stat1.ino, stat2.ino);
});

contractTest(
	'invalid JSON on disk is ignored, and replaced by the next update',
	(t, s) => {
		fs.writeFileSync(colorsFile(s), '{{not json');

		const cache = new StateColorCache(s.daos.stateColors);
		t.is(cache.get('Done'), null);
		cache.update('Done', '#74d09f');
		t.deepEqual(readFile(colorsFile(s)), {Done: '#74d09f'});
	},
);

contractTest('missing file on disk is silently ignored', (t, s) => {
	const cache = new StateColorCache(s.daos.stateColors);
	t.is(cache.get('Done'), null);
});

contractTest('multiple updates accumulate in the persisted file', (t, s) => {
	const cache = new StateColorCache(s.daos.stateColors);
	cache.update('Done', '#aaa');
	cache.update('In Progress', '#bbb');
	cache.update('Todo', '#ccc');
	cache.update('Done', '#ddd');

	t.deepEqual(readFile(colorsFile(s)), {
		Done: '#ddd',
		'In Progress': '#bbb',
		Todo: '#ccc',
	});
});

test('the two stores leave the same file for the same updates', t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const s = testState(t, {sqlite});
		fs.writeFileSync(colorsFile(s), JSON.stringify({Backlog: '#111'}) + '\n');
		const cache = new StateColorCache(s.daos.stateColors);
		cache.update('Done', '#aaa');
		cache.update('In Progress', '#bbb');
		cache.update('Backlog', '#222');
		cache.update('Done', '#ccc');
		files.push(fs.readFileSync(colorsFile(s), 'utf8'));
	}

	t.is(files[0], files[1]);
	t.is(files[0], '{"Backlog":"#222","Done":"#ccc","In Progress":"#bbb"}\n');
});

// ============================================================================
// Repo-namespaced state color cache
// ============================================================================

for (const sqlite of [false, true]) {
	const name = sqlite ? 'sqlite' : 'json';

	test(`${name}: each repo has colors of its own`, t => {
		const {stateDir} = testState(t, {sqlite});
		const repoA = createStateDaos({repo: 'repo-a', stateDir, sqlite});
		const repoB = createStateDaos({repo: 'repo-b', stateDir, sqlite});
		new StateColorCache(repoA.stateColors).update('Done', '#aaa');
		new StateColorCache(repoB.stateColors).update('Done', '#bbb');

		t.is(new StateColorCache(repoA.stateColors).get('Done'), '#aaa');
		t.deepEqual(readFile(getStateColorsPath('repo-b', stateDir)), {
			Done: '#bbb',
		});
	});

	// Before state was kept per repo there was one color file for all of them.
	test(`${name}: the pre-repo color file moves to the first repo that starts`, t => {
		const {stateDir} = testState(t, {sqlite});
		const legacyPath = path.join(stateDir, 'state-colors.json');
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n',
		);

		const {stateColors} = createStateDaos({repo: 'my-repo', stateDir, sqlite});
		const cache = new StateColorCache(stateColors);
		t.is(cache.get('Done'), '#aaa');
		t.is(cache.get('Todo'), '#bbb');
		t.false(fs.existsSync(legacyPath));
		t.true(fs.existsSync(getStateColorsPath('my-repo', stateDir)));
	});

	test(`${name}: a repo that already has colors keeps them, and the pre-repo file is dropped`, t => {
		const {stateDir} = testState(t, {sqlite});
		const legacyPath = path.join(stateDir, 'state-colors.json');
		fs.writeFileSync(legacyPath, JSON.stringify({Done: '#old'}) + '\n');
		const repoPath = getStateColorsPath('my-repo', stateDir);
		fs.mkdirSync(path.dirname(repoPath), {recursive: true});
		fs.writeFileSync(repoPath, JSON.stringify({Done: '#new'}) + '\n');

		const {stateColors} = createStateDaos({repo: 'my-repo', stateDir, sqlite});
		t.false(fs.existsSync(legacyPath));
		t.is(new StateColorCache(stateColors).get('Done'), '#new');
	});
}
