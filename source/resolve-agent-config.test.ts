import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {agentRulesFlags} from './companion-rules.ts';
import {execFileSync, execSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stringify} from 'yaml';
import {BUILTIN_AGENTS} from './builtin-agents.ts';
import {getAgentProfile, loadConfigFromPaths} from './config.ts';
import {renderAgentLaunchFlags} from './config-launch-flags.ts';

const SCRIPT_PATH = path.resolve(
	import.meta.dirname!,
	'..',
	'scripts',
	'resolve-agent-config.sh',
);

/**
 * Helper to create a temp directory with base and optional local/home config files.
 * Returns the paths to the created files and a cleanup function.
 */
function setupConfigFiles(
	baseYaml: string,
	localYaml?: string,
	homeYaml?: string,
): {
	configPath: string;
	localConfigPath: string;
	homeConfigPath: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-test-'));
	const configPath = path.join(tmpDir, '.pappardelle.yml');
	const localConfigPath = path.join(tmpDir, '.pappardelle.local.yml');
	const homeConfigPath = path.join(tmpDir, '.pappardelle.home.yml');

	fs.writeFileSync(configPath, baseYaml, 'utf-8');
	if (localYaml) {
		fs.writeFileSync(localConfigPath, localYaml, 'utf-8');
	}

	if (homeYaml) {
		fs.writeFileSync(homeConfigPath, homeYaml, 'utf-8');
	}

	return {
		configPath,
		localConfigPath,
		homeConfigPath,
		cleanup() {
			fs.rmSync(tmpDir, {recursive: true, force: true});
		},
	};
}

/**
 * Run the resolve-agent-config.sh script and parse its JSON output.
 */
function runResolver(
	configPath: string,
	localConfigPath: string,
	homeConfigPath?: string,
	profile?: string,
): {
	init_cmd: string;
	skip_permissions: string;
	agent_command: string;
	agent_args: string;
	agent_resume_args: string;
	agent_prompt_args: string;
	agent_skill_prefix: string;
	agent_is_claude: string;
	agent_launch_flags: string;
	agent_env: string;
	agent_rules_flags: string;
	workspace_aware: string;
	model: string;
	effort: string;
	mode: string;
	deprecation_warnings: string;
} {
	let cmd = `bash "${SCRIPT_PATH}" --config "${configPath}" --local-config "${localConfigPath}"`;
	if (homeConfigPath) {
		cmd += ` --home-config "${homeConfigPath}"`;
	}

	if (profile) {
		cmd += ` --profile "${profile}"`;
	}

	const output = execSync(cmd, {encoding: 'utf-8'}).trim();
	return JSON.parse(output) as ReturnType<typeof runResolver>;
}

// Check yq is available; skip all tests if not
const yqAvailable = (() => {
	try {
		execSync('command -v yq', {stdio: 'pipe'});
		return true;
	} catch {
		return false;
	}
})();

const maybeMacro = yqAvailable ? test : test.skip;

maybeMacro(
	'malformed YAML fails instead of returning an empty successful result',
	() => {
		const fixture = setupConfigFiles('claude: [unterminated');
		teardown(fixture.cleanup);
		expect(() =>
			execFileSync('bash', [SCRIPT_PATH, '--config', fixture.configPath], {
				stdio: 'pipe',
			}),
		).toThrow();
	},
);

maybeMacro(
	'values that JSON cannot hold in unrelated keys do not break resolution',
	() => {
		// idow runs with set -e, so a resolver failure here stops every
		// workspace start. Only the keys the resolver reads may matter.
		const fixture = setupConfigFiles(`version: 1
timeout: .inf
big: 12345678901234567890
claude:
  model: opus
profiles:
  app:
    retries: .nan
    claude:
      effort: high
  other:
    limit: 12345678901234567890
`);
		teardown(fixture.cleanup);
		const output = execFileSync(
			'bash',
			[SCRIPT_PATH, '--config', fixture.configPath, '--profile', 'app'],
			{encoding: 'utf-8', stdio: 'pipe'},
		);
		const result = JSON.parse(output) as {model: string; effort: string};
		expect(result.model).toBe('opus');
		expect(result.effort).toBe('high');
	},
);

