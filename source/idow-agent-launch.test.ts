import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {stringify} from 'yaml';
import {agentRulesFlags} from './companion-rules.ts';
import {BUILTIN_AGENTS} from './builtin-agents.ts';
import {idowSkippedAgentOverride} from './session-routing.ts';
import type {SpaceState} from './space-state.ts';
import {sqliteRun} from '../test/helpers/state.ts';
import {setup, writeScript} from '../test/helpers/idow-fixture.ts';

test('idow launches Codex with the companion rules and writes agy its rule file', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			workspace_aware_agents: true,
			agent_profiles: {
				codex: {command: 'codex', model: 'gpt-5.5'},
				agy: {command: 'agy'},
			},
			profiles: {
				cx: {display_name: 'Codex', agent_profile: 'codex'},
				ag: {display_name: 'Agy', agent_profile: 'agy'},
			},
		}),
	);
	const worktree = path.join(fixture.home, '.worktrees/main checkout/test-abc');
	fs.mkdirSync(worktree, {recursive: true});
	const launchFlags = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-launch-flags') + 1];
	};

	await fixture.run({profile: 'cx'});
	expect(launchFlags()).toBe(
		`-m gpt-5.5${agentRulesFlags(BUILTIN_AGENTS['codex']!.rules_args!)}`,
	);
	expect(fs.existsSync(path.join(worktree, '.agents'))).toBe(false);

	await fixture.run({profile: 'ag'});
	expect(launchFlags()).toBe('');
	expect(
		fs.readFileSync(
			path.join(worktree, '.agents/rules/pappardelle.md'),
			'utf8',
		),
	).toMatch(/first call companion_run/);
});

test('idow passes no companion rules without workspace_aware_agents', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				codex: {command: 'codex', model: 'gpt-5.5'},
				agy: {command: 'agy'},
			},
			profiles: {
				cx: {display_name: 'Codex', agent_profile: 'codex'},
				ag: {display_name: 'Agy', agent_profile: 'agy'},
			},
		}),
	);
	const worktree = path.join(fixture.home, '.worktrees/main checkout/test-abc');
	fs.mkdirSync(worktree, {recursive: true});
	const launchFlags = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-launch-flags') + 1];
	};

	await fixture.run({profile: 'cx'});
	expect(launchFlags()).toBe('-m gpt-5.5');
	await fixture.run({profile: 'ag'});
	expect(fs.existsSync(path.join(worktree, '.agents'))).toBe(false);
});

// codex's `resume --last` is not scoped to the cwd, so resuming in a brand new
// worktree would reopen another workspace's conversation.
test('a recreated worktree launches the agent without resume args not tied to it', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const resumeArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf('--agent-resume-args') + 1];
	};

	await fixture.run({profile: 'other'});
	expect(resumeArgs()).toBe('');
	// create-worktree.sh is stubbed to build the workspace elsewhere, so idow
	// only sees an existing worktree once its own path exists.
	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});

	await fixture.run({open: true});
	expect(resumeArgs()).toBe('resume --last');
	expect(fs.readFileSync(fixture.launchers, 'utf8')).toMatch(
		/--agent-resume-args resume --last --agent-prompt-args +--agent-is-claude false/,
	);
});

// Claude keys --continue by directory, and a recreated worktree reuses the
// same path, so the space's conversation is still there to continue.
test('a recreated worktree keeps claude resume args without a session id', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				claude: {command: 'claude', resume_args: '--continue --fork-session'},
			},
		}),
	);

	await fixture.run();
	const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
	expect(args[args.indexOf('--agent-resume-args') + 1]).toBe(
		'--continue --fork-session',
	);
});

// The TUI renders the rail emoji and picks the agent profile from space-state,
// and a slow post_workspace_init must not leave that window open.
test('the profile is persisted before post_workspace_init runs', async () => {
	const fixture = setup();
	fs.appendFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			post_workspace_init: [
				{
					run: 'cp "$HOME/.pappardelle/repos/main checkout/space-state/test-abc.json" "$WORKTREE_PATH/state-during-init.json"',
				},
			],
		}),
	);

	await fixture.run();
	const seen = fs.readFileSync(
		path.join(fixture.workspace, 'state-during-init.json'),
		'utf8',
	);
	expect((JSON.parse(seen) as {profile: string}).profile).toBe('dev');
});

test('--agent-profile launches another agent profile for that run only', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({agent_profiles: {codex: {command: 'codex'}}}),
	);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};
	const statePath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.json',
	);
	// The agent's hook records its session id under this.
	const launched = () =>
		(JSON.parse(fs.readFileSync(statePath, 'utf8')) as SpaceState).agentProfile;

	const stdout = await fixture.run({agentProfile: 'codex'});
	expect(launchArg('--agent-command')).toBe('codex');
	expect(launched()).toStrictEqual({name: 'codex', isClaude: false});
	expect(idowSkippedAgentOverride(stdout)).toBe(false);

	await fixture.run();
	expect(launchArg('--agent-command')).toBe('claude');
	expect(launched()).toStrictEqual({name: 'claude', isClaude: true});
});

test("the agent profile's env reaches start-agent-session.sh, one --agent-env per variable", async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				opus: {command: 'claude', env: {CODE_MODE: '1', SPACED: "a b'c"}},
			},
		}),
	);
	const envArgs = () => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args.flatMap((arg, i) =>
			arg === '--agent-env' ? [args[i + 1]] : [],
		);
	};

	await fixture.run({agentProfile: 'opus'});
	expect(envArgs()).toStrictEqual(['CODE_MODE=1', "SPACED=a b'c"]);

	await fixture.run();
	expect(envArgs()).toStrictEqual([]);
});

