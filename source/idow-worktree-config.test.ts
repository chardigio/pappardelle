/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import {Database} from 'bun:sqlite';
import {type ExecException, execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {parse, stringify} from 'yaml';
import {repoNameFromGitCommonDir} from './config.ts';
import {newSpaceIdentity, protectedSessionNames} from './space-identity.ts';
import {createStateDaos} from './state-daos.ts';
import {closeStateDb, stateDbPath} from './state-db.ts';
import {sqliteRun} from '../test/helpers/state.ts';
import {
	cleanupOrphanedInnerSessions,
	initTmuxState,
	type OuterTmuxRunner,
} from './tmux.ts';
import {setup, writeScript} from '../test/helpers/idow-fixture.ts';

test('idow creates and reopens real worktrees in the main repository namespace', async () => {
	const fixture = setup(true);
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	expect(output.includes(`Worktree:  ${fixture.workspace}`), output).toBe(true);
	expect(fs.existsSync(path.join(fixture.workspace, '.git'))).toBe(true);
	const args = fs.readFileSync(fixture.launchArgs, 'utf8');
	expect(args.includes(`--repo-name\n${path.basename(fixture.main)}\n`)).toBe(
		true,
	);
	expect(args.includes('--agent-launch-flags\n--model linked-model\n')).toBe(
		true,
	);
	expect(
		fs.existsSync(
			path.join(
				fixture.home,
				'.pappardelle',
				'repos',
				path.basename(fixture.main),
				'space-state',
				'test-abc.json',
			),
		),
	).toBe(true);
	const reopened = await fixture.run();
	expect(
		reopened.includes(`Worktree exists: ${fixture.workspace}`),
		reopened,
	).toBe(true);
	expect(reopened.includes('Created worktree:')).toBe(false);
});

test("a new worktree links the main checkout's CLAUDE.local.md", async () => {
	const fixture = setup(true);
	const notes = path.join(fixture.main, 'CLAUDE.local.md');
	fs.writeFileSync(notes, '# notes\n');
	await fixture.run();
	expect(fs.readlinkSync(path.join(fixture.workspace, 'CLAUDE.local.md'))).toBe(
		notes,
	);
	const status = execFileSync(
		'git',
		['-C', fixture.workspace, 'status', '--porcelain'],
		{encoding: 'utf8'},
	);
	expect(status.includes('CLAUDE.local.md'), status).toBe(false);
});

test('idow creates a session using main config and worktree-local overrides', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.local.yml'),
		'claude:\n  model: linked-model\n',
	);
	const output = await fixture.run();
	expect(fs.existsSync(fixture.vcsCalls)).toBe(false);
	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(output.includes('Profile:   Main config'), output).toBe(true);
	expect(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model linked-model\n'),
	).toBe(true);
	expect(
		fs.readFileSync(
			path.join(fixture.workspace, '.pappardelle.local.yml'),
			'utf8',
		),
	).toBe('claude:\n  model: linked-model\n');
	for (const file of ['.env', 'profile.env']) {
		expect(fs.readFileSync(path.join(fixture.workspace, file), 'utf8')).toBe(
			'FROM_MAIN=1\n',
		);
	}
});

test('idow opens from a linked checkout and expands both repository roots', async () => {
	const fixture = setup();
	const output = await fixture.run({open: true, projectRoot: false});
	expect(fs.readFileSync(fixture.vcsCalls, 'utf8').includes('pr view')).toBe(
		true,
	);
	expect(output.includes('https://github.com/test/repo/pull/1')).toBe(true);
	expect(output.includes('Workspace test-abc is ready!'), output).toBe(true);
	expect(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model main-model\n'),
	).toBe(true);
	expect(fs.readFileSync(path.join(fixture.workspace, 'roots'), 'utf8')).toBe(
		`${fixture.main}\n${fixture.linked}\n`,
	);
});

test('idow names a space the same from a linked worktree as from the main checkout', async () => {
	const named = [];
	for (const from of ['main', 'linked'] as const) {
		const fixture = setup();
		await fixture.run({projectRoot: false, cwd: fixture[from]});
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		named.push({
			repo: after('--repo-name'),
			agent: after('--agent-session'),
			companion: after('--companion-session'),
		});
		if (sqliteRun) {
			const db = new Database(
				path.join(fixture.home, '.pappardelle', 'state.db'),
				{readonly: true},
			);
			teardown(() => {
				db.close();
			});
			expect(
				db
					.query(
						'SELECT repo, key, agent_session, companion_session FROM space_identities ORDER BY key',
					)
					.all(),
			).toStrictEqual([
				{
					repo: 'main checkout',
					key: 'main',
					agent_session: 'agent-main checkout-main',
					companion_session: 'companion-main checkout-main',
				},
				{
					repo: 'main checkout',
					key: 'test-abc',
					agent_session: 'agent-main checkout-test-abc',
					companion_session: 'companion-main checkout-test-abc',
				},
			]);
		}
	}

	expect(named).toStrictEqual([
		{
			repo: 'main checkout',
			agent: 'agent-main checkout-test-abc',
			companion: 'companion-main checkout-test-abc',
		},
		{
			repo: 'main checkout',
			agent: 'agent-main checkout-test-abc',
			companion: 'companion-main checkout-test-abc',
		},
	]);
});