// ============================================================================
// Base config only (no local override)
// ============================================================================

maybeMacro(
	'reads dangerously_skip_permissions from base config when no local config exists',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: true
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('true');
			expect(result.init_cmd).toBe('/idow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'returns defaults when base config has no claude section and no local config',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
profiles:
  test:
    display_name: Test
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('false');
			expect(result.init_cmd).toBe('');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Local override for dangerously_skip_permissions
// ============================================================================

maybeMacro(
	'local config overrides dangerously_skip_permissions from false to true',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: false
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: true
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('true');
			// initialization_command should be preserved from base
			expect(result.init_cmd).toBe('/idow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'local config overrides dangerously_skip_permissions from true to false',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: true
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: false
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('false');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'local config adds dangerously_skip_permissions when base has no claude section',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: true
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('true');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Local override for initialization_command
// ============================================================================

maybeMacro('local config overrides initialization_command', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
claude:
  initialization_command: "/idow"
  dangerously_skip_permissions: true
profiles:
  test:
    display_name: Test
`,
		`claude:
  initialization_command: "/dow"
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.init_cmd).toBe('/dow');
		// dangerously_skip_permissions should be preserved from base
		expect(result.skip_permissions).toBe('true');
	} finally {
		cleanup();
	}
});

maybeMacro(
	'local config adds initialization_command when base has none',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
profiles:
  test:
    display_name: Test
`,
			`claude:
  initialization_command: "/idow"
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.init_cmd).toBe('/idow');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Both overrides simultaneously
// ============================================================================

maybeMacro(
	'local config overrides both initialization_command and dangerously_skip_permissions',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  initialization_command: "/idow"
  dangerously_skip_permissions: false
profiles:
  test:
    display_name: Test
`,
			`claude:
  initialization_command: "/dow"
  dangerously_skip_permissions: true
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.init_cmd).toBe('/dow');
			expect(result.skip_permissions).toBe('true');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Local config with non-claude fields should not affect claude config
// ============================================================================

maybeMacro(
	'local config with only issue_watchlist does not affect claude config',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: true
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
			`issue_watchlist:
  statuses:
    - Todo
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.skip_permissions).toBe('true');
			expect(result.init_cmd).toBe('/idow');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Invalid local config values should be ignored
// ============================================================================

maybeMacro(
	'local config with non-boolean dangerously_skip_permissions is ignored',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: true
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: "yes"
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			// Invalid value falls back to safe default (false), not the base value.
			// This is intentional: an invalid override shouldn't preserve a dangerous "true".
			expect(result.skip_permissions).toBe('false');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Three-layer merge: home → project → local
// ============================================================================

maybeMacro(
	'home config provides defaults when project has no claude section',
	() => {
		const {configPath, localConfigPath, homeConfigPath, cleanup} =
			setupConfigFiles(
				`version: 1
profiles:
  test:
    display_name: Test
`,
				undefined,
				`claude:
  dangerously_skip_permissions: true
  initialization_command: "/dow"
`,
			);
		try {
			const result = runResolver(configPath, localConfigPath, homeConfigPath);
			expect(result.skip_permissions).toBe('true');
			expect(result.init_cmd).toBe('/dow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro('project config overrides home config', () => {
	const {configPath, localConfigPath, homeConfigPath, cleanup} =
		setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: false
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
			undefined,
			`claude:
  dangerously_skip_permissions: true
  initialization_command: "/dow"
`,
		);
	try {
		const result = runResolver(configPath, localConfigPath, homeConfigPath);
		expect(result.skip_permissions).toBe('false');
		expect(result.init_cmd).toBe('/idow');
	} finally {
		cleanup();
	}
});

maybeMacro('local config overrides both home and project config', () => {
	const {configPath, localConfigPath, homeConfigPath, cleanup} =
		setupConfigFiles(
			`version: 1
claude:
  dangerously_skip_permissions: false
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: true
  initialization_command: "/do-stardust"
`,
			`claude:
  dangerously_skip_permissions: false
  initialization_command: "/dow"
`,
		);
	try {
		const result = runResolver(configPath, localConfigPath, homeConfigPath);
		expect(result.skip_permissions).toBe('true');
		expect(result.init_cmd).toBe('/do-stardust');
	} finally {
		cleanup();
	}
});

maybeMacro('partial overrides at each layer merge correctly', () => {
	const {configPath, localConfigPath, homeConfigPath, cleanup} =
		setupConfigFiles(
			`version: 1
claude:
  initialization_command: "/idow"
profiles:
  test:
    display_name: Test
`,
			`claude:
  dangerously_skip_permissions: true
`,
			`claude:
  dangerously_skip_permissions: false
`,
		);
	try {
		const result = runResolver(configPath, localConfigPath, homeConfigPath);
		// init_cmd from project (/idow), skip_permissions from local (true)
		expect(result.init_cmd).toBe('/idow');
		expect(result.skip_permissions).toBe('true');
	} finally {
		cleanup();
	}
});

maybeMacro('missing home config file is gracefully ignored', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
claude:
  dangerously_skip_permissions: true
profiles:
  test:
    display_name: Test
`,
	);
	try {
		// Pass a non-existent home config path — should not error
		const result = runResolver(
			configPath,
			localConfigPath,
			'/tmp/nonexistent-home-config.yml',
		);
		expect(result.skip_permissions).toBe('true');
	} finally {
		cleanup();
	}
});

