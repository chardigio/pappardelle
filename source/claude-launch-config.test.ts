import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
import type {PappardelleConfig} from './config.ts';
import {
	getAgentProfile,
	getCompanionCommand,
	sousChefLaunch,
} from './config.ts';
import {validateConfig} from './config-validation.ts';
import {ConfigValidationError} from './config-errors.ts';
import {buildAgentResumeCommand} from './tmux.ts';
import {DEFAULT_RESOLVED_AGENT_PROFILE} from './config.ts';

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

test('model + effort: unset everywhere → empty strings', () => {
	const config = makeConfig();
	expect(getAgentProfile(config).model).toBe('');
	expect(getAgentProfile(config).effort).toBe('');
	expect(getAgentProfile(config, 'backend work').model).toBe('');
	expect(getAgentProfile(config, 'backend work').effort).toBe('');
});

test('model + effort: top-level only → applies to every profile', () => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	expect(getAgentProfile(config, 'backend work').model).toBe('opus');
	expect(getAgentProfile(config, 'backend work').effort).toBe('high');
	expect(getAgentProfile(config, 'frontend work').model).toBe('opus');
	expect(getAgentProfile(config, 'frontend work').effort).toBe('high');
});

test('model + effort: top-level applies when no issue title is given', () => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}});
	expect(getAgentProfile(config).model).toBe('opus');
	expect(getAgentProfile(config).effort).toBe('high');
});

test('model + effort: profile-only → applies to that profile alone', () => {
	const config = makeConfig({}, {model: 'sonnet', effort: 'medium'});
	expect(getAgentProfile(config, 'backend work').model).toBe('sonnet');
	expect(getAgentProfile(config, 'backend work').effort).toBe('medium');
	// A profile without its own values, and the no-title case, stay empty.
	expect(getAgentProfile(config, 'frontend work').model).toBe('');
	expect(getAgentProfile(config, 'frontend work').effort).toBe('');
	expect(getAgentProfile(config).model).toBe('');
	expect(getAgentProfile(config).effort).toBe('');
});

test('model + effort: profile beats top-level', () => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	expect(getAgentProfile(config, 'backend work').model).toBe('sonnet');
	expect(getAgentProfile(config, 'backend work').effort).toBe('medium');
	// The unconfigured profile still inherits the top-level values.
	expect(getAgentProfile(config, 'frontend work').model).toBe('opus');
	expect(getAgentProfile(config, 'frontend work').effort).toBe('high');
});

test('model + effort: profile can set one field and inherit the other', () => {
	const config = makeConfig({claude: {model: 'opus', effort: 'high'}}, {
		effort: 'max',
	} as PappardelleConfig['claude']);
	expect(getAgentProfile(config, 'backend work').model).toBe('opus');
	expect(getAgentProfile(config, 'backend work').effort).toBe('max');
});

test('model + effort: explicit empty string at profile level clears the global', () => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: '', effort: ''},
	);
	expect(getAgentProfile(config, 'backend work').model).toBe('');
	expect(getAgentProfile(config, 'backend work').effort).toBe('');
	// Sibling profile is unaffected.
	expect(getAgentProfile(config, 'frontend work').model).toBe('opus');
});

test('model + effort: explicit empty string at top level behaves as unset', () => {
	const config = makeConfig({claude: {model: '', effort: ''}});
	expect(getAgentProfile(config, 'backend work').model).toBe('');
	expect(getAgentProfile(config, 'backend work').effort).toBe('');
});

test('model + effort: unmatched issue title falls back to top-level', () => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{model: 'sonnet', effort: 'medium'},
	);
	expect(getAgentProfile(config, 'something unrelated').model).toBe('opus');
	expect(getAgentProfile(config, 'something unrelated').effort).toBe('high');
});

test('model + effort: a profile claude section without them inherits top-level', () => {
	const config = makeConfig(
		{claude: {model: 'opus', effort: 'high'}},
		{initialization_command: '/do'},
	);
	expect(getAgentProfile(config, 'backend work').model).toBe('opus');
	expect(getAgentProfile(config, 'backend work').effort).toBe('high');
});

// ============================================================================
// Validation
// ============================================================================

test('validateConfig accepts model + effort at top level and per profile', () => {
	expect(() => {
		validateConfig(
			makeConfig(
				{claude: {model: 'opus', effort: 'high'}},
				{model: 'claude-opus-5[1m]', effort: 'max'},
			),
		);
	}).not.toThrow();
});

