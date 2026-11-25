/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {parse, stringify} from 'yaml';
import {sqliteRun} from '../test/helpers/state.ts';
import {setup, writeScript} from '../test/helpers/idow-fixture.ts';

test('setup merges config once and does not resolve the terminal', async () => {
	const fixture = setup();
	await fixture.run();
	const calls = fs.readFileSync(fixture.configCalls, 'utf8').split('\n');
	expect(calls.filter(call => call === 'eval-all').length).toBe(1);
	expect(calls.some(call => call.includes('.terminal.app'))).toBe(false);
});

test('opening without PR consumers skips VCS lookup', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({profiles: {dev: {links: []}}}),
	);
	const output = await fixture.run({open: true});
	expect(fs.existsSync(fixture.vcsCalls)).toBe(false);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);
	expect(output.includes('PR:')).toBe(false);
	expect(output.includes('Skipping PR/MR lookup'), output).toBe(true);
});

test('newly created issues launch fresh; existing keys keep conversation resume', async () => {
	const fixture = setup();
	const resumeArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-resume-args') + 1];
	};
	await fixture.run({input: 'Make workspace startup faster'});
	expect(resumeArgs()).toBe('');
	await fixture.run();
	expect(resumeArgs()).toBe('--continue');
});

// A tracker can hand a new issue the key of one that was deleted. The agent
// of the new issue must not resume the old one's conversation.
test('a new issue drops the sessions recorded under its key; an existing one keeps them', async () => {
	const fixture = setup();
	const stateDir = path.join(fixture.home, '.pappardelle');
	const sessionsPath = path.join(
		stateDir,
		'repos/main checkout/space-state/test-abc.agent-sessions.json',
	);
	const record = () => {
		fs.mkdirSync(path.dirname(sessionsPath), {recursive: true});
		fs.writeFileSync(
			sessionsPath,
			JSON.stringify({claude: {session_id: 'earlier', pid: 1, started: null}}),
		);
	};

	record();
	await fixture.run({input: 'Make workspace startup faster'});
	expect(fs.existsSync(sessionsPath)).toBe(false);
	if (sqliteRun) {
		const db = new Database(path.join(stateDir, 'state.db'), {readonly: true});
		expect(db.query('SELECT * FROM agent_sessions').all()).toStrictEqual([]);
		db.close();
	}

	record();
	await fixture.run();
	expect(fs.existsSync(sessionsPath)).toBe(true);
});

// Resume mode reopens a space: if the agent has nothing to resume it starts
// idle instead of being handed the issue key.
test('resume mode launches without a prompt; agy gets its built-in prompt flag', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {argon: {command: 'agy', model: 'gemini-4-argon-medium'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'argon'}},
		}),
	);
	const launchArgs = () =>
		fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');

	await fixture.run({profile: 'other'});
	let args = launchArgs();
	expect(args.includes('--no-prompt')).toBe(false);
	expect(args[args.indexOf('--agent-prompt-args') + 1]).toBe('-i {prompt}');
	expect(args[args.indexOf('--agent-launch-flags') + 1]).toBe(
		'--model gemini-4-argon-medium',
	);

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	await fixture.run({open: true});
	args = launchArgs();
	expect(args.includes('--no-prompt')).toBe(true);
	expect(args.includes('--init-cmd')).toBe(false);
});

test('a bad claude config fails before the issue is created', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({claude: {extra_args: '--verbose'}}),
	);
	await rejectionOf(fixture.run({input: 'Make workspace startup faster'}));
	expect(
		fs.existsSync(
			path.join(fixture.home, '.pappardelle', 'repos', 'main checkout'),
		),
	).toBe(false);
});

