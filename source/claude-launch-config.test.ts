import test from 'ava';
import type {PappardelleConfig} from './config.ts';
import {
	getAgentProfile,
	getCompanionCommand,
	validateConfig,
	ConfigValidationError,
} from './config.ts';
import {buildAgentResumeCommand} from './tmux.ts';
import {
	DEFAULT_RESOLVED_AGENT_PROFILE,
	type ResolvedAgentProfile,
} from './config.ts';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Minimal two-profile config. `backend` matches the word "backend" in an issue
 * title, `frontend` matches "frontend" — enough to exercise the profile-aware
 * resolution without dragging in the rest of the schema.
 */
function makeConfig(
	overrides: Partial<PappardelleConfig> = {},
	backendClaude?: PappardelleConfig['claude'],
	frontendClaude?: PappardelleConfig['claude'],
): PappardelleConfig {
	return {
		version: 1,
		default_profile: 'backend',
		profiles: {
			backend: {
				display_name: 'Backend',
				keywords: ['backend'],
				...(backendClaude ? {claude: backendClaude} : {}),
			},
			frontend: {
				display_name: 'Frontend',
				keywords: ['frontend'],
				...(frontendClaude ? {claude: frontendClaude} : {}),
			},
		},
		...overrides,
	};
}

// ============================================================================
// getAgentProfile model / effort — resolution matrix
// ============================================================================
//
// Both fields resolve identically: per-profile value (when the key is present,
// including an explicit empty string) wins over the top-level `claude:` value.
// The permutations below walk every field-set / field-unset combination across
// the two layers so no state silently misbehaves.

test('model + effort: unset everywhere → empty strings', t => {
	const config = makeConfig();
	t.is(getAgentProfile(config).model, '');
	t.is(getAgentProfile(config).effort, '');
	t.is(getAgentProfile(config, 'backend work').model, '');
	t.is(getAgentProfile(config, 'backend work').effort, '');
});

test('model + effort: top-level only → applies to every profile', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getAgentProfile(config, 'backend work').model, 'opus');
	t.is(getAgentProfile(config, 'backend work').effort, 'high');
	t.is(getAgentProfile(config, 'frontend work').model, 'opus');
	t.is(getAgentProfile(config, 'frontend work').effort, 'high');
});

test('model + effort: top-level applies when no issue title is given', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getAgentProfile(config).model, 'opus');
	t.is(getAgentProfile(config).effort, 'high');
});

test('model + effort: profile-only → applies to that profile alone', t => {
	const config = makeConfig({}, {model: 'sonnet', effort: 'medium'});
	t.is(getAgentProfile(config, 'backend work').model, 'sonnet');
	t.is(getAgentProfile(config, 'backend work').effort, 'medium');
	// A profile without its own values, and the no-title case, stay empty.
	t.is(getAgentProfile(config, 'frontend work').model, '');
	t.is(getAgentProfile(config, 'frontend work').effort, '');
	t.is(getAgentProfile(config).model, '');
	t.is(getAgentProfile(config).effort, '');
});

test('model + effort: profile beats top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getAgentProfile(config, 'backend work').model, 'sonnet');
	t.is(getAgentProfile(config, 'backend work').effort, 'medium');
	// The unconfigured profile still inherits the top-level values.
	t.is(getAgentProfile(config, 'frontend work').model, 'opus');
	t.is(getAgentProfile(config, 'frontend work').effort, 'high');
});

test('model + effort: profile can set one field and inherit the other', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}}, {
		effort: 'max',
	} as PappardelleConfig['claude']);
	t.is(getAgentProfile(config, 'backend work').model, 'opus');
	t.is(getAgentProfile(config, 'backend work').effort, 'max');
});

test('model + effort: explicit empty string at profile level clears the global', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: '', effort: ''},
	);
	t.is(getAgentProfile(config, 'backend work').model, '');
	t.is(getAgentProfile(config, 'backend work').effort, '');
	// Sibling profile is unaffected.
	t.is(getAgentProfile(config, 'frontend work').model, 'opus');
});

test('model + effort: explicit empty string at top level behaves as unset', t => {
	const config = makeConfig({claude: {model: '', effort: ''}});
	t.is(getAgentProfile(config, 'backend work').model, '');
	t.is(getAgentProfile(config, 'backend work').effort, '');
});

test('model + effort: unmatched issue title falls back to top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getAgentProfile(config, 'something unrelated').model, 'opus');
	t.is(getAgentProfile(config, 'something unrelated').effort, 'high');
});

test('model + effort: a profile claude section without them inherits top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{initialization_command: '/do'},
	);
	t.is(getAgentProfile(config, 'backend work').model, 'opus');
	t.is(getAgentProfile(config, 'backend work').effort, 'high');
});

// ============================================================================
// Validation
// ============================================================================

