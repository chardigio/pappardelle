import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test, {type ExecutionContext} from 'ava';
import {testState} from '../test/helpers/state.ts';
import {
	JsonClaudeStatusDao,
	type ClaudeSessionState,
	type ClaudeStatus,
} from './claude-status.ts';
import {SqliteClaudeStatusDao} from './claude-status-sqlite.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const run = promisify(execFile);
const HOOK = fileURLToPath(
	new URL('../plugins/pappardelle/hooks/update-status.py', import.meta.url),
);

type Row = {status_key: string; status: string; current_tool: string | null};

function fixture(t: ExecutionContext) {
	const {daos, stateDir} = testState(t, {sqlite: true});
	const dbPath = stateDbPath(stateDir);
	// The hook only writes to a database that Pappardelle has already created.
	openStateDb(dbPath);
	const statusDir = path.join(stateDir, 'claude-status');
	const file = (key: string) => path.join(statusDir, `${key}.json`);
	const query = <T>(sql: string, ...parameters: string[]) =>
		openStateDb(dbPath)
			.db.query<T, string[]>(sql)
			.all(...parameters);
	return {
		dao: daos.claudeStatus,
		stateDir,
		dbPath,
		statusDir,
		file,
		query,
		rows: () =>
			query<Row>(
				'SELECT status_key, status, current_tool FROM claude_status ORDER BY status_key',
			),
		/** A status file as an agent whose hook does not use the database leaves it. */
		writeFile(state: ClaudeSessionState) {
			fs.mkdirSync(statusDir, {recursive: true});
			fs.writeFileSync(file(state.workspaceName), JSON.stringify(state));
		},
		/** The real hook, run as Claude runs it in a space of repo `repo`. */
		async hook(
			space: string,
			event: Record<string, string>,
			env: Record<string, string> = {},
		) {
			const child = run('python3', [HOOK], {
				// Nothing of the session these tests run in: its variables name
				// the developer's own state files.
				env: {
					PATH: process.env['PATH'],
					HOME: path.join(stateDir, 'home'),
					PAPPARDELLE_SQLITE_STATE: '1',
					PAPPARDELLE_STATE_DB: dbPath,
					PAPPARDELLE_STATUS_DIR: statusDir,
					PAPPARDELLE_REPO: 'repo',
					PAPPARDELLE_SPACE: space,
					...env,
				},
			});
			child.child.stdin!.end(JSON.stringify(event));
			await child;
		},
	};
}

const session = (
	workspaceName: string,
	status: ClaudeStatus,
	rest: Partial<ClaudeSessionState> = {},
): ClaudeSessionState => ({
	sessionId: 'test-session',
	workspaceName,
	status,
	lastUpdate: Date.now(),
	...rest,
});

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Status change did not arrive');
		await delay(5);
	}
}

// ============================================================================
// Rows and files kept in step
// ============================================================================

test('a status file written without the database becomes a row when its key is read', async t => {
	const f = fixture(t);
	f.writeFile(session('repo-STA-1', 'running_tool', {currentTool: 'Bash'}));
	t.deepEqual(f.rows(), []);
	t.deepEqual(await f.dao.read('repo-STA-1'), {
		status: 'running_tool',
		tool: 'Bash',
	});
	t.deepEqual(f.rows(), [
		{status_key: 'repo-STA-1', status: 'running_tool', current_tool: 'Bash'},
	]);
});

test('a status file that was removed takes its row with it', async t => {
	const f = fixture(t);
	await f.dao.write(session('repo-STA-1', 'ended'));
	await f.dao.write(session('repo-STA-2', 'ended'));
	fs.rmSync(f.file('repo-STA-1'));
	t.deepEqual(f.dao.readState('repo-STA-1'), {kind: 'none'});
	t.deepEqual(
		f.rows().map(row => row.status_key),
		['repo-STA-2'],
	);
});

test('a status file that stops being a status keeps the row it had', async t => {
	const f = fixture(t);
	await f.dao.write(session('repo-STA-1', 'waiting_for_input'));
	fs.writeFileSync(f.file('repo-STA-1'), '{"status": "working"}');
	t.deepEqual(await f.dao.read('repo-STA-1'), {
		status: 'waiting_for_input',
		tool: undefined,
	});
	t.is(f.dao.readableKey('repo', 'STA-1'), 'repo-STA-1');
});

test('writing the status a key already has rewrites nothing', async t => {
	const f = fixture(t);
	const state = session('repo-STA-1', 'processing');
	await f.dao.write(state);
	const before = fs.statSync(f.file('repo-STA-1')).ino;
	const bell = fs.readFileSync(`${f.dbPath}.bell`, 'utf8');
	await delay(5);
	await f.dao.write(state);
	t.is(fs.statSync(f.file('repo-STA-1')).ino, before);
	t.is(fs.readFileSync(`${f.dbPath}.bell`, 'utf8'), bell);
});

