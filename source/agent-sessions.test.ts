import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {openStateDb, stateDbPath} from './state-db.ts';

const run = promisify(execFile);
const HOOK_MODULE = fileURLToPath(
	new URL('../plugins/pappardelle/hooks/agent_session.py', import.meta.url),
);

const STARTED = 'Mon Nov  2 10:00:00 2026';

type Entry = {session_id: string; pid: number; started: string | null};

function fixture(state: TestState) {
	const {agentSessions} = state.daos;
	return {
		dao: agentSessions,
		file: (key: string) => agentSessions.file(key),
		/** A file as a hook without the database leaves it. */
		record(key: string, sessions: Record<string, Entry>) {
			fs.mkdirSync(path.dirname(agentSessions.file(key)), {recursive: true});
			fs.writeFileSync(
				agentSessions.file(key),
				JSON.stringify(sessions, null, 2) + '\n',
			);
		},
		recorded: (key: string) =>
			JSON.parse(fs.readFileSync(agentSessions.file(key), 'utf8')) as Record<
				string,
				Entry
			>,
	};
}

const entry = (id: string, started: string | null = STARTED): Entry => ({
	session_id: id,
	pid: 7,
	started,
});

contractTest(
	"a space's file is in the space-state directory, where the hook writes it",
	state => {
		expect(state.daos.agentSessions.file('STA-1')).toBe(
			path.join(
				state.stateDir,
				'repos',
				'repo',
				'space-state',
				'STA-1.agent-sessions.json',
			),
		);
	},
);

contractTest(
	'a session id is read back under the agent profile that recorded it',
	state => {
		const f = fixture(state);
		expect(f.dao.read('STA-1', 'claude')).toBe(undefined);
		f.record('STA-1', {claude: entry('a'), codex: entry('b')});
		expect(f.dao.read('STA-1', 'claude')).toBe('a');
		expect(f.dao.read('STA-1', 'codex')).toBe('b');
		expect(f.dao.read('STA-1', 'pi')).toBe(undefined);
		expect(f.dao.read('STA-2', 'claude')).toBe(undefined);
	},
);

contractTest(
	'the agent running in a space is the one that started last',
	state => {
		const f = fixture(state);
		expect(f.dao.latestProfile('STA-1')).toBe(undefined);
		f.record('STA-1', {
			claude: entry('a', 'Mon Nov  2 10:00:00 2026'),
			codex: entry('b', 'Mon Nov  2 11:30:00 2026'),
			old: entry('c', 'Sun Nov  1 23:00:00 2026'),
			unknown: entry('d', null),
		});
		expect(f.dao.latestProfile('STA-1')).toBe('codex');
	},
);

contractTest('a file that is not a set of sessions records nothing', state => {
	const f = fixture(state);
	fs.mkdirSync(path.dirname(f.file('STA-1')), {recursive: true});
	fs.writeFileSync(f.file('STA-1'), '{"claude": {"session_id": "a"');
	expect(f.dao.read('STA-1', 'claude')).toBe(undefined);
	expect(f.dao.latestProfile('STA-1')).toBe(undefined);
});

contractTest(
	'a hook write made after an earlier read is the one read next',
	state => {
		const f = fixture(state);
		f.record('STA-1', {claude: entry('first')});
		expect(f.dao.read('STA-1', 'claude')).toBe('first');
		f.record('STA-1', {claude: entry('second'), codex: entry('other')});
		expect(f.dao.read('STA-1', 'claude')).toBe('second');
		expect(f.dao.read('STA-1', 'codex')).toBe('other');
	},
);

contractTest("a space's sessions are listed by agent profile", state => {
	const f = fixture(state);
	expect(f.dao.sessions('STA-1')).toStrictEqual({
		kind: 'sessions',
		sessions: {},
	});
	f.record('STA-1', {claude: entry('a'), codex: entry('b', null)});
	f.record('STA-2', {claude: entry('c')});
	expect(f.dao.sessions('STA-1')).toStrictEqual({
		kind: 'sessions',
		sessions: {claude: 'a', codex: 'b'},
	});
});

contractTest('the spaces with sessions are listed', state => {
	const f = fixture(state);
	expect(f.dao.keys()).toStrictEqual([]);
	f.record('STA-1', {claude: entry('a')});
	f.record('main', {claude: entry('b')});
	// The space-state file of a space sits in the same directory.
	fs.writeFileSync(
		path.join(path.dirname(f.file('STA-1')), 'STA-3.json'),
		JSON.stringify({profile: 'dev'}),
	);
	expect(f.dao.keys().sort()).toStrictEqual(['STA-1', 'main']);
	fs.rmSync(f.file('STA-1'));
	expect(f.dao.keys()).toStrictEqual(['main']);
});

contractTest(
	'renaming a profile moves its session and keeps the others in place',
	async state => {
		const f = fixture(state);
		f.record('STA-1', {
			pi: entry('p'),
			claude: entry('a'),
			codex: entry('b'),
		});
		await f.dao.renameProfile('STA-1', 'claude', 'alpha-claude');
		expect(f.recorded('STA-1')).toStrictEqual({
			pi: entry('p'),
			'alpha-claude': entry('a'),
			codex: entry('b'),
		});
		expect(Object.keys(f.recorded('STA-1'))).toStrictEqual([
			'pi',
			'alpha-claude',
			'codex',
		]);
		expect(f.dao.read('STA-1', 'alpha-claude')).toBe('a');
		expect(f.dao.read('STA-1', 'claude')).toBe(undefined);
	},
);

