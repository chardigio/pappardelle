import {Database} from 'bun:sqlite';
import {expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {teardown} from '../test/helpers/teardown.ts';
import {createStateDaos, openImportedStateDb} from './state-daos.ts';
import {closeStateDb, openStateDb} from './state-db.ts';

const IMPORT_SCRIPT = path.join(import.meta.dir, 'state-daos.ts');

/** A state directory as a build that kept its state in files left it. */
function fileHome(): string {
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-import-')),
	);
	teardown(() => {
		closeStateDb(path.join(stateDir, 'state.db'));
		fs.rmSync(stateDir, {recursive: true, force: true});
	});
	return stateDir;
}

function write(stateDir: string, file: string, content: unknown): string {
	const target = path.join(stateDir, file);
	fs.mkdirSync(path.dirname(target), {recursive: true});
	fs.writeFileSync(
		target,
		typeof content === 'string' ? content : JSON.stringify(content),
	);
	return target;
}

function daos(stateDir: string, repo: string) {
	return createStateDaos({
		repo,
		stateDir,
		home: stateDir,
		mainRoot() {
			throw new Error('not in a checkout');
		},
	});
}

function writeRepo(stateDir: string, repo: string, key: string): string[] {
	const at = (file: string) => path.join('repos', repo, file);
	return [
		write(stateDir, at('open-spaces.json'), [key]),
		write(stateDir, at('watchlist-spawns.json'), {
			[`${key}-next`]: {source: 'watch', ownerPid: 1},
		}),
		write(stateDir, at(`space-state/${key}.json`), {
			profile: 'dev',
			issueTitle: `Title of ${key}`,
		}),
		write(stateDir, at(`space-state/${key}.agent-sessions.json`), {
			claude: {session_id: `${key}-session`, pid: 7, started: 'Mon'},
		}),
		write(stateDir, at(`issue-meta/${key}.json`), {
			created_by_pappardelle: true,
			created_at: '2026-01-01T00:00:00Z',
		}),
		write(stateDir, at(`schedules/job-${key}.json`), {
			kind: 'at',
			id: `job-${key}`,
			key,
			at: '2026-12-01T00:00:00.000Z',
			message: 'wake up',
			arm: 1,
		}),
		write(stateDir, at(`queued/${encodeURIComponent(key)}.txt`), 'queued'),
		write(stateDir, at(`holds/hold-${key}.json`), {
			id: `hold-${key}`,
			key,
			tool: 'Bash',
			command: 'rm -rf /',
			filePath: null,
			cwd: null,
			approvable: false,
			reason: 'hard stop',
			state: 'open',
			createdAt: '2026-01-01T00:00:00Z',
			resolvedAt: null,
		}),
		write(stateDir, at('companion-widths.json'), {[key]: 60}),
		write(stateDir, at('state-colors.json'), {Done: '#00ff00'}),
	];
}

test('state two repos kept in files is in the database after the first open, and the files are gone', () => {
	const stateDir = fileHome();
	const files = [
		...writeRepo(stateDir, 'one', 'ONE-1'),
		...writeRepo(stateDir, 'two', 'TWO-1'),
		write(stateDir, 'update-check.json', {
			checkedAt: 5,
			latestVersion: '9.9.9',
		}),
	];

	for (const [repo, key] of [
		['one', 'ONE-1'],
		['two', 'TWO-1'],
	] as const) {
		const stores = daos(stateDir, repo);
		expect(stores.registry.openSpaces()).toEqual([key]);
		expect(stores.spaceIdentities.get(key)).toMatchObject({
			kind: 'identity',
			identity: {
				key,
				worktreePath: path.join(stateDir, '.worktrees', repo, key),
			},
		});
		expect(stores.spaceState.read(key)).toMatchObject({
			profile: 'dev',
			issueTitle: `Title of ${key}`,
		});
		expect(stores.agentSessions.read(key, 'claude')).toBe(`${key}-session`);
		expect(stores.issueMeta.read(key)).toEqual({
			createdByPappardelle: true,
			createdAt: '2026-01-01T00:00:00Z',
		});
		expect(stores.schedules.list().map(job => job.id)).toEqual([`job-${key}`]);
		expect(stores.schedules.queued(key)).toBe('queued');
		expect(stores.holds.list().map(hold => hold.id)).toEqual([`hold-${key}`]);
		expect(stores.companionWidths.get(key)).toBe(60);
		expect(stores.stateColors.load()).toEqual({Done: '#00ff00'});
		expect(stores.updateCheck.read()).toEqual({
			checkedAt: 5,
			latestVersion: '9.9.9',
		});
	}

	expect(files.filter(file => fs.existsSync(file))).toEqual([]);
	// A build from before reads an empty json_sync with no files as in sync,
	// so going back to one leaves the rows alone.
	const {db} = openStateDb(path.join(stateDir, 'state.db'));
	expect(
		db
			.query<{rows: number}, []>('SELECT COUNT(*) AS rows FROM json_sync')
			.get(),
	).toEqual({rows: 0});
});

