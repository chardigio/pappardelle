import fs from 'node:fs';
import test, {type ExecutionContext} from 'ava';
import {testState} from '../test/helpers/state.ts';
import {
	StateColorCache,
	getStateColorsPath,
} from './providers/state-color-cache.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

type Row = {rowid: number; name: string; color: string};

function fixture(t: ExecutionContext) {
	const {daos, stateDir} = testState(t, {sqlite: true});
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
test('a color update writes its own row and leaves the others', t => {
	const f = fixture(t);
	const first = new StateColorCache(f.dao);
	const second = new StateColorCache(f.dao);
	first.update('Done', '#aaa');
	first.update('Todo', '#bbb');
	const before = f.rows();

	second.update('In Progress', '#ccc');
	t.deepEqual(f.rows(), [
		...before,
		{rowid: 3, name: 'In Progress', color: '#ccc'},
	]);
	t.is(f.content(), '{"Done":"#aaa","Todo":"#bbb","In Progress":"#ccc"}\n');

	second.update('Done', '#ddd');
	t.deepEqual(f.rows(), [
		{rowid: 1, name: 'Done', color: '#ddd'},
		{rowid: 2, name: 'Todo', color: '#bbb'},
		{rowid: 3, name: 'In Progress', color: '#ccc'},
	]);
});

test('learning a color another process already stored rewrites nothing', t => {
	const f = fixture(t);
	const first = new StateColorCache(f.dao);
	const second = new StateColorCache(f.dao);
	first.update('Done', '#aaa');
	const before = fs.statSync(f.file, {bigint: true});
	second.update('Done', '#aaa');
	const after = fs.statSync(f.file, {bigint: true});
	t.is(after.ino, before.ino);
	t.is(after.mtimeNs, before.mtimeNs);
});

test('a color file edited without the database replaces the rows on the next load', t => {
	const f = fixture(t);
	new StateColorCache(f.dao).update('Done', '#aaa');
	fs.writeFileSync(f.file, JSON.stringify({Todo: '#bbb'}) + '\n');

	const cache = new StateColorCache(f.dao);
	t.is(cache.get('Done'), null);
	t.is(cache.get('Todo'), '#bbb');
	t.deepEqual(
		f.rows().map(row => row.name),
		['Todo'],
	);
});

test('an update keeps what another process wrote to the file since the last one', t => {
	const f = fixture(t);
	const cache = new StateColorCache(f.dao);
	cache.update('Done', '#aaa');
	fs.writeFileSync(f.file, JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n');
	cache.update('In Progress', '#ccc');
	t.is(f.content(), '{"Done":"#aaa","Todo":"#bbb","In Progress":"#ccc"}\n');
});

test('a color file that vanished keeps the rows, and the next update writes it again', t => {
	const f = fixture(t);
	const cache = new StateColorCache(f.dao);
	cache.update('Done', '#aaa');
	fs.rmSync(f.file);

	t.is(new StateColorCache(f.dao).get('Done'), '#aaa');
	cache.update('Todo', '#bbb');
	t.is(f.content(), '{"Done":"#aaa","Todo":"#bbb"}\n');
});

test('a color file that is not JSON keeps the rows', t => {
	const f = fixture(t);
	new StateColorCache(f.dao).update('Done', '#aaa');
	fs.writeFileSync(f.file, '{{not json');
	t.is(new StateColorCache(f.dao).get('Done'), '#aaa');
});
