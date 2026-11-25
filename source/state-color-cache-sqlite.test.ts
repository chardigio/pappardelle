import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {
	StateColorCache,
	getStateColorsPath,
} from './providers/state-color-cache.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

type Row = {rowid: number; name: string; color: string};

function fixture() {
	const {daos, stateDir} = testState({sqlite: true});
	const file = getStateColorsPath('repo', stateDir);
	return {
		dao: daos.stateColors,
		file,
		content: () => fs.readFileSync(file, 'utf8'),
		rows: () =>
			openStateDb(stateDbPath(stateDir))
				.db.query<
					Row,
					[]
				>("SELECT rowid, name, color FROM state_colors WHERE repo = 'repo' ORDER BY rowid")
				.all(),
	};
}

// Each running Pappardelle remembers the colors it loaded at startup. Two
// of them learning different colors must not undo each other.
test('a color update writes its own row and leaves the others', () => {
	const f = fixture();
	const first = new StateColorCache(f.dao);
	const second = new StateColorCache(f.dao);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');
	const before = f.rows();

	second.update('In Progress', '#ccc');
	expect(f.rows()).toStrictEqual([
		...before,
		{rowid: 3, name: 'In Progress', color: '#ccc'},
	]);
	expect(f.content()).toBe(
		'{"Done":"#aaa","Todo":"#bbb","In Progress":"#ccc"}\n',
	);

	second.update('Done', '#ddd');
	expect(f.rows()).toStrictEqual([
		{rowid: 1, name: 'Done', color: '#ddd'},
		{rowid: 2, name: 'Todo', color: '#bbb'},
		{rowid: 3, name: 'In Progress', color: '#ccc'},
	]);
});

test('learning a color another process already stored rewrites nothing', () => {
	const f = fixture();
	const first = new StateColorCache(f.dao);
	const second = new StateColorCache(f.dao);
	first.update('Done', '#aaa');
	const before = fs.statSync(f.file, {bigint: true});
	second.update('Done', '#aaa');
	const after = fs.statSync(f.file, {bigint: true});
	expect(after.ino).toBe(before.ino);
	expect(after.mtimeNs).toBe(before.mtimeNs);
});

test('a color file edited without the database replaces the rows on the next load', () => {
	const f = fixture();
	new StateColorCache(f.dao).update('Done', '#aaa');
	fs.writeFileSync(f.file, JSON.stringify({Todo: '#bbb'}) + '\n');

	const cache = new StateColorCache(f.dao);
	expect(cache.get('Done')).toBe(null);
	expect(cache.get('Todo')).toBe('#bbb');
	expect(f.rows().map(row => row.name)).toStrictEqual(['Todo']);
});

test('an update keeps what another process wrote to the file since the last one', () => {
	const f = fixture();
	const cache = new StateColorCache(f.dao);
	cache.update('Done', '#aaa');
	fs.writeFileSync(f.file, JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n');
	cache.update('In Progress', '#ccc');
	expect(f.content()).toBe(
		'{"Done":"#aaa","Todo":"#bbb","In Progress":"#ccc"}\n',
	);
});

test('a color file that vanished keeps the rows, and the next update writes it again', () => {
	const f = fixture();
	const cache = new StateColorCache(f.dao);
	cache.update('Done', '#aaa');
	fs.rmSync(f.file);

	expect(new StateColorCache(f.dao).get('Done')).toBe('#aaa');
	cache.update('Todo', '#bbb');
	expect(f.content()).toBe('{"Done":"#aaa","Todo":"#bbb"}\n');
});

test('a color file that is not JSON keeps the rows', () => {
	const f = fixture();
	new StateColorCache(f.dao).update('Done', '#aaa');
	fs.writeFileSync(f.file, '{{not json');
	expect(new StateColorCache(f.dao).get('Done')).toBe('#aaa');
});