test('validateConfig accepts an explicit empty string (means "no flag")', () => {
	expect(() => {
		validateConfig(makeConfig({claude: {model: '', effort: ''}}, {model: ''}));
	}).not.toThrow();
});

test('validateConfig rejects a non-string top-level model', () => {
	const config = makeConfig({
		claude: {model: 5 as unknown as string},
	});
	const error = thrownBy(() => {
		validateConfig(config);
	}, ConfigValidationError);
	expect(
		error!.errors.some(e => e.includes('claude.model: must be a string')),
	).toBe(true);
});

test('validateConfig rejects a non-string top-level effort', () => {
	const config = makeConfig({
		claude: {effort: true as unknown as string},
	});
	const error = thrownBy(() => {
		validateConfig(config);
	}, ConfigValidationError);
	expect(
		error!.errors.some(e => e.includes('claude.effort: must be a string')),
	).toBe(true);
});

test('validateConfig rejects a non-string per-profile model/effort', () => {
	const config = makeConfig(
		{},
		{
			model: 1 as unknown as string,
			effort: [] as unknown as string,
		},
	);
	const error = thrownBy(() => {
		validateConfig(config);
	}, ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('profiles.backend.claude.model: must be a string'),
		),
	).toBe(true);
	expect(
		error!.errors.some(e =>
			e.includes('profiles.backend.claude.effort: must be a string'),
		),
	).toBe(true);
});

// ============================================================================
// buildAgentResumeCommand
// ============================================================================

test('buildAgentResumeCommand: no model/effort → byte-identical to master', () => {
	// Off-by-default regression guard. This is the exact string master
	// produces; if a launch flag ever leaks in when nothing is configured,
	// this test fails.
	const expected =
		"claude --name STA-1 --resume sess-1 || { printf '\\033[A\\033[2K'; false; } || claude --name STA-1";
	expect(
		buildAgentResumeCommand(
			'STA-1',
			false,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
	).toBe(expected);
	expect(
		buildAgentResumeCommand(
			'STA-1',
			false,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
	).toBe(expected);
});

test('buildAgentResumeCommand: a launch renames the agent and starts both branches on its prompt', () => {
	expect(
		buildAgentResumeCommand(
			'main',
			false,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
			{name: 'sous-chef', prompt: '/sous-chef'},
		),
	).toBe(
		"claude --name sous-chef --resume sess-1 '/sous-chef' || { printf '\\033[A\\033[2K'; false; } || claude --name sous-chef '/sous-chef'",
	);
});

test('buildAgentResumeCommand: skip-permissions only is unchanged', () => {
	const expected =
		"claude --dangerously-skip-permissions --name STA-1 --resume sess-1 || { printf '\\033[A\\033[2K'; false; } || claude --dangerously-skip-permissions --name STA-1";
	expect(
		buildAgentResumeCommand(
			'STA-1',
			true,
			DEFAULT_RESOLVED_AGENT_PROFILE,
			'sess-1',
		),
	).toBe(expected);
});

test('buildAgentResumeCommand: model only', () => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, model: 'sonnet'},
		'sess-1',
	);
	expect(
		cmd.startsWith('claude --model sonnet --name STA-1 --resume sess-1'),
	).toBe(true);
	// Both branches of the || fallback carry the flag.
	expect(cmd.split('--model sonnet').length - 1).toBe(2);
	expect(cmd.includes('--effort')).toBe(false);
});

test('buildAgentResumeCommand: effort only', () => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, effort: 'high'},
		'sess-1',
	);
	expect(
		cmd.startsWith('claude --effort high --name STA-1 --resume sess-1'),
	).toBe(true);
	expect(cmd.split('--effort high').length - 1).toBe(2);
	expect(cmd.includes('--model')).toBe(false);
});

test('buildAgentResumeCommand: full flag order is dsp → model → effort → name', () => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		true,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, model: 'opus', effort: 'max'},
		'sess-1',
	);
	expect(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --model opus --effort max --name STA-1 --resume sess-1',
		),
	).toBe(true);
});

test('buildAgentResumeCommand: shell-quotes exotic model values', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		model: 'claude-opus-5[1m]',
	});
	expect(cmd.includes(`--model 'claude-opus-5[1m]'`)).toBe(true);
	expect(cmd.includes('--model claude-opus-5[1m] ')).toBe(false);
});

test('buildAgentResumeCommand: escapes embedded single quotes', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		model: "we'ird",
	});
	expect(cmd.includes(`--model 'we'\\''ird'`)).toBe(true);
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

