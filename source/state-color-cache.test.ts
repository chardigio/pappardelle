import {test, expect} from 'bun:test';
import {storeTest} from '../test/helpers/store-test.ts';
import {testState} from '../test/helpers/state.ts';
import {StateColorCache} from './providers/state-color-cache.ts';
import {createStateDaos} from './state-daos.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

test('get returns null for unknown state', () => {
	const cache = new StateColorCache();
	expect(cache.get('Unknown')).toBe(null);
});

test('update stores color in memory', () => {
	const cache = new StateColorCache();
	cache.update('Done', '#74d09f');
	expect(cache.get('Done')).toBe('#74d09f');
});

storeTest('a new cache loads the colors an earlier one stored', s => {
	const first = new StateColorCache(s.daos.stateColors);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');
	first.update('Done', '#ddd');

	const second = new StateColorCache(s.daos.stateColors);
	expect(second.get('Done')).toBe('#ddd');
	expect(second.get('Todo')).toBe('#bbb');
});

storeTest('a cache with nothing stored knows no colors', s => {
	const cache = new StateColorCache(s.daos.stateColors);
	expect(cache.get('Done')).toBe(null);
});

// Each running Pappardelle remembers the colors it loaded at startup. Two
// of them learning different colors must not undo each other.
test('a color update writes its own row and leaves the others', () => {
	const {daos, stateDir} = testState();
	const rows = () =>
		openStateDb(stateDbPath(stateDir))
			.db.query<
				{rowid: number; name: string; color: string},
				[]
			>("SELECT rowid, name, color FROM state_colors WHERE repo = 'repo' ORDER BY rowid")
			.all();
	const first = new StateColorCache(daos.stateColors);
	const second = new StateColorCache(daos.stateColors);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');
	second.update('In Progress', '#ccc');
	second.update('Done', '#ddd');
	expect(rows()).toStrictEqual([
		{rowid: 1, name: 'Done', color: '#ddd'},
		{rowid: 2, name: 'Todo', color: '#bbb'},
		{rowid: 3, name: 'In Progress', color: '#ccc'},
	]);
});

test('each repo has colors of its own', () => {
	const {stateDir} = testState();
	const repoA = createStateDaos({repo: 'repo-a', stateDir});
	const repoB = createStateDaos({repo: 'repo-b', stateDir});
	new StateColorCache(repoA.stateColors).update('Done', '#aaa');
	new StateColorCache(repoB.stateColors).update('Done', '#bbb');

	expect(new StateColorCache(repoA.stateColors).get('Done')).toBe('#aaa');
	expect(new StateColorCache(repoB.stateColors).get('Done')).toBe('#bbb');
});