test('a database that cannot be opened is a status that cannot be read, not a missing one', async t => {
	const f = fixture(t);
	const dao = new SqliteClaudeStatusDao(
		() => {
			throw new Error('unable to open database file');
		},
		f.dbPath,
		new JsonClaudeStatusDao(f.statusDir),
	);
	clearRecentErrors();
	t.is(await dao.read('repo-STA-1'), null);
	t.deepEqual(dao.readState('repo-STA-1'), {kind: 'unreadable'});
	t.is(dao.readableKey('repo', 'STA-1'), 'repo-STA-1');
	// Reported once: the rail reads every space again on each refresh.
	t.is(
		getRecentErrors().filter(entry => entry.component === 'claude-status')
			.length,
		1,
	);
});

// ============================================================================
// The hook, which writes from the agent's process
// ============================================================================

test('a row the hook wrote is read back and not imported again', async t => {
	const f = fixture(t);
	await f.hook('STA-1', {
		hook_event_name: 'PreToolUse',
		tool_name: 'Bash',
		session_id: 'sess-1',
		cwd: '/work/STA-1',
	});
	t.deepEqual(f.rows(), [
		{status_key: 'repo-STA-1', status: 'running_tool', current_tool: 'Bash'},
	]);
	const stored = f.dao.readState('repo-STA-1');
	t.like(stored, {
		kind: 'state',
		state: {
			sessionId: 'sess-1',
			workspaceName: 'repo-STA-1',
			status: 'running_tool',
			currentTool: 'Bash',
			event: 'PreToolUse',
			cwd: '/work/STA-1',
		},
	});
	t.deepEqual(
		stored.kind === 'state' && stored.state,
		JSON.parse(fs.readFileSync(f.file('repo-STA-1'), 'utf8')) as unknown,
	);

	// The hook recorded the file under the path and signature this side
	// computes, so the file counts as already imported.
	const stat = fs.statSync(f.file('repo-STA-1'), {bigint: true});
	t.deepEqual(f.query('SELECT path, ino, size, mtime_ns FROM json_sync'), [
		{
			path: f.file('repo-STA-1'),
			ino: String(stat.ino),
			size: Number(stat.size),
			mtime_ns: String(stat.mtimeNs),
		},
	]);
	openStateDb(f.dbPath).db.run(
		"UPDATE claude_status SET current_tool = 'only-in-the-row'",
	);
	t.deepEqual(await f.dao.read('repo-STA-1'), {
		status: 'running_tool',
		tool: 'only-in-the-row',
	});
});

test('the hook and this side write the same row for the same file', async t => {
	const f = fixture(t);
	await f.hook('STA-1', {
		hook_event_name: 'PermissionRequest',
		tool_name: 'AskUserQuestion',
		session_id: 'sess-1',
		cwd: '/work/STA-1',
	});
	const all = () => f.query('SELECT * FROM claude_status');
	const fromHook = all();
	t.is(fromHook.length, 1);
	// Forget the row and the file's signature, so the file is imported.
	openStateDb(f.dbPath).db.run('DELETE FROM claude_status');
	openStateDb(f.dbPath).db.run('DELETE FROM json_sync');
	await f.dao.read('repo-STA-1');
	t.deepEqual(all(), fromHook);
});

test('watch reports a status the hook wrote from another process, and only that key', async t => {
	const f = fixture(t);
	await f.dao.write(session('repo-STA-2', 'processing'));
	const reported: string[] = [];
	t.teardown(f.dao.watch(key => reported.push(key)));
	await f.hook('STA-1', {hook_event_name: 'Stop', session_id: 'sess-1'});
	await until(() => reported.length > 0);
	t.deepEqual(reported, ['repo-STA-1']);
	t.deepEqual(await f.dao.read('repo-STA-1'), {
		status: 'waiting_for_input',
		tool: undefined,
	});
});

test('a hook that could not reach the database leaves a file that the next read imports', async t => {
	const f = fixture(t);
	await f.hook(
		'STA-1',
		{hook_event_name: 'Stop', session_id: 'sess-1'},
		{PAPPARDELLE_STATE_DB: path.join(f.stateDir, 'absent', 'state.db')},
	);
	t.deepEqual(f.rows(), []);
	t.deepEqual(await f.dao.read('repo-STA-1'), {
		status: 'waiting_for_input',
		tool: undefined,
	});
	t.is(f.rows().length, 1);
});