test('--agent-profile on a space whose agent is running says it was not applied', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({agent_profiles: {codex: {command: 'codex'}}}),
	);
	writeScript(path.join(fixture.bin, 'tmux'), 'exit 0');

	const stdout = await fixture.run({agentProfile: 'codex'});
	expect(stdout).toMatch(/Agent session already running/);
	expect(idowSkippedAgentOverride(stdout)).toBe(true);
	const state = JSON.parse(
		fs.readFileSync(
			path.join(
				fixture.home,
				'.pappardelle/repos/main checkout/space-state/test-abc.json',
			),
			'utf8',
		),
	) as SpaceState;
	expect('agentProfile' in state).toBe(false);
});

test('an unknown --agent-profile stops idow before any setup', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({agent_profiles: {codex: {command: 'codex'}}}),
	);
	const error = await rejectionOf(fixture.run({agentProfile: 'codx'}));
	expect(String(error)).toMatch(
		/Unknown agent profile "codx"\. Agent profiles: claude, codex/,
	);
	expect(fs.existsSync(fixture.workspace)).toBe(false);
});

test('an invalid agent profile the space does not use still stops idow before any setup', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({agent_profiles: {opus: {command: 'claude', model: 7}}}),
	);
	const error = await rejectionOf(fixture.run());
	expect(String(error)).toMatch(
		/agent_profiles\.opus\.model: must be a string/,
	);
	expect(fs.existsSync(fixture.workspace)).toBe(false);
});

test('a reopened space resumes the session its agent recorded', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				codex: {command: 'codex', resume_args: 'resume {session_id}'},
			},
			profiles: {other: {display_name: 'Other', agent_profile: 'codex'}},
		}),
	);
	const sessionsPath = path.join(
		fixture.home,
		'.pappardelle/repos/main checkout/space-state/test-abc.agent-sessions.json',
	);
	const record = (agentSessions: Record<string, string>) => {
		fs.mkdirSync(path.dirname(sessionsPath), {recursive: true});
		fs.writeFileSync(
			sessionsPath,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(agentSessions).map(([profile, id]) => [
						profile,
						{session_id: id, pid: 1},
					]),
				),
			),
		);
	};
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue resumes its conversation even in a recreated worktree.
	record({codex: 'thread-1'});
	await fixture.run({profile: 'other'});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	record({codex: 'thread-1'});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');
	expect(launchArg('--agent-command')).toBe('codex');

	// An id recorded by another agent profile is not this one's conversation.
	record({claude: 'thread-2'});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('');

	// A hand-edited, non-string id is skipped, as the TUI does.
	fs.writeFileSync(
		sessionsPath,
		JSON.stringify({codex: {session_id: 123, pid: 1}}),
	);
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('');

	// An override launch resumes its own agent profile's conversation, and the
	// profile's agent still finds its own afterwards.
	record({codex: 'thread-1', claude: 'thread-2'});
	await fixture.run({open: true, agentProfile: 'claude'});
	expect(launchArg('--agent-resume-args')).toBe('--resume thread-2');
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('resume thread-1');
});

// The JSON files only mirror the database while the flag exists, so a
// reopen must read the profile from the stores, not from the file.
if (sqliteRun) {
	test('a reopen picks the profile the database holds when no state file mirrors it', async () => {
		const fixture = setup();
		fs.writeFileSync(
			path.join(fixture.main, '.pappardelle.local.yml'),
			stringify({profiles: {other: {display_name: 'Other'}}}),
		);
		const stateFile = path.join(
			fixture.home,
			'.pappardelle/repos/main checkout/space-state/test-abc.json',
		);
		await fixture.run({profile: 'other'});
		fs.rmSync(stateFile);
		const db = new Database(path.join(fixture.home, '.pappardelle/state.db'));
		db.query('DELETE FROM json_sync WHERE path = ?').run(stateFile);
		db.close();
		fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
			recursive: true,
		});

		const output = await fixture.run();
		expect(output.includes('Profile:   Other'), output).toBe(true);
	});
}

// Taking an unreadable store for a space with no saved profile would launch
// the default agent in a space created with another.
test('a state store that cannot be read stops idow before any session starts', async () => {
	const fixture = setup();
	fs.mkdirSync(
		path.join(
			fixture.home,
			'.pappardelle/repos/main checkout/space-state/test-abc.json',
		),
		{recursive: true},
	);

	const error = await rejectionOf(fixture.run());
	expect(String(error)).toMatch(/Could not look up workspace test-abc/);
	expect(fs.existsSync(fixture.launchArgs)).toBe(false);
});

test('a reopened claude space with no recorded session continues its conversation', async () => {
	const fixture = setup();
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	// An existing issue continues even in a recreated worktree; only a new
	// issue launches fresh.
	await fixture.run({});
	expect(launchArg('--agent-resume-args')).toBe('--continue');

	fs.mkdirSync(path.join(fixture.home, '.worktrees/main checkout/test-abc'), {
		recursive: true,
	});
	await fixture.run({open: true});
	expect(launchArg('--agent-resume-args')).toBe('--continue');
});

test('a claude space with no recorded session keeps its other resume flags', async () => {
	const fixture = setup();
	fs.writeFileSync(
		path.join(fixture.main, '.pappardelle.local.yml'),
		stringify({
			agent_profiles: {
				claude: {
					command: 'claude',
					resume_args: '--resume {session_id} --fork-session',
				},
			},
		}),
	);
	const launchArg = (flag: string) => {
		const args = fs.readFileSync(fixture.launchArgs, 'utf8').split('\n');
		return args[args.indexOf(flag) + 1];
	};

	await fixture.run();
	expect(launchArg('--agent-resume-args')).toBe('--continue --fork-session');
});
