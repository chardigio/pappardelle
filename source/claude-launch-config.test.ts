import test from 'ava';
import type {PappardelleConfig} from './config.ts';
import {
	getAgentEffort,
	getAgentModel,
	getClaudeExtraArgs,
	getCompanionCommand,
	validateConfig,
	ConfigValidationError,
} from './config.ts';
import {buildAgentResumeCommand} from './tmux.ts';
import {
	bindResumeArgs,
	DEFAULT_RESOLVED_AGENT_PROFILE,
	type ResolvedAgentProfile,
} from './config.ts';

// The built-in claude agent profile once the space has a recorded session, so the
// flags show up on both branches of the resume chain.
const resumingClaude: ResolvedAgentProfile = {
	...DEFAULT_RESOLVED_AGENT_PROFILE,
	resumeArgs: bindResumeArgs(DEFAULT_RESOLVED_AGENT_PROFILE, 'sess-1'),
};

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
// getAgentModel / getAgentEffort — resolution matrix
// ============================================================================
//
// Both fields resolve identically: per-profile value (when the key is present,
// including an explicit empty string) wins over the top-level `claude:` value.
// The permutations below walk every field-set / field-unset combination across
// the two layers so no state silently misbehaves.

test('model + effort: unset everywhere → empty strings', t => {
	const config = makeConfig();
	t.is(getAgentModel(config), '');
	t.is(getAgentEffort(config), '');
	t.is(getAgentModel(config, 'backend work'), '');
	t.is(getAgentEffort(config, 'backend work'), '');
});

test('model + effort: top-level only → applies to every profile', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getAgentModel(config, 'backend work'), 'opus');
	t.is(getAgentEffort(config, 'backend work'), 'high');
	t.is(getAgentModel(config, 'frontend work'), 'opus');
	t.is(getAgentEffort(config, 'frontend work'), 'high');
});

test('model + effort: top-level applies when no issue title is given', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getAgentModel(config), 'opus');
	t.is(getAgentEffort(config), 'high');
});

test('model + effort: profile-only → applies to that profile alone', t => {
	const config = makeConfig({}, {model: 'sonnet', effort: 'medium'});
	t.is(getAgentModel(config, 'backend work'), 'sonnet');
	t.is(getAgentEffort(config, 'backend work'), 'medium');
	// A profile without its own values, and the no-title case, stay empty.
	t.is(getAgentModel(config, 'frontend work'), '');
	t.is(getAgentEffort(config, 'frontend work'), '');
	t.is(getAgentModel(config), '');
	t.is(getAgentEffort(config), '');
});

test('model + effort: profile beats top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getAgentModel(config, 'backend work'), 'sonnet');
	t.is(getAgentEffort(config, 'backend work'), 'medium');
	// The unconfigured profile still inherits the top-level values.
	t.is(getAgentModel(config, 'frontend work'), 'opus');
	t.is(getAgentEffort(config, 'frontend work'), 'high');
});

test('model + effort: profile can set one field and inherit the other', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}}, {
		effort: 'max',
	} as PappardelleConfig['claude']);
	t.is(getAgentModel(config, 'backend work'), 'opus');
	t.is(getAgentEffort(config, 'backend work'), 'max');
});

test('model + effort: explicit empty string at profile level clears the global', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: '', effort: ''},
	);
	t.is(getAgentModel(config, 'backend work'), '');
	t.is(getAgentEffort(config, 'backend work'), '');
	// Sibling profile is unaffected.
	t.is(getAgentModel(config, 'frontend work'), 'opus');
});

test('model + effort: explicit empty string at top level behaves as unset', t => {
	const config = makeConfig({claude: {model: '', effort: ''}});
	t.is(getAgentModel(config, 'backend work'), '');
	t.is(getAgentEffort(config, 'backend work'), '');
});

test('model + effort: unmatched issue title falls back to top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getAgentModel(config, 'something unrelated'), 'opus');
	t.is(getAgentEffort(config, 'something unrelated'), 'high');
});

test('model + effort: a profile claude section without them inherits top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{initialization_command: '/do'},
	);
	t.is(getAgentModel(config, 'backend work'), 'opus');
	t.is(getAgentEffort(config, 'backend work'), 'high');
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
	t.is(buildAgentResumeCommand('STA-1', false, {}, resumingClaude), expected);
	t.is(
		buildAgentResumeCommand(
			'STA-1',
			false,
			{model: '', effort: ''},
			resumingClaude,
		),
		expected,
	);
});

test('buildAgentResumeCommand: skip-permissions only is unchanged', t => {
	const expected =
		"claude --dangerously-skip-permissions --name STA-1 --resume sess-1 || { printf '\\033[A\\033[2K'; false; } || claude --dangerously-skip-permissions --name STA-1";
	t.is(buildAgentResumeCommand('STA-1', true, {}, resumingClaude), expected);
});

