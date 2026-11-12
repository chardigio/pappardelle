import test, {type ExecutionContext} from 'ava';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {closeStateDb, openStateDb} from './state-db.ts';
import {onStateDbChange, waitForStateDbChange} from './state-db-watch.ts';

const run = promisify(execFile);
const moduleUrl = (name: string) =>
	JSON.stringify(new URL(name, import.meta.url).href);

function fixture(t: ExecutionContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-watch-'));
	const dbPath = path.join(dir, 'state.db');
	const state = openStateDb(dbPath);
	state.db.run('CREATE TABLE marks (name TEXT PRIMARY KEY) STRICT');
	t.teardown(() => {
		closeStateDb(dbPath);
		fs.rmSync(dir, {recursive: true, force: true});
	});
	return {dbPath, state};
}

async function changed(dbPath: string, ms: number): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			finish(false);
		}, ms);
		const stop = onStateDbChange(dbPath, () => {
			finish(true);
		});
		function finish(seen: boolean) {
			clearTimeout(timer);
			stop();
			resolve(seen);
		}
	});
}

test("another process's write reaches a listener well inside the poll interval", async t => {
	const {dbPath} = fixture(t);
	const seen = changed(dbPath, 1500);
	await run(process.execPath, [
		'--input-type=module',
		'-e',
		`import {openStateDb} from ${moduleUrl('state-db.ts')};
		const state = openStateDb(${JSON.stringify(dbPath)});
		await state.writeRows(() => state.db.run("INSERT INTO marks VALUES ('child')"));`,
	]);
	t.true(await seen);
});

test("this process's own write reaches its listeners", async t => {
	const {dbPath, state} = fixture(t);
	const seen = changed(dbPath, 1500);
	await state.writeRows(() => state.db.run("INSERT INTO marks VALUES ('own')"));
	t.true(await seen);
});

test('a commit that rang no bell is still found by the poll', async t => {
	const {dbPath} = fixture(t);
	const seen = changed(dbPath, 4000);
	await run(process.execPath, [
		'--input-type=module',
		'-e',
		`import {Database} from 'bun:sqlite';
		new Database(${JSON.stringify(dbPath)}).run("INSERT INTO marks VALUES ('quiet')");`,
	]);
	t.true(await seen);
});

test('a transaction that changes no rows rings nothing', async t => {
	const {dbPath, state} = fixture(t);
	const seen = changed(dbPath, 300);
	await state.writeRows(() =>
		state.db.run("DELETE FROM marks WHERE name = 'absent'"),
	);
	t.false(await seen);
});

test('waiting for a change gives up after its timeout', async t => {
	const {dbPath} = fixture(t);
	const started = performance.now();
	await waitForStateDbChange(dbPath, 80);
	t.true(performance.now() - started >= 70);
});