if (sqliteRun) {
	test('a space idow opened from a linked worktree survives the reap of a TUI started from another', async () => {
		const fixture = setup();
		await fixture.run({
			projectRoot: false,
			cwd: fixture.linked,
			extraEnv: {PAPPARDELLE_REGISTER_SPACE: '1'},
		});
		const other = path.join(path.dirname(fixture.main), 'other linked');
		execFileSync('git', [
			'-C',
			fixture.main,
			'worktree',
			'add',
			'-b',
			'other',
			other,
		]);
		const repo = repoNameFromGitCommonDir(
			execFileSync(
				'git',
				['rev-parse', '--path-format=absolute', '--git-common-dir'],
				{cwd: other, encoding: 'utf8'},
			).trim(),
		);
		const stateDir = path.join(fixture.home, '.pappardelle');
		const daos = createStateDaos({
			repo,
			stateDir,
			sqlite: true,
			home: fixture.home,
			mainRoot: () => fixture.main,
		});
		teardown(() => {
			daos.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
		});
		initTmuxState(daos);
		const owned = protectedSessionNames(daos.registry, daos.spaceIdentities);
		if (owned.kind !== 'names') {
			expect.unreachable(`the reap would be skipped: ${JSON.stringify(owned)}`);
			return;
		}

		const live = [
			'agent-main checkout-test-abc',
			'companion-main checkout-test-abc',
			'agent-main checkout-main',
			'agent-main checkout-gone-1',
		];
		const killed: string[] = [];
		const runner: OuterTmuxRunner = args => {
			if (args[0] === 'kill-session') killed.push(args[2]!);
			return {
				status: 0,
				stdout: args[0] === 'list-sessions' ? live.join('\n') : '',
			};
		};
		expect(cleanupOrphanedInnerSessions(owned, repo, runner, [repo])).toBe(1);
		expect(killed).toStrictEqual(['=agent-main checkout-gone-1:']);
	});
}

if (sqliteRun) {
	test('idow opens a space in the worktree the stores name', async () => {
		const fixture = setup();
		const stateDir = path.join(fixture.home, '.pappardelle');
		const daos = createStateDaos({
			repo: path.basename(fixture.main),
			stateDir,
			sqlite: true,
			home: fixture.home,
			mainRoot: () => fixture.main,
		});
		teardown(() => {
			daos.disconnectStatusDaemon();
			closeStateDb(stateDbPath(stateDir));
		});
		const stored = path.join(fixture.home, 'elsewhere', 'login');
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo: path.basename(fixture.main),
				key: 'test-abc',
				worktreePath: stored,
				socket: 'pappardelle_inner',
			}),
		);
		await fixture.run();
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		expect(args[args.indexOf('--worktree') + 1]).toBe(stored);
		expect(fs.existsSync(stored)).toBe(true);
	});
}

test('idow prefers a worktree project config while falling back for local config', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.linked, '.pappardelle.yml'),
		fixture.config('Linked config'),
	);
	const output = await fixture.run();
	expect(output.includes('Profile:   Linked config'), output).toBe(true);
	expect(
		fs
			.readFileSync(fixture.launchArgs, 'utf8')
			.includes('--agent-launch-flags\n--model main-model\n'),
	).toBe(true);
});

test('background initialization releases setup pipes before the hook finishes', async () => {
	const fixture = setup();
	const hook = path.join(fixture.main, 'background.sh');
	writeScript(
		hook,
		`
touch "$IDOW_TEST_WORKSPACE/background-started"
while [[ ! -f "$IDOW_TEST_WORKSPACE/release" ]]; do
	kill -0 "$IDOW_TEST_RUNNER_PID" 2>/dev/null || exit 1
	sleep 0.05
done
printf 'background stdout\\n'
printf 'background stderr\\n' >&2
touch "$IDOW_TEST_WORKSPACE/background-finished"`,
	);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					name: 'Background hook',
					run: 'bash "${MAIN_REPO_ROOT}/background.sh"',
					background: true,
				},
			],
		}),
	);
	let exited = () => {};
	const exit = new Promise<void>(resolve => {
		exited = resolve;
	});
	// A killed runner never reaches the finally that writes the release file,
	// so the hook watches the runner instead of polling forever.
	const result = fixture.run({
		onExit: exited,
		extraEnv: {IDOW_TEST_RUNNER_PID: String(process.pid)},
	});
	try {
		await Promise.race([exit, result]);
		for (
			let i = 0;
			i < 100 &&
			!fs.existsSync(path.join(fixture.workspace, 'background-started'));
			i++
		)
			await delay(10);
		expect(
			fs.existsSync(path.join(fixture.workspace, 'background-started')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(fixture.workspace, 'background-finished')),
		).toBe(false);
		const closed = await Promise.race([
			result.then(() => true),
			delay(1000).then(() => false),
		]);
		expect(
			closed,
			'Background hook must not hold the setup stdout/stderr pipes open',
		).toBe(true);
	} finally {
		fs.writeFileSync(path.join(fixture.workspace, 'release'), '');
		await result;
		for (
			let i = 0;
			i < 100 &&
			!fs.existsSync(path.join(fixture.workspace, 'background-finished'));
			i++
		)
			await delay(10);
	}
	expect(
		fs.existsSync(path.join(fixture.workspace, 'background-finished')),
	).toBe(true);
	const logDir = path.join(fixture.home, 'Library/Logs/stardust-workspace');
	const files = fs
		.readdirSync(logDir)
		.filter(name => name.startsWith('idow-test-abc-'));
	expect(files.length).toBe(1);
	const log = fs.readFileSync(path.join(logDir, files[0]!), 'utf8');
	expect(log.includes('[test-abc]')).toBe(true);
	expect(log.includes('background stdout')).toBe(true);
	expect(log.includes('background stderr')).toBe(true);
});

