/* eslint-disable no-template-curly-in-string -- These are idow shell templates. */
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {parse, stringify} from 'yaml';
import {idowState} from '../test/helpers/idow-state.ts';
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
	const state = idowState(fixture);
	const record = () => {
		state.recordSessions('test-abc', {claude: 'earlier'});
	};

	record();
	await fixture.run({input: 'Make workspace startup faster'});
	expect(state.daos.agentSessions.keys()).toStrictEqual([]);

	record();
	await fixture.run();
	expect(state.daos.agentSessions.read('test-abc', 'claude')).toBe('earlier');
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
	const {daos} = idowState(fixture);
	expect(daos.issueMeta.read('test-abc')).toBe(null);
	expect(daos.spaceState.read('test-abc')).toBe(null);
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

test('a post_workspace_init command sees the issue key, number and repo name', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					run: 'printf "%s|%s|%s" "${ISSUE_KEY}" "${ISSUE_NUMBER}" "${REPO_NAME}" > "${WORKTREE_PATH}/vars"',
				},
			],
		}),
	);
	await fixture.run();
	expect(fs.readFileSync(path.join(fixture.workspace, 'vars'), 'utf8')).toBe(
		`test-abc|abc|${path.basename(fixture.main)}`,
	);
});

// The validator rejects a config with both keys, so post_worktree_init is only
// ever read from a config without post_workspace_init.
test('the legacy post_worktree_init runs when post_workspace_init is absent', async () => {
	const fixture = setup();
	const config = parse(fixture.config('Main config')) as Record<
		string,
		unknown
	>;
	delete config['post_workspace_init'];
	config['post_worktree_init'] = [{run: 'touch "${WORKTREE_PATH}/legacy"'}];
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.yml'),
		stringify(config),
	);
	await fixture.run();
	expect(fs.existsSync(path.join(fixture.workspace, 'legacy'))).toBe(true);
});

test('a new worktree gets copies of the local config files, and a reopened one does not', async () => {
	const fixture = setup();
	const settings = '{"permissions": {"allow": []}}\n';
	fs.mkdirSync(path.join(fixture.linked, '.claude'));
	fs.writeFileSync(
		path.join(fixture.linked, '.claude', 'settings.local.json'),
		settings,
	);
	const copies = [
		path.join(fixture.workspace, '.pappardelle.local.yml'),
		path.join(fixture.workspace, '.claude', 'settings.local.json'),
	];

	await fixture.run();
	expect(fs.readFileSync(copies[1]!, 'utf8')).toBe(settings);
	for (const copy of copies) fs.rmSync(copy);

	await fixture.run();
	expect(copies.filter(copy => fs.existsSync(copy))).toStrictEqual([]);
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
	] as const) {
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

// What a post_workspace_init command can see is what the database holds then.
const readMetaScript = `import json, sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = db.execute("SELECT created_by_pappardelle, created_at FROM issue_meta WHERE key = 'test-abc'").fetchone()
print(json.dumps(row))
`;

test('a new issue is recorded as created by Pappardelle, with its profile, before post_workspace_init', async () => {
	const fixture = setup();
	const state = idowState(fixture);
	const script = path.join(fixture.home, 'read-meta.py');
	fs.writeFileSync(script, readMetaScript);
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					run: `python3 ${JSON.stringify(script)} ${JSON.stringify(state.dbPath)} > "$WORKTREE_PATH/meta-during-init.json"`,
				},
			],
		}),
	);
	const before = Date.now();
	await fixture.run({input: 'Make workspace startup faster'});

	const [createdByPappardelle, createdAt] = JSON.parse(
		fs.readFileSync(
			path.join(fixture.workspace, 'meta-during-init.json'),
			'utf8',
		),
	) as [number, string];
	expect(createdByPappardelle).toBe(1);
	expect(createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	expect(Date.parse(createdAt) >= before - 1000).toBe(true);
	expect(state.daos.issueMeta.read('test-abc')).toStrictEqual({
		createdByPappardelle: true,
		createdAt,
	});
	const space = state.daos.spaceState.read('test-abc');
	expect(space?.profile).toBe('dev');
	expect(Date.parse(space?.updatedAt ?? '') >= before).toBe(true);
});

test('an existing issue is not recorded as created by Pappardelle', async () => {
	const fixture = setup();
	await fixture.run();
	expect(idowState(fixture).daos.issueMeta.read('test-abc')).toBe(null);
});