test('validateConfig accepts model + effort at top level and per profile', t => {
	t.notThrows(() => {
		validateConfig(
			makeConfig(
				{claude: {model: 'opus', effort: 'high'}},
				{model: 'claude-opus-5[1m]', effort: 'max'},
			),
		);
	});
});

test('validateConfig accepts an explicit empty string (means "no flag")', t => {
	t.notThrows(() => {
		validateConfig(makeConfig({claude: {model: '', effort: ''}}, {model: ''}));
	});
});

test('validateConfig rejects a non-string top-level model', t => {
	const config = makeConfig({
		claude: {model: 5 as unknown as string},
	});
	const error = t.throws(
		() => {
			validateConfig(config);
		},
		{instanceOf: ConfigValidationError},
	);
	t.true(error!.errors.some(e => e.includes('claude.model: must be a string')));
});

test('validateConfig rejects a non-string top-level effort', t => {
	const config = makeConfig({
		claude: {effort: true as unknown as string},
	});
	const error = t.throws(
		() => {
			validateConfig(config);
		},
		{instanceOf: ConfigValidationError},
	);
	t.true(
		error!.errors.some(e => e.includes('claude.effort: must be a string')),
	);
});

test('validateConfig rejects a non-string per-profile model/effort', t => {
	const config = makeConfig(
		{},
		{
			model: 1 as unknown as string,
			effort: [] as unknown as string,
		},
	);
	const error = t.throws(
		() => {
			validateConfig(config);
		},
		{instanceOf: ConfigValidationError},
	);
	t.true(
		error!.errors.some(e =>
			e.includes('profiles.backend.claude.model: must be a string'),
		),
	);
	t.true(
		error!.errors.some(e =>
			e.includes('profiles.backend.claude.effort: must be a string'),
		),
	);
});

// ============================================================================
// buildAgentResumeCommand
// ============================================================================

test('buildAgentResumeCommand: no model/effort → byte-identical to master', t => {
	// Off-by-default regression guard. This is the exact string master
	// produces; if a launch flag ever leaks in when nothing is configured,
	// this test fails.
	const expected =
		"claude --name STA-1 --resume sess-1 || { printf '\\033[A\\033[2K'; false; } || claude --name STA-1";
	t.is(
		buildAgentResumeCommand(
			'STA-1',
			false,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
		expected,
	);
	t.is(
		buildAgentResumeCommand(
			'STA-1',
			false,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
		expected,
	);
});

test('buildAgentResumeCommand: skip-permissions only is unchanged', t => {
	const expected =
		"claude --dangerously-skip-permissions --name STA-1 --resume sess-1 || { printf '\\033[A\\033[2K'; false; } || claude --dangerously-skip-permissions --name STA-1";
	t.is(
		buildAgentResumeCommand(
			'STA-1',
			true,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
		expected,
	);
});

test('buildAgentResumeCommand: model only', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, model: 'sonnet'},
		'sess-1',
	);
	t.true(cmd.startsWith('claude --model sonnet --name STA-1 --resume sess-1'));
	// Both branches of the || fallback carry the flag.
	t.is(cmd.split('--model sonnet').length - 1, 2);
	t.false(cmd.includes('--effort'));
});

test('buildAgentResumeCommand: effort only', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, effort: 'high'},
		'sess-1',
	);
	t.true(cmd.startsWith('claude --effort high --name STA-1 --resume sess-1'));
	t.is(cmd.split('--effort high').length - 1, 2);
	t.false(cmd.includes('--model'));
});

test('buildAgentResumeCommand: full flag order is dsp → model → effort → name', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		true,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, model: 'opus', effort: 'max'},
		'sess-1',
	);
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --model opus --effort max --name STA-1 --resume sess-1',
		),
	);
});

test('buildAgentResumeCommand: shell-quotes exotic model values', t => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		model: 'claude-opus-5[1m]',
	});
	t.true(cmd.includes(`--model 'claude-opus-5[1m]'`));
	t.false(cmd.includes('--model claude-opus-5[1m] '));
});

test('buildAgentResumeCommand: escapes embedded single quotes', t => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		model: "we'ird",
	});
	t.true(cmd.includes(`--model 'we'\\''ird'`));
});

// ============================================================================
// extra_args (STA-2663)
// ============================================================================
//
// The deprecated `claude.extra_args`: raw flags for claude agent profiles. The
// run-robodogfood profile uses it to give an unattended QA agent only the tools
// it needs (`--tools`, `--strict-mcp-config`, `--no-chrome`). The profile key
// wins whenever it is present, so `extra_args: []` on a profile clears a
// top-level list.

const QA_ARGS = ['--strict-mcp-config', '--tools', 'Bash,Read'];

const extraArgs = (
	config: PappardelleConfig,
	issueTitle?: string,
	profileName?: string,
) => getAgentProfile(config, issueTitle, profileName).extraArgs;

