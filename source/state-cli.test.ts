import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {testState} from '../test/helpers/state.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {until} from '../test/helpers/wait.ts';
import type {HighlightRequest} from './highlight.ts';

const helper = fileURLToPath(
	new URL('../scripts/state-cli.sh', import.meta.url),
);

function pappardelleState(
	args: string[],
	home: string,
	env: Record<string, string> = {},
) {
	return spawnSync(
		'bash',
		['-c', 'source "$0"; pappardelle_state "$@"', helper, ...args],
		{
			encoding: 'utf8',
			// No PAPPARDELLE_EXECUTABLE: the helper has to find the binary itself,
			// as it does when idow is run by hand.
			env: {
				PATH: process.env['PATH'],
				TMUX_TMPDIR: process.env['TMUX_TMPDIR'],
				HOME: home,
				...env,
			},
		},
	);
}

test('a script can ask the binary to create the database', () => {
	const home = tempDir('papp-state-cli-');
	const dbPath = path.join(home, 'state.db');
	const result = pappardelleState(['migrate', dbPath], home);
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	const db = new Database(dbPath, {readonly: true});
	expect(
		db.query("SELECT name FROM sqlite_master WHERE name = 'json_import'").get(),
	).toBeTruthy();
	db.close();
});

// install.sh passes no path, so it sets up whichever database the app opens.
test('migrate without a path creates the database PAPPARDELLE_STATE_DB names', () => {
	const home = tempDir('papp-state-cli-');
	const dbPath = path.join(home, 'moved', 'state.db');
	const result = pappardelleState(['migrate'], home, {
		PAPPARDELLE_STATE_DB: dbPath,
	});
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	expect(fs.existsSync(dbPath)).toBe(true);
	expect(fs.existsSync(path.join(home, '.pappardelle', 'state.db'))).toBe(
		false,
	);
});

// install.sh's own message does not name the database it could not set up.
test('a migrate that fails names the database', () => {
	const home = tempDir('papp-state-cli-');
	const notADir = path.join(home, 'file');
	fs.writeFileSync(notADir, '');
	const dbPath = path.join(notADir, 'state.db');
	const result = pappardelleState(['migrate'], home, {
		PAPPARDELLE_STATE_DB: dbPath,
	});
	expect(result.status).toBe(3);
	expect(result.stderr).toContain(dbPath);
});

test('an unknown verb fails without starting anything else', () => {
	const home = tempDir('papp-state-cli-');
	const result = pappardelleState(['open-a-space', 'KEY-1'], home);
	expect(result.status).toBe(2);
	expect(result.stderr).toMatch(/unknown verb open-a-space/);
	expect(fs.readdirSync(home)).toStrictEqual([]);
});

// idow reads 1 from `space get` as "no such space" and goes on with defaults.
test('a verb that fails exits 3, never the not-found 1', () => {
	const home = tempDir('papp-state-cli-');
	const notADir = path.join(home, 'file');
	fs.writeFileSync(notADir, '');
	const result = pappardelleState(
		['migrate', path.join(notADir, 'state.db')],
		home,
	);
	expect(result.status, `stderr: ${result.stderr}`).toBe(3);
});

// idow reads 3 as a verb that ran and failed; a mistyped flag never ran it.
test('a bad flag on a verb is a usage error naming the verb and the flag', () => {
	const home = tempDir('papp-state-cli-');
	const cases: Array<[string[], RegExp]> = [
		[
			['check-config', '--project-root', home, '--main-root', home, '--bogus'],
			/check-config: Unknown option '--bogus'/,
		],
		[
			['prepare-space', '--bogus', 'STA-1'],
			/prepare-space: Unknown option '--bogus'/,
		],
		[
			['prepare-space', 'STA-1', '--repo'],
			/prepare-space: Option '--repo <value>' argument missing/,
		],
	];
	for (const [args, stderr] of cases) {
		const result = pappardelleState(args, home);
		expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(2);
		expect(result.stderr).toMatch(stderr);
	}
});

test('check-agent-profile reads the layers idow reads, from the roots it is given', () => {
	const home = tempDir('papp-state-cli-');
	const project = path.join(home, 'linked');
	const main = path.join(home, 'main');
	fs.mkdirSync(project);
	fs.mkdirSync(main);
	fs.writeFileSync(
		path.join(project, '.pappardelle.yml'),
		'version: 1\nissue_tracker:\n  provider: beads\nprofiles:\n  dev:\n    display_name: Dev\n',
	);
	// Only the main checkout has the untracked local config.
	fs.writeFileSync(
		path.join(main, '.pappardelle.local.yml'),
		'agent_profiles:\n  codex:\n    command: codex\n',
	);
	const check = (name: string) =>
		pappardelleState(
			[
				'check-agent-profile',
				'--project-root',
				project,
				'--main-root',
				main,
				name,
			],
			home,
		);

	const known = check('codex');
	expect(known.status, `stderr: ${known.stderr}`).toBe(0);
	expect(check('claude').status).toBe(0);
	const unknown = check('codx');
	expect(unknown.status).toBe(1);
	expect(unknown.stderr.trim()).toBe(
		'Unknown agent profile "codx". Agent profiles: claude, codex',
	);
});

