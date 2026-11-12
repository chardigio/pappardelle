import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import {testState} from '../test/helpers/state.ts';
import {getHighlightFilePath} from './highlight.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

type Row = {key: string; requested_at: number};

/** A store whose clock stands still unless a test moves it. */
function fixture(t: ExecutionContext) {
	const clock = {now: 1000};
	const {daos, stateDir} = testState(t, {
		sqlite: true,
		clock: () => new Date(clock.now),
	});
	const selected: string[] = [];
	return {
		clock,
		highlight: daos.highlight,
		stateColors: daos.stateColors,
		file: getHighlightFilePath('repo', stateDir),
		selected,
		watch() {
			t.teardown(
				daos.highlight.watch(request => selected.push(request.issueKey)),
			);
		},
		rows: () =>
			openStateDb(stateDbPath(stateDir))
				.db.query<
					Row,
					[]
				>("SELECT key, requested_at FROM highlight_targets WHERE repo = 'repo'")
				.all(),
	};
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('No highlight request arrived');
		await delay(5);
	}
}

test('a request is one row per repo, stamped by the clock', async t => {
	const f = fixture(t);
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	f.clock.now = 5000;
	await f.highlight.request({issueKey: 'STA-2', focus: false});
	t.deepEqual(f.rows(), [{key: 'STA-2', requested_at: 5000}]);
});

test('a request is newer than the one it replaces when the clock has not moved', async t => {
	const f = fixture(t);
	f.watch();
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => f.selected.length === 1);
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => f.selected.length === 2);
	t.deepEqual(f.rows(), [{key: 'STA-1', requested_at: 1001}]);
	f.clock.now = 500;
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await until(() => f.selected.length === 3);
	t.deepEqual(f.rows(), [{key: 'STA-1', requested_at: 1002}]);
});

test('clearing removes the row with the file', async t => {
	const f = fixture(t);
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await f.highlight.clear();
	t.deepEqual(f.rows(), []);
	t.false(fs.existsSync(f.file));
});

// A `pappardelle highlight` whose flag is off only writes the file. The
// watcher learns of it the next time the database changes.
test('a target file written without the database is reported as a request', async t => {
	const f = fixture(t);
	f.watch();
	fs.writeFileSync(f.file, 'STA-9\n');
	await f.stateColors.set('Done', '#74d09f');
	await until(() => f.selected.length > 0);
	t.deepEqual(f.selected, ['STA-9']);
	t.deepEqual(f.rows(), [{key: 'STA-9', requested_at: 1000}]);
});

// A TUI whose flag is off clears a request by removing the file.
test('a target file removed without the database takes its row with it', async t => {
	const f = fixture(t);
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	fs.rmSync(f.file);
	f.watch();
	t.deepEqual(f.rows(), []);
});