test('extra_args: unset everywhere → empty list', () => {
	expect(extraArgs(makeConfig())).toStrictEqual([]);
	expect(extraArgs(makeConfig(), 'backend work')).toStrictEqual([]);
});

test('extra_args: top-level applies to every profile', () => {
	const config = makeConfig({claude: {extra_args: ['--no-chrome']}});
	expect(extraArgs(config)).toStrictEqual(['--no-chrome']);
	expect(extraArgs(config, 'frontend work')).toStrictEqual(['--no-chrome']);
});

test('extra_args: profile list replaces the top-level list', () => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: QA_ARGS},
	);
	expect(extraArgs(config, 'backend work')).toStrictEqual(QA_ARGS);
	expect(extraArgs(config, 'frontend work')).toStrictEqual(['--no-chrome']);
});

test('extra_args: an empty profile list clears the top-level list', () => {
	const config = makeConfig(
		{claude: {extra_args: ['--no-chrome']}},
		{extra_args: []},
	);
	expect(extraArgs(config, 'backend work')).toStrictEqual([]);
});

test('extra_args: only claude agent profiles get them', () => {
	const config = makeConfig(
		{
			agent_profiles: {codex: {command: 'codex'}},
			agent_profile: 'codex',
		},
		{extra_args: QA_ARGS},
	);
	expect(extraArgs(config, 'backend work')).toStrictEqual([]);
});

test("extra_args: an agent profile's own args don't drop them", () => {
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
	expect(
		cmd.startsWith(
			"claude --verbose --strict-mcp-config --tools 'Bash,Read' --name QA-1",
		),
	).toBe(true);
});

// The saved profile (idow writes it to space-state) beats the title match. A
// dev issue titled with the runner's keyword must not get the runner's
// locked-down tools when the TUI starts its session again.

test('saved profile: beats a title that matches a different profile', () => {
	const config = makeConfig(
		{companion_command: 'gitui'},
		{model: 'sonnet', effort: 'high', extra_args: QA_ARGS},
		{model: 'opus', effort: 'low'},
	);
	config.profiles['frontend']!.companion_command = '';
	const title = 'backend work';
	const frontend = getAgentProfile(config, title, 'frontend');
	expect(frontend.extraArgs).toStrictEqual([]);
	expect(frontend.model).toBe('opus');
	expect(frontend.effort).toBe('low');
	expect(getCompanionCommand(config, title, 'frontend')).toBe('');
	expect(extraArgs(config, 'frontend work', 'backend')).toStrictEqual(QA_ARGS);
});

test('saved profile: a name that no longer exists falls back to the title', () => {
	// A profile rename leaves the old name in space-state.
	const config = makeConfig({}, {extra_args: QA_ARGS});
	expect(extraArgs(config, 'backend work', 'renamed')).toStrictEqual(QA_ARGS);
	expect(getCompanionCommand(config, 'backend work', 'renamed')).toBe(
		'GIT_OPTIONAL_LOCKS=0 gitui',
	);
});

test('validateConfig accepts extra_args at top level and per profile', () => {
	expect(() => {
		validateConfig(
			makeConfig({claude: {extra_args: ['--no-chrome']}}, {extra_args: []}),
		);
	}).not.toThrow();
});

test('validateConfig rejects extra_args that is not a list of strings', () => {
	const config = makeConfig(
		{claude: {extra_args: '--no-chrome' as unknown as string[]}},
		{extra_args: ['--tools', 5] as unknown as string[]},
	);
	const error = thrownBy(() => {
		validateConfig(config);
	}, ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('claude.extra_args: must be a list of strings'),
		),
	).toBe(true);
	expect(
		error!.errors.some(e =>
			e.includes(
				'profiles.backend.claude.extra_args: must be a list of strings',
			),
		),
	).toBe(true);
});

test('buildAgentResumeCommand: extra args go after effort and before name, on both branches', () => {
	const cmd = buildAgentResumeCommand(
		'QA-1',
		true,
		{...DEFAULT_RESOLVED_AGENT_PROFILE, effort: 'high', extraArgs: QA_ARGS},
		'sess-1',
	);
	expect(
		cmd.startsWith(
			"claude --dangerously-skip-permissions --effort high --strict-mcp-config --tools 'Bash,Read' --name QA-1 --resume sess-1",
		),
	).toBe(true);
	expect(cmd.split('--strict-mcp-config').length - 1).toBe(2);
});