// ============================================================================
// Agent profile resolution
// ============================================================================

maybeMacro('defaults to the built-in claude agent profile', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_profile).toBe('claude');
		expect(result.agent_command).toBe('claude');
		expect(result.agent_args).toBe('');
		expect(result.agent_resume_args).toBe('--resume {session_id}');
		expect(result.agent_is_claude).toBe('true');
	} finally {
		cleanup();
	}
});

maybeMacro('resolves an agent profile referenced at the top level', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
agent_profiles:
  codex:
    command: codex
    args: --yolo
    resume_args: resume --last
agent_profile: codex
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_command).toBe('codex');
		expect(result.agent_args).toBe('--yolo');
		expect(result.agent_resume_args).toBe('resume --last');
		expect(result.agent_is_claude).toBe('false');
	} finally {
		cleanup();
	}
});

maybeMacro('renders the same rule flags as the TUI launcher', () => {
	for (const command of ['codex', '/opt/bin/pi', 'claude', 'agy', 'opencode']) {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
workspace_aware_agents: true
agent_profiles:
  a:
    command: ${command}
agent_profile: a
profiles:
  test:
    display_name: Test
`,
		);
		try {
			const agentProfile = getAgentProfile(
				loadConfigFromPaths({projectDir: path.dirname(configPath)}),
			);
			expect(runResolver(configPath, localConfigPath).agent_rules_flags).toBe(
				agentRulesFlags(agentProfile.rulesArgs).trim(),
			);
		} finally {
			cleanup();
		}
	}
});

maybeMacro('renders no rule flags for a codex profile gated as claude', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
workspace_aware_agents: true
agent_profiles:
  a:
    command: codex
    is_claude: true
agent_profile: a
profiles:
  test:
    display_name: Test
`,
	);
	try {
		expect(runResolver(configPath, localConfigPath).agent_rules_flags).toBe('');
	} finally {
		cleanup();
	}
});

maybeMacro('renders no rule flags without workspace_aware_agents', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
agent_profiles:
  a:
    command: codex
agent_profile: a
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_rules_flags).toBe('');
		expect(result.workspace_aware).toBe('false');
	} finally {
		cleanup();
	}
});

maybeMacro(
	'profile agent_profile reference wins over the top-level one',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
agent_profiles:
  codex:
    command: codex
profiles:
  chaz:
    display_name: Chaz
    agent_profile: codex
  plain:
    display_name: Plain
`,
		);
		try {
			const withProfile = runResolver(
				configPath,
				localConfigPath,
				undefined,
				'chaz',
			);
			expect(withProfile.agent_command).toBe('codex');
			// codex's resume comes from the built-in agent mapping.
			expect(withProfile.agent_resume_args).toBe('resume {session_id}');
			expect(withProfile.agent_is_claude).toBe('false');

			const otherProfile = runResolver(
				configPath,
				localConfigPath,
				undefined,
				'plain',
			);
			expect(otherProfile.agent_command).toBe('claude');
			expect(otherProfile.agent_is_claude).toBe('true');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'empty-string profile agent_profile clears an inherited reference',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
agent_profiles:
  codex:
    command: codex
agent_profile: codex
profiles:
  plain:
    display_name: Plain
    agent_profile: ""
`,
		);
		try {
			const result = runResolver(
				configPath,
				localConfigPath,
				undefined,
				'plain',
			);
			expect(result.agent_command).toBe('claude');
			expect(result.agent_is_claude).toBe('true');
		} finally {
			cleanup();
		}
	},
);

