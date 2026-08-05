import test from 'ava';
import type {PappardelleConfig} from './config.ts';
import {
	getClaudeEffort,
	getClaudeModel,
	validateConfig,
	ConfigValidationError,
} from './config.ts';
import {buildClaudeResumeCommand} from './tmux.ts';

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
// getClaudeModel / getClaudeEffort — resolution matrix
// ============================================================================
//
// Both fields resolve identically: per-profile value (when the key is present,
// including an explicit empty string) wins over the top-level `claude:` value.
// The permutations below walk every field-set / field-unset combination across
// the two layers so no state silently misbehaves.

test('model + effort: unset everywhere → empty strings', t => {
	const config = makeConfig();
	t.is(getClaudeModel(config), '');
	t.is(getClaudeEffort(config), '');
	t.is(getClaudeModel(config, 'backend work'), '');
	t.is(getClaudeEffort(config, 'backend work'), '');
});

test('model + effort: top-level only → applies to every profile', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getClaudeModel(config, 'backend work'), 'opus');
	t.is(getClaudeEffort(config, 'backend work'), 'high');
	t.is(getClaudeModel(config, 'frontend work'), 'opus');
	t.is(getClaudeEffort(config, 'frontend work'), 'high');
});

test('model + effort: top-level applies when no issue title is given', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	t.is(getClaudeModel(config), 'opus');
	t.is(getClaudeEffort(config), 'high');
});

test('model + effort: profile-only → applies to that profile alone', t => {
	const config = makeConfig({}, {model: 'sonnet', effort: 'medium'});
	t.is(getClaudeModel(config, 'backend work'), 'sonnet');
	t.is(getClaudeEffort(config, 'backend work'), 'medium');
	// A profile without its own values, and the no-title case, stay empty.
	t.is(getClaudeModel(config, 'frontend work'), '');
	t.is(getClaudeEffort(config, 'frontend work'), '');
	t.is(getClaudeModel(config), '');
	t.is(getClaudeEffort(config), '');
});

test('model + effort: profile beats top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getClaudeModel(config, 'backend work'), 'sonnet');
	t.is(getClaudeEffort(config, 'backend work'), 'medium');
	// The unconfigured profile still inherits the top-level values.
	t.is(getClaudeModel(config, 'frontend work'), 'opus');
	t.is(getClaudeEffort(config, 'frontend work'), 'high');
});

test('model + effort: profile can set one field and inherit the other', t => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}}, {
		effort: 'max',
	} as PappardelleConfig['claude']);
	t.is(getClaudeModel(config, 'backend work'), 'opus');
	t.is(getClaudeEffort(config, 'backend work'), 'max');
});

test('model + effort: explicit empty string at profile level clears the global', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: '', effort: ''},
	);
	t.is(getClaudeModel(config, 'backend work'), '');
	t.is(getClaudeEffort(config, 'backend work'), '');
	// Sibling profile is unaffected.
	t.is(getClaudeModel(config, 'frontend work'), 'opus');
});

test('model + effort: explicit empty string at top level behaves as unset', t => {
	const config = makeConfig({claude: {model: '', effort: ''}});
	t.is(getClaudeModel(config, 'backend work'), '');
	t.is(getClaudeEffort(config, 'backend work'), '');
});

test('model + effort: unmatched issue title falls back to top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	t.is(getClaudeModel(config, 'something unrelated'), 'opus');
	t.is(getClaudeEffort(config, 'something unrelated'), 'high');
});

test('model + effort: a profile claude section without them inherits top-level', t => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{initialization_command: '/do'},
	);
	t.is(getClaudeModel(config, 'backend work'), 'opus');
	t.is(getClaudeEffort(config, 'backend work'), 'high');
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
// buildClaudeResumeCommand
// ============================================================================

test('buildClaudeResumeCommand: no model/effort → byte-identical to master', t => {
	// Off-by-default regression guard. This is the exact string master
	// produces; if a launch flag ever leaks in when nothing is configured,
	// this test fails.
	const expected =
		"claude --name STA-1 --continue || { printf '\\033[A\\033[2K'; false; } || claude --name STA-1";
	t.is(buildClaudeResumeCommand('STA-1'), expected);
	t.is(buildClaudeResumeCommand('STA-1', false), expected);
	t.is(buildClaudeResumeCommand('STA-1', false, {}), expected);
	t.is(
		buildClaudeResumeCommand('STA-1', false, {model: '', effort: ''}),
		expected,
	);
});

test('buildClaudeResumeCommand: skip-permissions only is unchanged', t => {
	const expected =
		"claude --dangerously-skip-permissions --name STA-1 --continue || { printf '\\033[A\\033[2K'; false; } || claude --dangerously-skip-permissions --name STA-1";
	t.is(buildClaudeResumeCommand('STA-1', true), expected);
	t.is(buildClaudeResumeCommand('STA-1', true, {}), expected);
});

test('buildClaudeResumeCommand: model only', t => {
	const cmd = buildClaudeResumeCommand('STA-1', false, {model: 'sonnet'});
	t.true(cmd.startsWith('claude --model sonnet --name STA-1 --continue'));
	// Both branches of the || fallback carry the flag.
	t.is(cmd.split('--model sonnet').length - 1, 2);
	t.false(cmd.includes('--effort'));
});

test('buildClaudeResumeCommand: effort only', t => {
	const cmd = buildClaudeResumeCommand('STA-1', false, {effort: 'high'});
	t.true(cmd.startsWith('claude --effort high --name STA-1 --continue'));
	t.is(cmd.split('--effort high').length - 1, 2);
	t.false(cmd.includes('--model'));
});

test('buildClaudeResumeCommand: full flag order is dsp → model → effort → name', t => {
	const cmd = buildClaudeResumeCommand('STA-1', true, {
		model: 'opus',
		effort: 'max',
	});
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --model opus --effort max --name STA-1 --continue',
		),
	);
});

test('buildClaudeResumeCommand: shell-quotes exotic model values', t => {
	const cmd = buildClaudeResumeCommand('STA-1', false, {
		model: 'claude-opus-5[1m]',
	});
	t.true(cmd.includes(`--model 'claude-opus-5[1m]'`));
	t.false(cmd.includes('--model claude-opus-5[1m] '));
});

test('buildClaudeResumeCommand: escapes embedded single quotes', t => {
	const cmd = buildClaudeResumeCommand('STA-1', false, {model: "we'ird"});
	t.true(cmd.includes(`--model 'we'\\''ird'`));
});