test('buildAgentResumeCommand: model only', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{model: 'sonnet'},
		resumingClaude,
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
		{effort: 'high'},
		resumingClaude,
	);
	t.true(cmd.startsWith('claude --effort high --name STA-1 --resume sess-1'));
	t.is(cmd.split('--effort high').length - 1, 2);
	t.false(cmd.includes('--model'));
});

test('buildAgentResumeCommand: full flag order is dsp → model → effort → name', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		true,
		{model: 'opus', effort: 'max'},
		resumingClaude,
	);
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --model opus --effort max --name STA-1 --resume sess-1',
		),
	);
});

test('buildAgentResumeCommand: shell-quotes exotic model values', t => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		model: 'claude-opus-5[1m]',
	});
	t.true(cmd.includes(`--model 'claude-opus-5[1m]'`));
	t.false(cmd.includes('--model claude-opus-5[1m] '));
});

test('buildAgentResumeCommand: escapes embedded single quotes', t => {
	const cmd = buildAgentResumeCommand('STA-1', false, {model: "we'ird"});
	t.true(cmd.includes(`--model 'we'\\''ird'`));
});

// ============================================================================
// extra_args (STA-2663)
// ============================================================================
//
// A list of raw flags for `claude`. The run-robodogfood profile uses it to give an
// unattended QA agent only the tools it needs (`--tools`, `--strict-mcp-config`,
// `--no-chrome`). It resolves like model/effort: the profile key wins whenever
// it is present, so `extra_args: []` on a profile clears a top-level list.

const QA_ARGS = ['--strict-mcp-config', '--tools', 'Bash,Read'];

test('extra_args: unset everywhere → empty list', t => {
	t.deepEqual(getClaudeExtraArgs(makeConfig()), []);
	t.deepEqual(getClaudeExtraArgs(makeConfig(), 'backend work'), []);
});

test('extra_args: top-level applies to every profile', t => {
	const config = makeConfig({claude: {extra_args: ['--no-chrome']}});
	t.deepEqual(getClaudeExtraArgs(config), ['--no-chrome']);
	t.deepEqual(getClaudeExtraArgs(config, 'frontend work'), ['--no-chrome']);
});

test('extra_args: profile list replaces the top-level list', t => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: QA_ARGS},
	);
	t.deepEqual(getClaudeExtraArgs(config, 'backend work'), QA_ARGS);
	t.deepEqual(getClaudeExtraArgs(config, 'frontend work'), ['--no-chrome']);
});

test('extra_args: an empty profile list clears the top-level list', t => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: []},
	);
	t.deepEqual(getClaudeExtraArgs(config, 'backend work'), []);
});

// The saved profile (idow writes it to space-state) beats the title match
// (STA-2663). A dev issue titled with the runner's keyword must not get the
// runner's locked-down tools when the TUI starts its session again.

test('saved profile: beats a title that matches a different profile', t => {
	const config = makeConfig(
		{companion_command: 'gitui'},
		{model: 'sonnet', effort: 'high', extra_args: QA_ARGS},
		{model: 'opus', effort: 'low'},
	);
	config.profiles['frontend']!.companion_command = '';
	const title = 'backend work';
	t.deepEqual(getClaudeExtraArgs(config, title, 'frontend'), []);
	t.is(getClaudeModel(config, title, 'frontend'), 'opus');
	t.is(getClaudeEffort(config, title, 'frontend'), 'low');
	t.is(getCompanionCommand(config, title, 'frontend'), '');
	t.deepEqual(getClaudeExtraArgs(config, 'frontend work', 'backend'), QA_ARGS);
});

test('saved profile: a name that no longer exists falls back to the title', t => {
	// A profile rename leaves the old name in space-state.
	const config = makeConfig({}, {extra_args: QA_ARGS});
	t.deepEqual(getClaudeExtraArgs(config, 'backend work', 'renamed'), QA_ARGS);
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

test('buildClaudeResumeCommand: extra args go after effort and before name, on both branches', t => {
	const cmd = buildClaudeResumeCommand('QA-1', true, {
		effort: 'high',
		extraArgs: QA_ARGS,
	});
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --effort high --strict-mcp-config --tools Bash,Read --name QA-1 --continue',
		),
	);
	t.is(cmd.split('--strict-mcp-config').length - 1, 2);
});

test('buildClaudeResumeCommand: shell-quotes each extra arg', t => {
	const cmd = buildClaudeResumeCommand('QA-1', false, {
		extraArgs: ['--mcp-config', '{"mcpServers": {}}'],
	});
	t.true(cmd.includes(`--mcp-config '{"mcpServers": {}}' --name QA-1`));
});

test('buildClaudeResumeCommand: an empty extra args list changes nothing', t => {
	t.is(
		buildClaudeResumeCommand('STA-1', false, {extraArgs: []}),
		buildClaudeResumeCommand('STA-1'),
	);
});