test('a file a write through the database recorded is not imported again, and is deleted', () => {
	const stateDir = fileHome();
	const dbPath = path.join(stateDir, 'state.db');
	const file = write(stateDir, 'repos/repo/space-state/A-1.json', {
		profile: 'from-the-file',
	});
	// As a flag-on build left it: the row holds a later write than the file
	// it last recorded, which a read of that build would not have replaced.
	const signature = fs.statSync(file, {bigint: true});
	const raw = openStateDb(dbPath);
	raw.db
		.query(
			`INSERT INTO json_sync (path, ino, size, mtime_ns, malformed) VALUES (?, ?, ?, ?, 0)`,
		)
		.run(
			file,
			String(signature.ino),
			Number(signature.size),
			String(signature.mtimeNs),
		);
	raw.db
		.query(`INSERT INTO space_state (repo, key, profile) VALUES (?, ?, ?)`)
		.run('repo', 'A-1', 'from-the-rows');
	closeStateDb(dbPath);

	expect(daos(stateDir, 'repo').spaceState.read('A-1')?.profile).toBe(
		'from-the-rows',
	);
	expect(fs.existsSync(file)).toBe(false);
});

test('a stored record whose file a process without the database removed stays removed', () => {
	const stateDir = fileHome();
	const dbPath = path.join(stateDir, 'state.db');
	const jobFile = path.join(stateDir, 'repos/repo/schedules/fired.json');
	const raw = openStateDb(dbPath);
	raw.db
		.query(
			`INSERT INTO json_sync (path, ino, size, mtime_ns, malformed) VALUES (?, '1', 1, '1', 0)`,
		)
		.run(jobFile);
	raw.db
		.query(
			`INSERT INTO schedules (repo, id, kind, key, at, message, arm) VALUES ('repo', 'fired', 'at', 'A-1', '2026-01-01T00:00:00.000Z', 'hi', 1)`,
		)
		.run();
	closeStateDb(dbPath);

	expect(daos(stateDir, 'repo').schedules.list()).toEqual([]);
});

test('a file that is not state, or cannot be read, is kept, and the rest is imported', () => {
	const stateDir = fileHome();
	const broken = write(stateDir, 'repos/repo/space-state/A-1.json', '{"pro');
	const marker = write(stateDir, 'repos/repo/tui.json', {pid: 'x'});
	const unreadable = path.join(stateDir, 'repos/repo/space-state/A-2.json');
	fs.mkdirSync(unreadable, {recursive: true});
	const sessions = write(
		stateDir,
		'repos/repo/space-state/A-1.agent-sessions.json',
		{claude: {session_id: 'kept', pid: 7, started: 'Mon'}},
	);

	const stores = daos(stateDir, 'repo');
	expect(stores.spaceState.read('A-1')).toBeNull();
	expect(stores.agentSessions.read('A-1', 'claude')).toBe('kept');
	expect([broken, marker, unreadable].map(file => fs.existsSync(file))).toEqual(
		[true, true, true],
	);
	expect(fs.existsSync(sessions)).toBe(false);
});

// The reaper ends the sessions of every space the registry does not list, so
// a registry file the import could not read must not become an empty list.
test('a registry file that is not a registry stops the import until it is fixed', () => {
	const stateDir = fileHome();
	const registry = write(stateDir, 'repos/repo/open-spaces.json', '["A-1"');

	expect(() => daos(stateDir, 'repo').registry.openSpaces()).toThrow(
		'open-spaces.json',
	);
	expect(fs.existsSync(registry)).toBe(true);

	fs.writeFileSync(registry, '["A-1"]');
	expect(daos(stateDir, 'repo').registry.openSpaces()).toEqual(['A-1']);
});

