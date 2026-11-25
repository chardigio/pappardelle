import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {testState} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import {getHighlightFilePath} from './highlight.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

type Row = {key: string; requested_at: number};

/** A store whose clock stands still unless a test moves it. */
function fixture() {
	const clock = {now: 1000};
	const {daos, stateDir} = testState({
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
			teardown(
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

test('a request is one row per repo, stamped by the clock', async () => {
	const f = fixture();
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	f.clock.now = 5000;
	await f.highlight.request({issueKey: 'STA-2', focus: false});
	expect(f.rows()).toStrictEqual([{key: 'STA-2', requested_at: 5000}]);
});

test('a request is newer than the one it replaces when the clock has not moved', async () => {
	const f = fixture();
	f.watch();
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => f.selected.length === 1, 'a highlight request');
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => f.selected.length === 2, 'a highlight request');
	expect(f.rows()).toStrictEqual([{key: 'STA-1', requested_at: 1001}]);
	f.clock.now = 500;
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await waitUntil(() => f.selected.length === 3, 'a highlight request');
	expect(f.rows()).toStrictEqual([{key: 'STA-1', requested_at: 1002}]);
});

test('clearing removes the row with the file', async () => {
	const f = fixture();
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	await f.highlight.clear();
	expect(f.rows()).toStrictEqual([]);
	expect(fs.existsSync(f.file)).toBe(false);
});

// A `pappardelle highlight` whose flag is off only writes the file. The
// watcher learns of it the next time the database changes.
test('a target file written without the database is reported as a request', async () => {
	const f = fixture();
	f.watch();
	fs.writeFileSync(f.file, 'STA-9\n');
	await f.stateColors.set('Done', '#74d09f');
	await waitUntil(() => f.selected.length > 0, 'a highlight request');
	expect(f.selected).toStrictEqual(['STA-9']);
	expect(f.rows()).toStrictEqual([{key: 'STA-9', requested_at: 1000}]);
});

// A TUI whose flag is off clears a request by removing the file.
test('a target file removed without the database takes its row with it', async () => {
	const f = fixture();
	await f.highlight.request({issueKey: 'STA-1', focus: false});
	fs.rmSync(f.file);
	f.watch();
	expect(f.rows()).toStrictEqual([]);
});