test('idow rotates per invocation and prunes only old invocation logs', async () => {
	const fixture = setup();
	const dir = path.join(fixture.home, 'Library/Logs/stardust-workspace');
	fs.mkdirSync(dir, {recursive: true});
	const stale = path.join(dir, 'idow-old-workspace-20200101-test.log');
	const unrelated = path.join(dir, 'unrelated.log');
	for (const file of [stale, unrelated]) {
		fs.writeFileSync(file, 'old');
		fs.utimesSync(file, new Date(0), new Date(0));
	}
	await fixture.run();
	await fixture.run();
	const files = fs.readdirSync(dir);
	expect(files.includes(path.basename(stale))).toBe(false);
	expect(files.includes('unrelated.log')).toBe(true);
	expect(files.filter(name => name.startsWith('idow-test-abc-')).length).toBe(
		2,
	);
});

// Step 9 tries Ghostty, then iTerm, then the default terminal, and stops at the
// first that opens. Only a run where every launcher fails may exit non-zero:
// the TUI keys its "Opened" / "Open failed" header off that exit code.
const fallbackCases = [
	{
		title: 'Ghostty opens and nothing else runs',
		app: 'Ghostty',
		failing: [],
		ran: ['ghostty'],
	},
	{
		title: 'a failed Ghostty falls back to iTerm',
		app: 'Ghostty',
		failing: ['GHOSTTY'],
		ran: ['ghostty', 'iterm'],
	},
	{
		title: 'a failed iTerm falls back to the default terminal',
		app: 'Ghostty',
		failing: ['GHOSTTY', 'ITERM'],
		ran: ['ghostty', 'iterm', 'default'],
	},
	{
		title: 'every launcher failing reports failure',
		app: 'Ghostty',
		failing: ['GHOSTTY', 'ITERM', 'DEFAULT'],
		ran: ['ghostty', 'iterm', 'default'],
	},
	{
		title:
			'a terminal Pappardelle does not drive opens in the default terminal',
		app: 'Alacritty',
		failing: [],
		ran: ['default'],
	},
];

for (const c of fallbackCases) {
	test(`step 9: ${c.title}`, async () => {
		const fixture = setup();
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			`claude:\n  model: main-model\nterminal:\n  app: ${c.app}\n`,
		);
		const run = fixture.run({
			open: true,
			extraEnv: Object.fromEntries(
				c.failing.map(name => [`IDOW_TEST_EXIT_${name}`, '1']),
			),
		});
		if (c.failing.length === 3) {
			const error = await rejectionOf(run);
			expect((error as ExecException | undefined)?.code).toBe(1);
		} else {
			await run;
		}

		const ran = fs
			.readFileSync(fixture.launchers, 'utf8')
			.trim()
			.split('\n')
			.map(line => line.split(' ')[0]);
		expect(ran).toStrictEqual(c.ran);
	});
}

// The window is captured before worktree creation and profile commands, which
// can run for minutes, so the tab lands where the user pressed `o` rather than
// wherever focus has moved since.
test('step 9 hands Ghostty the window captured at startup', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		'claude:\n  model: main-model\nterminal:\n  app: Ghostty\n',
	);
	await fixture.run({open: true});
	expect(fs.readFileSync(fixture.launchers, 'utf8')).toMatch(
		/^ghostty .*--window-id tab-group-test/m,
	);
});

test('an explicit profile pick on an existing space is persisted and reused', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const statePath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.json',
	);
	const persisted = () =>
		(JSON.parse(fs.readFileSync(statePath, 'utf8')) as {profile: string})
			.profile;
	const agentCommand = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-command') + 1];
	};

	await fixture.run();
	expect(persisted()).toBe('dev');
	// create-worktree.sh is stubbed to build the workspace elsewhere, so idow
	// only sees an existing worktree once its own path exists.
	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});

	// Reopening with a different pick: the worktree already exists.
	await fixture.run({profile: 'other'});
	expect(persisted()).toBe('other');
	expect(agentCommand()).toBe('codex');

	// An unforced run (the TUI's `o`) keeps the picked profile instead of
	// falling back to default_profile.
	const output = await fixture.run({open: true});
	expect(persisted()).toBe('other');
	expect(agentCommand()).toBe('codex');
	expect(output.includes('Profile:   Other'), output).toBe(true);
});