test('batched commands preserve order, multiline strings and command stdin', async () => {
	const fixture = setup();
	const expected = 'a\tb\nquoted "text" and \u0024(literal)\n';
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				// Reading stdin must not consume the next command's config record.
				{name: 'Read stdin\n\n', run: 'cat > "${WORKTREE_PATH}/stdin"'},
				{run: `printf '%s' '${expected}' > "\${WORKTREE_PATH}/value"`},
				{run: 'false', continue_on_error: true},
				{run: 'printf done >> "${WORKTREE_PATH}/value"'},
			],
		}),
	);
	const output = await fixture.run();
	expect(output.includes('Read stdin\n'), output).toBe(true);
	expect(output.includes('Read stdin\n\n'), output).toBe(false);
	expect(
		output.includes('post_workspace_init: post_workspace_init[1] ->'),
		output,
	).toBe(true);
	expect(fs.readFileSync(path.join(fixture.workspace, 'stdin'), 'utf8')).toBe(
		'',
	);
	expect(fs.readFileSync(path.join(fixture.workspace, 'value'), 'utf8')).toBe(
		expected + 'done',
	);
});

test('an aliased post_workspace_init list still runs', async () => {
	const fixture = setup();
	const config = parse(fixture.config('Main config')) as Record<
		string,
		unknown
	>;
	delete config['post_workspace_init'];
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.yml'),
		stringify(config) +
			'common: &common\n  - run: touch "${WORKTREE_PATH}/aliased"\npost_workspace_init: *common\n',
	);
	await fixture.run();
	expect(fs.existsSync(path.join(fixture.workspace, 'aliased'))).toBe(true);
});

test('a failing required command still stops setup before Claude starts', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{run: 'false'},
				{run: 'touch "${WORKTREE_PATH}/unexpected"'},
			],
		}),
	);
	await rejectionOf(fixture.run());
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
	expect(fs.existsSync(path.join(fixture.workspace, 'unexpected'))).toBe(false);
});

test('adding commands does not add YAML parser processes', async () => {
	const fixture = setup();
	// Reopening an existing space reads its saved profile, which the first run
	// writes, so compare two reopens.
	await fixture.run();
	fs.writeFileSync(fixture.configCalls, '');
	await fixture.run();
	const count = fs
		.readFileSync(fixture.configCalls, 'utf8')
		.trim()
		.split('\n').length;
	fs.writeFileSync(fixture.configCalls, '');
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: Array.from({length: 20}, () => ({run: ':'})),
		}),
	);
	await fixture.run();
	expect(
		fs.readFileSync(fixture.configCalls, 'utf8').trim().split('\n').length,
	).toBe(count);
});

for (const consumer of ['profile vars', 'post-create hook']) {
	test(`PR lookup covers ${consumer}`, async () => {
		const fixture = setup();
		fs.appendFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			stringify({
				profiles: {
					dev: {
						links: [],
						...(consumer === 'profile vars'
							? {
									vars: {
										SAVE_PR: 'printf "%s" "$PR_URL" > "${WORKTREE_PATH}/pr"',
									},
									commands: [{run: '${SAVE_PR}'}],
								}
							: {}),
					},
				},
				hooks: {
					post_workspace_create:
						consumer === 'post-create hook'
							? [{run: 'printf "%s" "${MR_URL}" > "${WORKTREE_PATH}/pr"'}]
							: [],
				},
			}),
		);
		await fixture.run({open: true});
		expect(fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8')).toBe(
			'https://github.com/test/repo/pull/1',
		);
	});
}

for (const consumer of ['links', 'apps']) {
	test(`PR lookup sees YAML aliases in ${consumer} after merging layers`, async () => {
		const fixture = setup();
		const entry =
			consumer === 'links'
				? "  - url: '${PR_URL}'\n    if_set: PR_URL"
				: '  - name: Save PR\n    command: \'printf %s "${PR_URL}" > "${WORKTREE_PATH}/pr"\'\n    if_set: PR_URL';
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.yml'),
			`common_entries: &entries\n${entry}\nversion: 1\nteam_prefix: test\nissue_tracker:\n  provider: beads\ndefault_profile: dev\nterminal:\n  app: none\nprofiles:\n  dev:\n    display_name: Dev\n${consumer === 'apps' ? '    links: []\n' : ''}    ${consumer}: *entries\n`,
		);
		const output = await fixture.run({open: true});
		const url = 'https://github.com/test/repo/pull/1';
		expect(output.includes(`PR:        ${url}`), output).toBe(true);
		expect(
			consumer === 'links'
				? fs.readFileSync(fixture.openCalls, 'utf8').trim()
				: fs.readFileSync(path.join(fixture.workspace, 'pr'), 'utf8'),
		).toBe(url);
	});
}