test('a highlight request, hook statuses and the flag left in files are deleted, not imported', () => {
	const stateDir = fileHome();
	const target = write(stateDir, 'repos/repo/highlight-target', 'A-1\tfocus\n');
	const left = [
		write(stateDir, 'claude-status/repo-A-1.json', {status: 'working'}),
		write(stateDir, 'state-flag.json', {sqliteState: true}),
		write(stateDir, 'pr-link.stamp', ''),
	];

	const stores = daos(stateDir, 'repo');
	const requests: string[] = [];
	stores.highlight.watch(request => requests.push(request.issueKey))();
	expect(stores.registry.openSpaces()).toEqual([]);
	expect(requests).toEqual([]);
	expect([target, ...left].filter(file => fs.existsSync(file))).toEqual([]);
	expect(fs.existsSync(path.join(stateDir, 'claude-status'))).toBe(false);
});

test('a file written after the import is never read', () => {
	const stateDir = fileHome();
	const stores = daos(stateDir, 'repo');
	expect(stores.registry.openSpaces()).toEqual([]);
	const late = write(stateDir, 'repos/repo/open-spaces.json', ['LATE-1']);
	closeStateDb(path.join(stateDir, 'state.db'));

	expect(daos(stateDir, 'repo').registry.openSpaces()).toEqual([]);
	expect(fs.existsSync(late)).toBe(true);
});

test('a database moved away from the state directory imports and deletes none of its files', () => {
	const stateDir = fileHome();
	const elsewhere = fileHome();
	const registry = write(stateDir, 'repos/repo/open-spaces.json', ['A-1']);
	const stores = createStateDaos({
		repo: 'repo',
		stateDir,
		dbPath: path.join(elsewhere, 'state.db'),
	});

	expect(stores.registry.openSpaces()).toEqual([]);
	expect(fs.existsSync(registry)).toBe(true);
	closeStateDb(path.join(elsewhere, 'state.db'));
});

test('processes that open a database with files to import at once import them once', async () => {
	const stateDir = fileHome();
	const keys = Array.from({length: 40}, (_, index) => `A-${index}`);
	write(stateDir, 'repos/repo/open-spaces.json', keys);
	for (const key of keys)
		write(stateDir, `repos/repo/space-state/${key}.json`, {profile: key});

	const opener = `
		const {openImportedStateDb} = await import(${JSON.stringify(IMPORT_SCRIPT)});
		const dir = ${JSON.stringify(stateDir)};
		const state = openImportedStateDb(dir + '/state.db', dir, {
			home: dir, socket: 'pappardelle_inner', mainRoot() { throw new Error('none'); },
		});
		const {rows} = state.db.query("SELECT COUNT(*) AS rows FROM space_state WHERE repo = 'repo'").get();
		console.log(rows);
	`;
	const runs = await Promise.all(
		Array.from({length: 4}, async () => {
			const child = Bun.spawn([process.execPath, '-e', opener], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return {exitCode, stdout: stdout.trim(), stderr};
		}),
	);

	expect(runs).toEqual(
		runs.map(run => ({...run, exitCode: 0, stdout: String(keys.length)})),
	);
	expect(daos(stateDir, 'repo').registry.openSpaces()).toEqual(keys);
	// Each import marks itself done, so one mark means one import.
	expect(
		openStateDb(path.join(stateDir, 'state.db'))
			.db.query<
				{marks: number},
				[]
			>('SELECT COUNT(*) AS marks FROM json_import')
			.get(),
	).toEqual({marks: 1});
});

test('an import that cannot take the write lock fails the open instead of serving rows that may be behind the files', () => {
	const stateDir = fileHome();
	const dbPath = path.join(stateDir, 'state.db');
	write(stateDir, 'repos/repo/open-spaces.json', ['A-1']);
	openStateDb(dbPath);
	closeStateDb(dbPath);
	const holder = new Database(dbPath);
	holder.run('BEGIN IMMEDIATE');
	teardown(() => {
		holder.run('ROLLBACK');
		holder.close();
	});

	expect(() => openImportedStateDb(dbPath, stateDir)).toThrow();
	expect(() => daos(stateDir, 'repo').registry.openSpaces()).toThrow();
});