contractTest(
	'a rename changes nothing when the old name has no session or the new one has its own',
	async state => {
		const f = fixture(state);
		f.record('STA-1', {claude: entry('a'), codex: entry('b')});
		const before = fs.readFileSync(f.file('STA-1'), 'utf8');
		await f.dao.renameProfile('STA-1', 'pi', 'pi-fast');
		await f.dao.renameProfile('STA-1', 'claude', 'codex');
		await f.dao.renameProfile('STA-2', 'claude', 'alpha-claude');
		expect(fs.readFileSync(f.file('STA-1'), 'utf8')).toBe(before);
		expect(fs.existsSync(f.file('STA-2'))).toBe(false);
		expect(f.dao.read('STA-1', 'claude')).toBe('a');
		expect(f.dao.read('STA-1', 'codex')).toBe('b');
	},
);

contractTest(
	'clearing a space forgets its sessions and leaves other spaces alone',
	async state => {
		const f = fixture(state);
		f.record('STA-1', {claude: entry('a')});
		f.record('STA-2', {claude: entry('b')});
		expect(f.dao.read('STA-1', 'claude')).toBe('a');
		await f.dao.clear('STA-1');
		expect(f.dao.read('STA-1', 'claude')).toBe(undefined);
		expect(fs.existsSync(f.file('STA-1'))).toBe(false);
		expect(f.dao.read('STA-2', 'claude')).toBe('b');
		await f.dao.clear('STA-9');
	},
);

test('the two stores leave the same files for the same history', async () => {
	const files = [];
	for (const sqlite of [false, true]) {
		const f = fixture(testState({sqlite}));
		f.record('STA-1', {
			claude: entry('a'),
			codex: entry('b', null),
		});
		f.record('STA-2', {claude: entry('c')});
		await f.dao.renameProfile('STA-1', 'claude', 'alpha-claude');
		await f.dao.renameProfile('STA-1', 'codex', 'codex-high');
		await f.dao.clear('STA-2');
		files.push({
			one: fs.readFileSync(f.file('STA-1'), 'utf8'),
			two: fs.existsSync(f.file('STA-2')),
		});
	}

	expect(files[0]).toStrictEqual(files[1]);
	expect(JSON.parse(files[0]!.one)).toStrictEqual({
		'alpha-claude': entry('a'),
		'codex-high': entry('b', null),
	});
	expect(files[0]!.two).toBe(false);
});

// The hook and a config migration both rewrite the whole file. Without the
// database either could write back what it read before the other's change.
test('sqlite: a session recorded by the hook and a profile renamed by another process both survive', async () => {
	// The hook finds the files under its home directory.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-hook-home-'));
	teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const state = testState({
		sqlite: true,
		stateDir: path.join(home, '.pappardelle'),
	});
	const f = fixture(state);
	const dbPath = stateDbPath(state.stateDir);
	// The hook only writes to a database that Pappardelle has already created.
	openStateDb(dbPath);
	const keys = Array.from({length: 25}, (_, i) => `STA-${i}`);
	for (const key of keys) {
		f.record(key, {claude: entry(`${key}-claude`)});
		await state.daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: 'repo',
				key,
				worktreePath: path.join(home, key),
				socket: 'pappardelle_inner',
			}),
		);
		await state.daos.spaceState.write(key, {
			agentProfile: {name: 'codex', isClaude: false},
		});
	}

	// The real hook code, under a process table that says codex runs in the
	// agent pane of each space in turn.
	const hook = run(
		'python3',
		[
			'-c',
			`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("agent_session", sys.argv[1])
agent_session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_session)
table = {
    100: (99, "python3 record-agent-session.py"),
    99: (98, "sh -c python3 record-agent-session.py"),
    98: (97, "codex --yolo"),
    97: (96, "zsh -ic codex --yolo"),
    96: (1, "tmux -L pappardelle_inner new-session"),
}
for key in sys.argv[2:]:
    assert agent_session.record_agent_session(
        {"session_id": key + "-codex", "hook_event_name": "SessionStart"},
        False, {"PAPPARDELLE_REPO": "repo", "PAPPARDELLE_SPACE": key}, 100, lambda: table,
        pane_session=lambda _env: agent_session.PaneSession("agent-repo-" + key, True),
        started=lambda _pid: ${JSON.stringify(STARTED)},
    )
`,
			HOOK_MODULE,
			...keys,
		],
		{
			env: {
				PATH: process.env['PATH'],
				// tmux falls back to the live tmux directory without it.
				TMUX_TMPDIR: process.env['TMUX_TMPDIR'],
				// This env is an allow-list, and without TMPDIR the hook would write
				// to /tmp instead of the run tmpdir.
				TMPDIR: os.tmpdir(),
				HOME: home,
				PAPPARDELLE_SQLITE_STATE: '1',
				PAPPARDELLE_STATE_DB: dbPath,
			},
		},
	);
	await Promise.all([
		hook,
		...keys.map(async key =>
			f.dao.renameProfile(key, 'claude', 'alpha-claude'),
		),
	]);

	for (const key of keys) {
		expect(f.dao.read(key, 'alpha-claude')).toBe(`${key}-claude`);
		expect(f.dao.read(key, 'codex')).toBe(`${key}-codex`);
		expect(
			Object.fromEntries(
				Object.entries(f.recorded(key)).map(([name, session]) => [
					name,
					session.session_id,
				]),
			),
		).toStrictEqual({'alpha-claude': `${key}-claude`, codex: `${key}-codex`});
	}

	// Each hook write went through the database: nothing was left to import.
	expect(
		openStateDb(dbPath)
			.db.query<
				{rows: number},
				[]
			>(`SELECT COUNT(*) AS rows FROM agent_sessions WHERE repo = 'repo'`)
			.get()!.rows,
	).toBe(keys.length * 2);
	expect(
		fs.existsSync(path.join(state.stateDir, 'logs', 'hook-events.log')),
	).toBe(false);
});