maybeMacro('is_claude override forces claude treatment for a wrapper', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
agent_profiles:
  local:
    command: claude-local
    is_claude: true
agent_profile: local
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_command).toBe('claude-local');
		expect(result.agent_is_claude).toBe('true');
		expect(result.agent_resume_args).toBe('--resume {session_id}');
	} finally {
		cleanup();
	}
});

maybeMacro('explicit is_claude false opts a claude-named command out', () => {
	// Regression: yq's `//` operator treats `false` as falsy, so a naive
	// `.is_claude // ""` read silently discarded the opt-out and the basename
	// predicate re-gated the agent profile as claude.
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
agent_profiles:
  sneaky:
    command: claude
    is_claude: false
agent_profile: sneaky
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_command).toBe('claude');
		expect(result.agent_is_claude).toBe('false');
		// Not claude ⇒ no claude resume default either.
		expect(result.agent_resume_args).toBe('');
	} finally {
		cleanup();
	}
});

maybeMacro('claude predicate splits the first token on any whitespace', () => {
	// Matches isClaudeCommand()'s /\s+/ split in source/config-launch-flags.ts — a
	// tab-separated command must gate identically on both paths.
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
agent_profiles:
  tabbed:
    command: "claude\t--flag"
agent_profile: tabbed
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.agent_is_claude).toBe('true');
	} finally {
		cleanup();
	}
});

function runResolverExpectingError(
	configPath: string,
	extraArgs: string[] = [],
): string {
	try {
		execFileSync('bash', [SCRIPT_PATH, '--config', configPath, ...extraArgs], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		return String((error as {stderr?: string}).stderr ?? '');
	}

	throw new Error('resolver exited 0');
}

maybeMacro(
	'an undefined agent profile reference is an error, not a claude launch',
	() => {
		const {configPath, cleanup} = setupConfigFiles(
			`version: 1
agent_profiles:
  codex:
    command: codex
profiles:
  test:
    display_name: Test
    agent_profile: codeex
`,
		);
		try {
			const stderr = runResolverExpectingError(configPath, [
				'--profile',
				'test',
			]);
			expect(
				stderr.includes('agent profile "codeex" not found in agent_profiles'),
				stderr,
			).toBe(true);
		} finally {
			cleanup();
		}
	},
);

maybeMacro('agent profiles merge across config layers', () => {
	const {configPath, localConfigPath, homeConfigPath, cleanup} =
		setupConfigFiles(
			`version: 1
profiles:
  test:
    display_name: Test
`,
			`agent_profile: codex
`,
			`agent_profiles:
  codex:
    command: codex
    resume_args: resume --last
`,
		);
	try {
		const result = runResolver(configPath, localConfigPath, homeConfigPath);
		expect(result.agent_command).toBe('codex');
		expect(result.agent_resume_args).toBe('resume --last');
		expect(result.agent_is_claude).toBe('false');
	} finally {
		cleanup();
	}
});

// ============================================================================
// initialization_command rename
// ============================================================================

maybeMacro('init_cmd prefers the new top-level initialization_command', () => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
initialization_command: /new
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		expect(result.init_cmd).toBe('/new');
		expect(result.deprecation_warnings).toBe('');
	} finally {
		cleanup();
	}
});

