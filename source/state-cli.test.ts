import test from 'ava';
import {Database} from 'bun:sqlite';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(
	new URL('../scripts/state-cli.sh', import.meta.url),
);

function pappardelleState(args: string[], home: string) {
	return spawnSync(
		'bash',
		['-c', 'source "$0"; pappardelle_state "$@"', helper, ...args],
		{
			encoding: 'utf8',
			// No PAPPARDELLE_EXECUTABLE: the helper has to find the binary itself,
			// as it does when idow is run by hand.
			env: {PATH: process.env['PATH'], HOME: home},
		},
	);
}

test('a script can ask the binary to create the database', t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-cli-'));
	t.teardown(() => fs.rmSync(home, {recursive: true, force: true}));
	const dbPath = path.join(home, 'state.db');
	const result = pappardelleState(['migrate', dbPath], home);
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	const db = new Database(dbPath, {readonly: true});
	t.truthy(
		db.query("SELECT name FROM sqlite_master WHERE name = 'json_sync'").get(),
	);
	db.close();
});

test('an unknown verb fails without starting anything else', t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-cli-'));
	t.teardown(() => fs.rmSync(home, {recursive: true, force: true}));
	const result = pappardelleState(['open-a-space', 'KEY-1'], home);
	t.is(result.status, 2);
	t.regex(result.stderr, /unknown verb open-a-space/);
	t.deepEqual(fs.readdirSync(home), []);
});