test('prepare-space stores an issue title that starts with a dash', () => {
	const home = tempDir('papp-state-cli-');
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
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	const {spaceState} = testState({stateDir}).daos;
	expect(spaceState.read('STA-1')?.issueTitle).toBe('-x');
});

test('prepare-space --open lists the space as open, with the worktree it was given', () => {
	const home = tempDir('papp-state-cli-');
	const stateDir = path.join(home, '.pappardelle');
	const worktree = path.join(home, 'elsewhere');
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('state-cli.ts', import.meta.url)),
			'prepare-space',
			'--repo',
			'repo',
			'--worktree',
			worktree,
			'--main-root',
			path.join(home, 'repo'),
			'--open',
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
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	const {registry, spaceIdentities} = testState({stateDir}).daos;
	expect(registry.openSpaces()).toStrictEqual(['STA-1']);
	expect(spaceIdentities.get('STA-1')).toMatchObject({
		identity: {worktreePath: worktree},
	});
});

test("launch-agent records the agent profile a space's agent session starts with", () => {
	const home = tempDir('papp-state-cli-');
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
	const {spaceState} = testState({stateDir}).daos;
	expect(launch('--agent-profile', 'opus', '--claude').status).toBe(0);
	expect(spaceState.read('STA-1')?.agentProfile).toStrictEqual({
		name: 'opus',
		isClaude: true,
	});
	expect(launch('--agent-profile', 'codex').status).toBe(0);
	expect(spaceState.read('STA-1')?.agentProfile).toStrictEqual({
		name: 'codex',
		isClaude: false,
	});
	expect(launch().status).toBe(2);
});

test('check-config passes a valid or missing config and fails an invalid one with its errors', () => {
	const home = tempDir('papp-state-cli-');
	const project = path.join(home, 'project');
	fs.mkdirSync(project);
	const check = () =>
		pappardelleState(
			['check-config', '--project-root', project, '--main-root', project],
			home,
		);

	const missing = check();
	expect(missing.status, `stderr: ${missing.stderr}`).toBe(0);

	fs.writeFileSync(
		path.join(project, '.pappardelle.yml'),
		'version: 1\nprofiles: {}\n',
	);
	const valid = check();
	expect(valid.status, `stderr: ${valid.stderr}`).toBe(0);

	// Broken in an agent profile no space uses: the TUI still rejects it.
	fs.writeFileSync(
		path.join(project, '.pappardelle.yml'),
		'version: 1\nprofiles: {}\nagent_profiles:\n  opus:\n    command: claude\n    model: 7\n',
	);
	const invalid = check();
	expect(invalid.status).toBe(1);
	expect(invalid.stderr).toMatch(
		/agent_profiles\.opus\.model: must be a string/,
	);
});

test('migrate takes at most one database path', () => {
	const dir = tempDir('papp-state-cli-');
	const migrate = (...args: string[]) =>
		spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL('state-cli.ts', import.meta.url)),
				'migrate',
				...args,
			],
			{encoding: 'utf8', cwd: dir},
		);

	const flag = migrate('--bogus');
	expect(flag.status, `stderr: ${flag.stderr}`).toBe(2);
	expect(flag.stderr).toMatch(/migrate: Unknown option '--bogus'/);
	const extra = migrate('a.db', 'b.db');
	expect(extra.status, `stderr: ${extra.stderr}`).toBe(2);
	expect(extra.stderr).toMatch(/migrate takes at most one database path/);
	expect(fs.readdirSync(dir)).toStrictEqual([]);
});

// idow takes a recorded identity as the space's: a registration that is
// refused must not leave one behind.
test('prepare-space --register without an owner records nothing', () => {
	const home = tempDir('papp-state-cli-');
	const stateDir = path.join(home, '.pappardelle');
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('state-cli.ts', import.meta.url)),
			'prepare-space',
			'--repo',
			'repo',
			'--worktree',
			path.join(home, 'elsewhere'),
			'--main-root',
			path.join(home, 'repo'),
			'--register',
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
	expect(result.status, `stderr: ${result.stderr}`).toBe(2);
	expect(result.stderr.trim()).toBe(
		'pappardelle --internal-state: prepare-space: --register needs --owner <pid>',
	);
	expect(fs.existsSync(stateDir)).toBe(false);
	expect(testState({stateDir}).daos.spaceIdentities.get('STA-1').kind).toBe(
		'unknown',
	);
});

test('a highlight request made through the highlight verb reaches the TUI watching that repo', async () => {
	const home = tempDir('papp-state-cli-');
	const stateDir = path.join(home, '.pappardelle');
	const {highlight} = testState({stateDir}).daos;
	const seen: HighlightRequest[] = [];
	teardown(highlight.watch(request => seen.push(request)));

	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('state-cli.ts', import.meta.url)),
			'highlight',
			'--repo',
			'repo',
			'STA-1',
			'--focus',
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
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	await until(() => seen.length > 0, {what: 'the request to reach the watch'});
	expect(seen).toStrictEqual([{issueKey: 'STA-1', focus: true}]);
});