maybeMacro(
	'init_cmd: a project on the old spelling beats a migrated home config',
	() => {
		const {configPath, localConfigPath, homeConfigPath, cleanup} =
			setupConfigFiles(
				`version: 1
claude:
  initialization_command: /project
profiles:
  test:
    display_name: Test
`,
				undefined,
				`version: 1
initialization_command: /home
`,
			);
		try {
			const result = runResolver(configPath, localConfigPath, homeConfigPath);
			expect(result.init_cmd).toBe('/project');
			expect(result.deprecation_warnings).toBe(
				`${configPath}: claude.initialization_command is deprecated — rename it to the top-level initialization_command`,
			);
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'init_cmd falls back to the deprecated claude spelling and flags it',
	() => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
claude:
  initialization_command: /old
profiles:
  test:
    display_name: Test
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			expect(result.init_cmd).toBe('/old');
			expect(result.deprecation_warnings).toMatch(
				/claude\.initialization_command is deprecated/,
			);
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// model / effort / extra args through agent profiles — bash must render what
// the TUI does
// ============================================================================

const LAUNCH_PARITY_CONFIG = `version: 1
claude:
  model: "claude-opus-5[1m]"
  effort: xhigh
  extra_args: [--no-chrome]
agent_profiles:
  codex:
    command: /opt/bin/codex
    args: --yolo
    model: gpt-5.5
    effort: high
  bare-codex:
    command: codex
  opus:
    command: claude
    model: opus
  aider:
    command: aider
    model: "it's [1m]"
    model_args: --model={model}
    effort: hard
    effort_args: --reasoning {effort} --effort={effort}
profiles:
  default-claude:
    display_name: Default claude
  claude-profile:
    display_name: Claude profile
    claude:
      model: sonnet
  codex:
    display_name: Codex
    agent_profile: codex
  bare-codex:
    display_name: Bare codex
    agent_profile: bare-codex
  opus:
    display_name: Opus
    agent_profile: opus
  aider:
    display_name: Aider
    agent_profile: aider
  qa:
    display_name: QA
    claude:
      extra_args: [--tools, "Bash,Read", "it's"]
  cleared:
    display_name: Cleared
    claude:
      extra_args: []
`;

for (const [profile, expected] of [
	['default-claude', " --model 'claude-opus-5[1m]' --effort xhigh --no-chrome"],
	['claude-profile', ' --model sonnet --effort xhigh --no-chrome'],
	['codex', ' -m gpt-5.5 -c model_reasoning_effort=high'],
	['bare-codex', ''],
	['opus', ' --model opus --effort xhigh --no-chrome'],
	['aider', " --model='it'\\''s [1m]' --reasoning hard --effort=hard"],
	[
		'qa',
		" --model 'claude-opus-5[1m]' --effort xhigh --tools 'Bash,Read' 'it'\\''s'",
	],
	['cleared', " --model 'claude-opus-5[1m]' --effort xhigh"],
] as const) {
	maybeMacro(`launch flags for the ${profile} profile match the TUI`, () => {
		const fixture = setupConfigFiles(LAUNCH_PARITY_CONFIG);
		teardown(fixture.cleanup);
		const config = loadConfigFromPaths({
			projectDir: path.dirname(fixture.configPath),
		});
		const tsFlags = renderAgentLaunchFlags(
			getAgentProfile(config, undefined, profile),
		);
		const result = runResolver(
			fixture.configPath,
			fixture.localConfigPath,
			undefined,
			profile,
		);
		const bashFlags = result.agent_launch_flags
			? ` ${result.agent_launch_flags}`
			: '';
		expect(tsFlags).toBe(expected);
		expect(bashFlags).toBe(expected);
	});
}

maybeMacro('the deprecated claude.model and claude.effort are flagged', () => {
	const fixture = setupConfigFiles(
		`version: 1
claude:
  model: opus
profiles:
  test:
    display_name: Test
`,
		undefined,
		`version: 1
claude:
  effort: high
`,
	);
	teardown(fixture.cleanup);
	const result = runResolver(
		fixture.configPath,
		fixture.localConfigPath,
		fixture.homeConfigPath,
	);
	expect(result.deprecation_warnings.split('\n')).toStrictEqual([
		`${fixture.homeConfigPath}: claude.effort is deprecated — set effort on an agent profile (agent_profiles.<name>.effort) and select it with agent_profile`,
		`${fixture.configPath}: claude.model is deprecated — set model on an agent profile (agent_profiles.<name>.model) and select it with agent_profile`,
	]);
	const clean = setupConfigFiles(`version: 1
profiles:
  test:
    display_name: Test
`);
	teardown(clean.cleanup);
	expect(
		runResolver(clean.configPath, clean.localConfigPath).deprecation_warnings,
	).toBe('');
});

// ============================================================================
// Built-in agent defaults (scripts/builtin-agents.json) — both readers
// ============================================================================

type AgentDefaultsCase = {
	definition: Record<string, unknown>;
	launchFlags: string;
	resumeArgs: string;
	promptArgs: string;
	skillPrefix: string;
};

const AGENT_DEFAULTS_CASES: Record<string, AgentDefaultsCase> = {
	...Object.fromEntries(
		Object.entries(BUILTIN_AGENTS).map(([name, builtin]) => [
			`${name}-minimal`,
			{
				definition: {
					command: name,
					...(builtin.model_args && {model: 'm1'}),
					...(builtin.effort_args && {effort: 'e1'}),
					...(builtin.mode_args && {mode: 'plan'}),
				},
				launchFlags: [
					builtin.model_args?.replace('{model}', 'm1'),
					builtin.effort_args?.replace('{effort}', 'e1'),
					builtin.mode_args?.replace('{mode}', 'plan'),
				]
					.filter(Boolean)
					.join(' '),
				resumeArgs: builtin.resume_args ?? '',
				promptArgs: builtin.prompt_args ?? '',
				skillPrefix: builtin.skill_prefix ?? '/',
			},
		]),
	),
	overridden: {
		definition: {
			command: '/usr/local/bin/agy',
			model: 'm1',
			model_args: '-M {model}',
			prompt_args: '--prompt {prompt}',
			resume_args: '',
			skill_prefix: '!',
		},
		launchFlags: '-M m1',
		resumeArgs: '',
		promptArgs: '--prompt {prompt}',
		skillPrefix: '!',
	},
	'claude-opted-out': {
		definition: {command: 'claude', is_claude: false},
		launchFlags: '',
		resumeArgs: '',
		promptArgs: '',
		skillPrefix: '/',
	},
	'claude-wrapper': {
		definition: {command: 'claude-local', is_claude: true, model: 'm1'},
		launchFlags: '--model m1',
		resumeArgs: '--resume {session_id}',
		promptArgs: '',
		skillPrefix: '/',
	},
	unknown: {
		definition: {command: 'aider'},
		launchFlags: '',
		resumeArgs: '',
		promptArgs: '',
		skillPrefix: '/',
	},
};

for (const [name, expected] of Object.entries(AGENT_DEFAULTS_CASES)) {
	maybeMacro(
		`built-in agent defaults: ${name} resolves the same in TS and bash`,
		() => {
			const fixture = setupConfigFiles(
				stringify({
					version: 1,
					agent_profiles: {[name]: expected.definition},
					agent_profile: name,
					profiles: {},
				}),
			);
			teardown(fixture.cleanup);
			const agentProfile = getAgentProfile(
				loadConfigFromPaths({projectDir: path.dirname(fixture.configPath)}),
			);
			const result = runResolver(fixture.configPath, fixture.localConfigPath);

			expect(renderAgentLaunchFlags(agentProfile).trim()).toBe(
				expected.launchFlags,
			);
			expect(result.agent_launch_flags).toBe(expected.launchFlags);
			expect(agentProfile.resumeArgs ?? '').toBe(expected.resumeArgs);
			expect(result.agent_resume_args).toBe(expected.resumeArgs);
			expect(agentProfile.skillPrefix).toBe(expected.skillPrefix);
			expect(result.agent_skill_prefix).toBe(expected.skillPrefix);
			expect(agentProfile.promptArgs ?? '').toBe(expected.promptArgs);
			expect(result.agent_prompt_args).toBe(expected.promptArgs);
			expect(agentProfile.mode).toBe(result.mode);
		},
	);
}

maybeMacro(
	'agy mode passes --mode only when set on the agent profile in both TS and bash',
	() => {
		const fixture = setupConfigFiles(
			`version: 1
claude:
  mode: plan
agent_profiles:
  agy-unset:
    command: agy
    model: gemini-4-hydrogen-medium
  agy-plan:
    command: agy
    model: gemini-4-hydrogen
    effort: high
    mode: plan
  agy-cleared:
    command: agy
    mode: plan
  claude-with-template:
    command: claude
    mode_args: '--permission-mode {mode}'
profiles:
  unset: {display_name: Unset, agent_profile: agy-unset}
  plan: {display_name: Plan, agent_profile: agy-plan}
  cleared: {display_name: Cleared, agent_profile: agy-cleared}
  claude-template: {display_name: ClaudeTemplate, agent_profile: claude-with-template}
`,
			`agent_profiles:
  agy-cleared:
    mode: ""
`,
		);
		teardown(fixture.cleanup);
		const config = loadConfigFromPaths({
			projectDir: path.dirname(fixture.configPath),
		});

		const checks: Array<[string, string, string]> = [
			['unset', '', '--model gemini-4-hydrogen-medium'],
			['plan', 'plan', '--model gemini-4-hydrogen --effort high --mode plan'],
			['cleared', '', ''],
			['claude-template', '', ''],
		];
		for (const [profile, expectedMode, expectedFlags] of checks) {
			const agentProfile = getAgentProfile(config, undefined, profile);
			const tsFlags = renderAgentLaunchFlags(agentProfile).trim();
			const resolved = runResolver(
				fixture.configPath,
				fixture.localConfigPath,
				undefined,
				profile,
			);
			expect(agentProfile.mode).toBe(expectedMode);
			expect(resolved.mode).toBe(expectedMode);
			expect(tsFlags).toBe(expectedFlags);
			expect(resolved.agent_launch_flags).toBe(expectedFlags);
		}
	},
);

maybeMacro(
	'agent_env is the agent profile env, merged per variable across layers',
	() => {
		const {configPath, localConfigPath, homeConfigPath, cleanup} =
			setupConfigFiles(
				`version: 1
agent_profiles:
  opus:
    env:
      SHARED: repo
      EXTRA: 'a b'
`,
				undefined,
				`version: 1
agent_profile: opus
agent_profiles:
  opus:
    command: claude
    env:
      CODE_MODE: '1'
      SHARED: home
`,
			);
		try {
			const result = runResolver(configPath, localConfigPath, homeConfigPath);
			expect(JSON.parse(result.agent_env)).toStrictEqual({
				CODE_MODE: '1',
				SHARED: 'repo',
				EXTRA: 'a b',
			});
		} finally {
			cleanup();
		}
	},
);

maybeMacro('agent_env is an empty map for an agent profile without env', () => {
	const {configPath, localConfigPath, cleanup} =
		setupConfigFiles('version: 1\n');
	try {
		expect(
			JSON.parse(runResolver(configPath, localConfigPath).agent_env),
		).toStrictEqual({});
	} finally {
		cleanup();
	}
});

// YAML spec: keys a map sets itself win over the ones a merge key brings in,
// wherever the merge key sits. The TUI's parser follows the spec.
const MERGE_KEY_AFTER_EXPLICIT = `version: 1
profiles: {}
agent_profile: opus
agent_profiles:
  base: {command: claude, env: &common {SHARED: s, OVER: base}}
  opus:
    command: claude
    env:
      OVER: mine
      <<: *common
`;

for (const [label, local] of [
	['a single layer', undefined],
	['merged layers', 'version: 1\n'],
] as const) {
	maybeMacro(
		`a merge key after explicit keys resolves per the YAML spec in ${label}`,
		() => {
			const {configPath, localConfigPath, cleanup} = setupConfigFiles(
				MERGE_KEY_AFTER_EXPLICIT,
				local,
			);
			try {
				const expected = {SHARED: 's', OVER: 'mine'};
				expect(
					getAgentProfile(
						loadConfigFromPaths({projectDir: path.dirname(configPath)}),
					).env,
				).toStrictEqual(expected);
				expect(
					JSON.parse(runResolver(configPath, localConfigPath).agent_env),
				).toStrictEqual(expected);
			} finally {
				cleanup();
			}
		},
	);
}

maybeMacro(
	'a merge key in the selected profile resolves without a yq warning',
	() => {
		const {configPath, cleanup} = setupConfigFiles(
			`version: 1
x: &pw {display_name: W, initialization_command: new, claude: {initialization_command: /old}}
profiles:
  v:
    claude: {model: opus}
    <<: *pw
`,
		);
		try {
			const result = spawnSync(
				'bash',
				[SCRIPT_PATH, '--config', configPath, '--profile', 'v'],
				{encoding: 'utf8'},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr.includes('WARN'), result.stderr).toBe(false);
			expect(JSON.parse(result.stdout).profile_init_cmd).toBe('new');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'a config without merge keys resolves on a yq older than 4.47',
	() => {
		const {configPath, localConfigPath, homeConfigPath, cleanup} =
			setupConfigFiles(
				`version: 1
# A heredoc (<<) in a command is not a merge key
profiles:
  dev: {display_name: Dev, claude: {initialization_command: /old}}
agent_profiles:
  opus: {command: claude, env: {A: '1'}}
post_workspace_init:
  - run: 'cat <<EOF > .env'
`,
				"agent_profile: opus\npost_workspace_init:\n  - run: 'cat <<EOF > .env'\n",
				'version: 1\ninitialization_command: idow\n',
			);
		const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'old-yq-'));
		const realYq = execSync('command -v yq', {encoding: 'utf8'}).trim();
		fs.writeFileSync(
			path.join(stubs, 'yq'),
			`#!/bin/bash\nfor a in "$@"; do [[ "$a" == --yaml-fix-merge-anchor-to-spec ]] && { echo "Error: unknown flag: $a" >&2; exit 1; }; done\nexec ${realYq} "$@"\n`,
			{mode: 0o755},
		);
		try {
			const result = spawnSync(
				'bash',
				[
					SCRIPT_PATH,
					'--config',
					configPath,
					'--local-config',
					localConfigPath,
					'--home-config',
					homeConfigPath,
					'--profile',
					'dev',
				],
				{
					encoding: 'utf8',
					env: {...process.env, PATH: `${stubs}:${process.env['PATH']!}`},
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(JSON.parse(result.stdout).agent_env)).toStrictEqual({
				A: '1',
			});
		} finally {
			cleanup();
			fs.rmSync(stubs, {recursive: true, force: true});
		}
	},
);

// YAML aliases are copies, so a claude map shared through an anchor is
// deprecated wherever it is used.
test('a claude map that is an alias resolves and warns', () => {
	const {configPath, cleanup} = setupConfigFiles(`version: 1
team_prefix: BASE
default_profile: main
issue_tracker: {provider: beads}
x: &c {model: opus}
claude: *c
profiles:
  main: {display_name: M, claude: *c}
`);
	try {
		const result = spawnSync(
			'bash',
			[SCRIPT_PATH, '--config', configPath, '--profile', 'main'],
			{encoding: 'utf8'},
		);
		expect(result.status, `stderr: ${result.stderr}`).toBe(0);
		const resolved = JSON.parse(result.stdout) as Record<string, string>;
		expect(resolved['deprecation_warnings']!).toMatch(
			/: claude\.model is deprecated/,
		);
		expect(resolved['profile_deprecation_warnings']!).toMatch(
			/: profiles\.main\.claude\.model is deprecated/,
		);
	} finally {
		cleanup();
	}
});

// macOS ships jq 1.7, which rejects a bare `if` as an object value
// (`key: if ... end`). jq 1.8 accepts it, so a newer jq on the dev machine or in
// CI hides the break, and every workspace fails to start on a stock Mac.
test('jq object values in the scripts never start with a bare if', () => {
	const scriptsDir = path.dirname(SCRIPT_PATH);
	const offenders: string[] = [];
	for (const name of fs.readdirSync(scriptsDir)) {
		const file = path.join(scriptsDir, name);
		if (!fs.statSync(file).isFile()) continue;
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		for (const [i, line] of lines.entries()) {
			if (/^\s*[A-Za-z_]\w*:\s+if\s/.test(line)) {
				offenders.push(`${name}:${i + 1}: ${line.trim()}`);
			}
		}
	}
	expect(offenders).toStrictEqual([]);
});