test('a failed PR consumer inspection falls back to VCS lookup', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({profiles: {dev: {links: []}}}),
	);
	const output = await fixture.run({
		open: true,
		extraEnv: {IDOW_TEST_FAIL_PR_INSPECTION: 'true'},
	});
	expect(fs.existsSync(fixture.vcsCalls)).toBe(true);
	expect(
		output.includes('PR:        https://github.com/test/repo/pull/1'),
	).toBe(true);
});

test('block-scalar launch settings strip trailing newlines', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		`claude:
  initialization_command: |+
    do

  model: |
    opus
  effort: >
    high
companion_command: |
  echo companion
`,
	);
	await fixture.run();
	const args = fs
		.readFileSync(fixture.launchArgs, 'utf8')
		.split('\n')
		.slice(0, -1);
	for (const [flag, value] of [
		['--init-cmd', '/do'],
		['--agent-launch-flags', '--model opus --effort high'],
		['--companion-command', 'echo companion'],
	]) {
		expect(args.includes(flag)).toBe(true);
		expect(args[args.indexOf(flag) + 1]).toBe(value);
	}
});

test('block-scalar app/link conditions and titles keep the previous field behavior', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		`profiles:
  dev:
    apps:
      - name: |
          Block app
        command: |
          printf '%s' "\${PR_URL}" > "\${WORKTREE_PATH}/app"
        if_set: |
          PR_URL
    links:
      - title: |+
          Block link

        url: |
          \${PR_URL}
        if_set: |
          PR_URL
`,
	);
	const output = await fixture.run({open: true});
	const url = 'https://github.com/test/repo/pull/1';
	expect(fs.readFileSync(path.join(fixture.workspace, 'app'), 'utf8')).toBe(
		url,
	);
	expect(fs.readFileSync(fixture.openCalls, 'utf8')).toBe(`${url}\n`);
	expect(output.includes(`Link: Block link -> ${url}`), output).toBe(true);
	expect(output.includes('Block app opened (command)'), output).toBe(true);
});

// A Pappardelle that starts idow lists the space afterwards, so idow records
// it before any session exists (source/space-registry-sqlite.ts). Lookups are
// not recorded, and a CLI that works answers them from what it recorded.
const escapeRegExp = (text: string) =>
	text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stateCli(fixture: ReturnType<typeof setup>, exitCode: number) {
	const calls = path.join(fixture.home, 'state-cli-calls');
	const executable = path.join(fixture.bin, 'pappardelle-state-stub');
	writeScript(
		executable,
		`if [[ "$2" != space && "$2" != worktree-path && "$2" != check-config ]]; then
    test ! -f "$IDOW_TEST_LAUNCH_ARGS" || echo "after sessions" >> ${JSON.stringify(calls)}
    printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
fi
${exitCode === 0 ? '' : `if [[ "$2" != space && "$2" != worktree-path && "$2" != check-config ]]; then\n    echo "no state for you" >&2\n    exit ${exitCode}\nfi\n`}exec ${JSON.stringify(path.join(fixture.bin, 'pappardelle-state'))} "$@"`,
	);
	return {
		calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n'),
		env: {
			PAPPARDELLE_EXECUTABLE: executable,
			PAPPARDELLE_REGISTER_SPACE: '1',
		},
	};
}

test('idow started by Pappardelle records the space under its own pid before starting sessions', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 0);
	await fixture.run({extraEnv: state.env});
	const [call, ...rest] = state.calls();
	// The agent's hook records its session id under this agent profile.
	expect(rest).toStrictEqual([
		`--internal-state launch-agent --repo ${path.basename(fixture.main)} --agent-profile claude --claude test-abc`,
	]);
	expect(call!).toMatch(
		new RegExp(
			`^--internal-state prepare-space --repo ${path.basename(fixture.main)} --title=Test issue --worktree ${escapeRegExp(fixture.workspace)} --main-root ${escapeRegExp(fixture.main)} --register --owner \\d+ --profile dev test-abc$`,
		),
	);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);
});