test('buildAgentResumeCommand: shell-quotes each extra arg', () => {
	const cmd = buildAgentResumeCommand('QA-1', false, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		extraArgs: ['--mcp-config', '{"mcpServers": {}}'],
	});
	expect(cmd.includes(`--mcp-config '{"mcpServers": {}}' --name QA-1`)).toBe(
		true,
	);
});

// agy refuses a bare prompt, so its relaunch must not end in a prompt flag that
// would swallow the next argument or exit with "flag needs an argument".
test('buildAgentResumeCommand: a minimal agy profile relaunches without a prompt flag', () => {
	const agentProfile = getAgentProfile(
		makeConfig({
			agent_profiles: {argon: {command: 'agy', model: 'gemini-4-argon-medium'}},
			agent_profile: 'argon',
		}),
	);
	expect(buildAgentResumeCommand('STA-1', false, agentProfile)).toBe(
		'agy --model gemini-4-argon-medium',
	);
	expect(buildAgentResumeCommand('STA-1', false, agentProfile, 'conv-1')).toBe(
		"agy --model gemini-4-argon-medium --conversation conv-1 || { printf '\\033[A\\033[2K'; false; } || agy --model gemini-4-argon-medium",
	);
});

test('sousChefLaunch uses the resolved agent skillPrefix and wires through agy and codex launch commands', () => {
	const cases = [
		{
			agent: {command: 'agy', model: 'gemini-4-hydrogen-medium', mode: 'plan'},
			launch: {name: 'sous-chef', prompt: '/sous-chef'},
			sessionId: undefined,
			rules: true,
			command:
				"agy --model gemini-4-hydrogen-medium --mode plan -i '/sous-chef'",
		},
		{
			agent: {command: 'agy', model: 'gemini-4-hydrogen-medium', mode: 'plan'},
			launch: {name: 'sous-chef', prompt: '/sous-chef'},
			sessionId: 'conv-1',
			rules: true,
			command:
				"agy --model gemini-4-hydrogen-medium --mode plan --conversation conv-1 -i '/sous-chef' || { printf '\\033[A\\033[2K'; false; } || agy --model gemini-4-hydrogen-medium --mode plan -i '/sous-chef'",
		},
		{
			agent: {command: 'codex', args: '--yolo'},
			launch: {name: 'sous-chef', prompt: '$sous-chef'},
			sessionId: 'sess-1',
			rules: false,
			command:
				"codex --yolo resume sess-1 '$sous-chef' || { printf '\\033[A\\033[2K'; false; } || codex --yolo '$sous-chef'",
		},
		{
			agent: undefined,
			launch: {name: 'sous-chef', prompt: '/sous-chef'},
			sessionId: 'sess-1',
			rules: true,
			command:
				"claude --name sous-chef --resume sess-1 '/sous-chef' || { printf '\\033[A\\033[2K'; false; } || claude --name sous-chef '/sous-chef'",
		},
		{
			agent: {command: 'custom-cli', prompt_args: '--prompt {prompt}'},
			launch: {name: 'sous-chef', prompt: '/sous-chef'},
			sessionId: undefined,
			rules: false,
			command: "custom-cli --prompt '/sous-chef'",
		},
		{
			agent: {command: 'pi'},
			launch: {name: 'sous-chef'},
			sessionId: undefined,
			rules: false,
			command: 'pi',
		},
		{
			agent: {command: 'env FOO=1 agy'},
			launch: {name: 'sous-chef', prompt: '/sous-chef'},
			sessionId: undefined,
			rules: false,
			command: "env FOO=1 agy -i '/sous-chef'",
		},
		{
			agent: {command: 'env FOO=1 custom-cli'},
			launch: {name: 'sous-chef'},
			sessionId: undefined,
			rules: false,
			command: 'env FOO=1 custom-cli',
		},
	];

	for (const c of cases) {
		const config = makeConfig({
			sous_chef: true,
			...(c.agent && {
				agent_profiles: {target: c.agent},
				agent_profile: 'target',
			}),
		});
		const profile = getAgentProfile(config);
		const launch = sousChefLaunch(config, profile);
		expect(launch).toStrictEqual(c.launch);
		expect(
			buildAgentResumeCommand('main', false, profile, c.sessionId, {
				rules: c.rules,
				...launch,
			}),
		).toBe(c.command);
	}

	const agyProfile = getAgentProfile(
		makeConfig({
			agent_profiles: {agy: {command: 'agy'}},
			agent_profile: 'agy',
		}),
	);
	expect(sousChefLaunch(makeConfig({sous_chef: false}), agyProfile)).toBe(
		undefined,
	);
});