test('extra_args: unset everywhere → empty list', t => {
	t.deepEqual(extraArgs(makeConfig()), []);
	t.deepEqual(extraArgs(makeConfig(), 'backend work'), []);
});

test('extra_args: top-level applies to every profile', t => {
	const config = makeConfig({claude: {extra_args: ['--no-chrome']}});
	t.deepEqual(extraArgs(config), ['--no-chrome']);
	t.deepEqual(extraArgs(config, 'frontend work'), ['--no-chrome']);
});

test('extra_args: profile list replaces the top-level list', t => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: QA_ARGS},
	);
	t.deepEqual(extraArgs(config, 'backend work'), QA_ARGS);
	t.deepEqual(extraArgs(config, 'frontend work'), ['--no-chrome']);
});

test('extra_args: an empty profile list clears the top-level list', t => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: []},
	);
	t.deepEqual(extraArgs(config, 'backend work'), []);
});

test('extra_args: only claude agent profiles get them', t => {
	const config = makeConfig(
		{
			agent_profiles: {codex: {command: 'codex'}},
			agent_profile: 'codex',
		},
		{extra_args: QA_ARGS},
	);
	t.deepEqual(extraArgs(config, 'backend work'), []);
});

test("extra_args: an agent profile's own args don't drop them", t => {
	const config = makeConfig(
		{
			agent_profiles: {verbose: {command: 'claude', args: '--verbose'}},
			agent_profile: 'verbose',
		},
		{extra_args: QA_ARGS},
	);
	const cmd = buildAgentResumeCommand(
		'QA-1',
		false,
		getAgentProfile(config, 'backend work'),
	);
	t.true(
		cmd.startsWith(
			"claude --verbose --strict-mcp-config --tools 'Bash,Read' --name QA-1",
		),
	);
});

// The saved profile (idow writes it to space-state) beats the title match. A
// dev issue titled with the runner's keyword must not get the runner's
// locked-down tools when the TUI starts its session again.

test('saved profile: beats a title that matches a different profile', t => {
	const config = makeConfig(
		{companion_command: 'gitui'},
		{model: 'sonnet', effort: 'high', extra_args: QA_ARGS},
		{model: 'opus', effort: 'low'},
	);
	config.profiles['frontend']!.companion_command = '';
	const title = 'backend work';
	const frontend = getAgentProfile(config, title, 'frontend');
	t.deepEqual(frontend.extraArgs, []);
	t.is(frontend.model, 'opus');
	t.is(frontend.effort, 'low');
	t.is(getCompanionCommand(config, title, 'frontend'), '');
	t.deepEqual(extraArgs(config, 'frontend work', 'backend'), QA_ARGS);
});

test('saved profile: a name that no longer exists falls back to the title', t => {
	// A profile rename leaves the old name in space-state.
	const config = makeConfig({}, {extra_args: QA_ARGS});
	t.deepEqual(extraArgs(config, 'backend work', 'renamed'), QA_ARGS);
	t.is(
		getCompanionCommand(config, 'backend work', 'renamed'),
		'GIT_OPTIONAL_LOCKS=0 gitui',
	);
});

test('validateConfig accepts extra_args at top level and per profile', t => {
	t.notThrows(() => {
		validateConfig(
			makeConfig({claude: {extra_args: ['--no-chrome']}}, {extra_args: []}),
		);
	});
});

test('validateConfig rejects extra_args that is not a list of strings', t => {
	const config = makeConfig(
		{claude: {extra_args: '--no-chrome' as unknown as string[]}},
		{extra_args: ['--tools', 5] as unknown as string[]},
	);
	const error = t.throws(
		() => {
			validateConfig(config);
		},
		{instanceOf: ConfigValidationError},
	);
	t.true(
		error!.errors.some(e =>
			e.includes('claude.extra_args: must be a list of strings'),
		),
	);
	t.true(
		error!.errors.some(e =>
			e.includes(
				'profiles.backend.claude.extra_args: must be a list of strings',
			),
		),
	);
});

test('buildAgentResumeCommand: extra args go after effort and before name, on both branches', t => {
	const cmd = buildAgentResumeCommand(
		'QA-1',
		true,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, effort: 'high', extraArgs: QA_ARGS},
		'sess-1',
	);
	t.true(
		cmd.startsWith(
			"claude --dangerously-skip-permissions --effort high --strict-mcp-config --tools 'Bash,Read' --name QA-1 --resume sess-1",
		),
	);
	t.is(cmd.split('--strict-mcp-config').length - 1, 2);
});

test('buildAgentResumeCommand: shell-quotes each extra arg', t => {
	const cmd = buildAgentResumeCommand('QA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		extraArgs: ['--mcp-config', '{"mcpServers": {}}'],
	});
	t.true(cmd.includes(`--mcp-config '{"mcpServers": {}}' --name QA-1`));
});