test('idow stops before starting sessions when the space cannot be recorded', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 1);
	const error = await rejectionOf(fixture.run({extraEnv: state.env}));
	expect(String(error?.message)).toMatch(/Could not record workspace test-abc/);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

test('idow run by hand saves the profile of a new workspace without registering the space, and only the title on a reopen', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 0);
	const extraEnv = {
		PAPPARDELLE_EXECUTABLE: state.env.PAPPARDELLE_EXECUTABLE,
	};
	const repo = path.basename(fixture.main);
	await fixture.run({extraEnv});
	expect(state.calls()).toStrictEqual([
		`--internal-state prepare-space --repo ${repo} --title=Test issue --worktree ${fixture.workspace} --main-root ${fixture.main} --profile dev test-abc`,
		`--internal-state launch-agent --repo ${repo} --agent-profile claude --claude test-abc`,
	]);
	expect(fs.existsSync(fixture.launchArgs)).toBe(true);

	await fixture.run({extraEnv});
	expect(state.calls().at(-3)).toBe(
		`--internal-state prepare-space --repo ${repo} --title=Test issue --worktree ${fixture.workspace} --main-root ${fixture.main} test-abc`,
	);
});

// A run by hand records no registration, but its sessions are still named
// and found through the stores. scripts/state-cli.sh fails this way when it
// finds no binary and no Bun.
test('idow run by hand stops before starting sessions when the space cannot be recorded', async () => {
	const fixture = setup();
	const state = stateCli(fixture, 127);
	const error = await rejectionOf(
		fixture.run({
			input: 'Make workspace startup faster',
			extraEnv: {PAPPARDELLE_EXECUTABLE: state.env.PAPPARDELLE_EXECUTABLE},
		}),
	);
	expect(String(error?.message)).toMatch(
		/Could not record workspace test-abc: no state for you/,
	);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

// idow used to write both files itself. They now come from the same writer
// as the TUI's, in whichever mode the run is in.
test('a new issue is recorded as created by Pappardelle, with its profile, before post_workspace_init', async () => {
	const fixture = setup();
	const stateDir = path.join(fixture.home, '.pappardelle');
	const repoState = path.join(stateDir, 'repos/main checkout');
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					run: `cp ${JSON.stringify(path.join(repoState, 'issue-meta/test-abc.json'))} "$WORKTREE_PATH/meta-during-init.json"`,
				},
			],
		}),
	);
	const before = Date.now();
	await fixture.run({input: 'Make workspace startup faster'});

	const meta = JSON.parse(
		fs.readFileSync(
			path.join(fixture.workspace, 'meta-during-init.json'),
			'utf8',
		),
	) as {created_by_pappardelle: boolean; created_at: string};
	expect(Object.keys(meta)).toStrictEqual([
		'created_by_pappardelle',
		'created_at',
	]);
	expect(meta.created_by_pappardelle).toBe(true);
	expect(meta.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	expect(Date.parse(meta.created_at) >= before - 1000).toBe(true);
	const state = JSON.parse(
		fs.readFileSync(path.join(repoState, 'space-state/test-abc.json'), 'utf8'),
	) as {profile: string; updatedAt: string};
	expect(state.profile).toBe('dev');
	expect(Date.parse(state.updatedAt) >= before).toBe(true);

	const dbPath = path.join(stateDir, 'state.db');
	if (!sqliteRun) {
		expect(fs.existsSync(dbPath)).toBe(false);
		return;
	}

	const db = new Database(dbPath, {readonly: true});
	teardown(() => {
		db.close();
	});
	expect(
		db
			.query(
				`SELECT s.repo, s.key, s.profile, m.created_by_pappardelle, m.created_at
				FROM space_state s JOIN issue_meta m USING (repo, key)`,
			)
			.all(),
	).toStrictEqual([
		{
			repo: 'main checkout',
			key: 'test-abc',
			profile: 'dev',
			created_by_pappardelle: 1,
			created_at: meta.created_at,
		},
	]);
});

test('an existing issue is not recorded as created by Pappardelle', async () => {
	const fixture = setup();
	await fixture.run();
	expect(
		fs.existsSync(
			path.join(fixture.home, '.pappardelle/repos/main checkout/issue-meta'),
		),
	).toBe(false);
});
