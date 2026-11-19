import test from 'ava';
import {Database} from 'bun:sqlite';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {testState} from '../test/helpers/state.ts';

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

// idow reads 1 from `space get` as "no such space" and goes on with defaults.
test('a verb that fails exits 3, never the not-found 1', t => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-cli-'));
	t.teardown(() => fs.rmSync(home, {recursive: true, force: true}));
	const notADir = path.join(home, 'file');
	fs.writeFileSync(notADir, '');
	const result = pappardelleState(
		['migrate', path.join(notADir, 'state.db')],
		home,
	);
	t.is(result.status, 3, `stderr: ${result.stderr}`);
});

test('prepare-space stores an issue title that starts with a dash', t => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-cli-')),
	);
	t.teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const stateDir = path.join(home, '.pappardelle');
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('state-cli.ts', import.meta.url)),
			'prepare-space',
			'--repo',
			'repo',
			'--worktree',
			path.join(home, '.worktrees', 'repo', 'STA-1'),
			'--main-root',
			path.join(home, 'repo'),
			'--title=-x',
			'STA-1',
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				HOME: home,
				PAPPARDELLE_STATE_DB: path.join(stateDir, 'state.db'),
			},
		},
	);
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	const {spaceState} = testState(t, {stateDir}).daos;
	t.is(spaceState.read('STA-1')?.issueTitle, '-x');
});

test("launch-agent records the agent profile a space's agent session starts with", t => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-state-cli-')),
	);
	t.teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const stateDir = path.join(home, '.pappardelle');
	const launch = (...args: string[]) =>
		spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL('state-cli.ts', import.meta.url)),
				'launch-agent',
				'--repo',
				'repo',
				...args,
				'STA-1',
			],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					HOME: home,
					PAPPARDELLE_STATE_DB: path.join(stateDir, 'state.db'),
				},
			},
		);
	const {spaceState} = testState(t, {stateDir}).daos;
	t.is(launch('--agent-profile', 'opus', '--claude').status, 0);
	t.deepEqual(spaceState.read('STA-1')?.agentProfile, {
		name: 'opus',
		isClaude: true,
	});
	t.is(launch('--agent-profile', 'codex').status, 0);
	t.deepEqual(spaceState.read('STA-1')?.agentProfile, {
		name: 'codex',
		isClaude: false,
	});
	t.is(launch().status, 2);
});
