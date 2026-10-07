import test from 'ava';
import {execFileSync, execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	getAgentEffort,
	getAgentModel,
	getAgentProfile,
	loadConfigFromPaths,
	renderAgentLaunchFlags,
} from './config.ts';

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
	init_cmd_deprecated: string;
	skip_permissions: string;
	agent_command: string;
	agent_args: string;
	agent_resume_args: string;
	agent_is_claude: string;
	agent_launch_flags: string;
	model: string;
	effort: string;
	claude_launch_deprecated: string;
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
	t => {
		const fixture = setupConfigFiles('claude: [unterminated');
		t.teardown(fixture.cleanup);
		t.throws(() =>
			execFileSync('bash', [SCRIPT_PATH, '--config', fixture.configPath], {
				stdio: 'pipe',
			}),
		);
	},
);

maybeMacro(
	'values that JSON cannot hold in unrelated keys do not break resolution',
	t => {
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
		t.teardown(fixture.cleanup);
		const output = execFileSync(
			'bash',
			[SCRIPT_PATH, '--config', fixture.configPath, '--profile', 'app'],
			{encoding: 'utf-8', stdio: 'pipe'},
		);
		const result = JSON.parse(output) as {model: string; effort: string};
		t.is(result.model, 'opus');
		t.is(result.effort, 'high');
	},
);

// ============================================================================
// Base config only (no local override)
// ============================================================================

maybeMacro(
	'reads dangerously_skip_permissions from base config when no local config exists',
	t => {
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
			t.is(result.skip_permissions, 'true');
			t.is(result.init_cmd, '/idow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'returns defaults when base config has no claude section and no local config',
	t => {
		const {configPath, localConfigPath, cleanup} = setupConfigFiles(
			`version: 1
profiles:
  test:
    display_name: Test
`,
		);
		try {
			const result = runResolver(configPath, localConfigPath);
			t.is(result.skip_permissions, 'false');
			t.is(result.init_cmd, '');
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
	t => {
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
			t.is(result.skip_permissions, 'true');
			// initialization_command should be preserved from base
			t.is(result.init_cmd, '/idow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'local config overrides dangerously_skip_permissions from true to false',
	t => {
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
			t.is(result.skip_permissions, 'false');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'local config adds dangerously_skip_permissions when base has no claude section',
	t => {
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
			t.is(result.skip_permissions, 'true');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// Local override for initialization_command
// ============================================================================

maybeMacro('local config overrides initialization_command', t => {
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
		t.is(result.init_cmd, '/dow');
		// dangerously_skip_permissions should be preserved from base
		t.is(result.skip_permissions, 'true');
	} finally {
		cleanup();
	}
});

maybeMacro('local config adds initialization_command when base has none', t => {
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
		t.is(result.init_cmd, '/idow');
	} finally {
		cleanup();
	}
});

// ============================================================================
// Both overrides simultaneously
// ============================================================================

maybeMacro(
	'local config overrides both initialization_command and dangerously_skip_permissions',
	t => {
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
			t.is(result.init_cmd, '/dow');
			t.is(result.skip_permissions, 'true');
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
	t => {
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
			t.is(result.skip_permissions, 'true');
			t.is(result.init_cmd, '/idow');
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
	t => {
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
			t.is(result.skip_permissions, 'false');
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
	t => {
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
			t.is(result.skip_permissions, 'true');
			t.is(result.init_cmd, '/dow');
		} finally {
			cleanup();
		}
	},
);

maybeMacro('project config overrides home config', t => {
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
		t.is(result.skip_permissions, 'false');
		t.is(result.init_cmd, '/idow');
	} finally {
		cleanup();
	}
});

maybeMacro('local config overrides both home and project config', t => {
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
		t.is(result.skip_permissions, 'true');
		t.is(result.init_cmd, '/do-stardust');
	} finally {
		cleanup();
	}
});

maybeMacro('partial overrides at each layer merge correctly', t => {
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
		t.is(result.init_cmd, '/idow');
		t.is(result.skip_permissions, 'true');
	} finally {
		cleanup();
	}
});

maybeMacro('missing home config file is gracefully ignored', t => {
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
		t.is(result.skip_permissions, 'true');
	} finally {
		cleanup();
	}
});

// ============================================================================
// Agent profile resolution
// ============================================================================

maybeMacro('defaults to the built-in claude agent profile', t => {
	const {configPath, localConfigPath, cleanup} = setupConfigFiles(
		`version: 1
profiles:
  test:
    display_name: Test
`,
	);
	try {
		const result = runResolver(configPath, localConfigPath);
		t.is(result.agent_profile, 'claude');
		t.is(result.agent_command, 'claude');
		t.is(result.agent_args, '');
		t.is(result.agent_resume_args, '--resume {session_id}');
		t.is(result.agent_is_claude, 'true');
	} finally {
		cleanup();
	}
});

maybeMacro('resolves an agent profile referenced at the top level', t => {
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
		t.is(result.agent_command, 'codex');
		t.is(result.agent_args, '--yolo');
		t.is(result.agent_resume_args, 'resume --last');
		t.is(result.agent_is_claude, 'false');
	} finally {
		cleanup();
	}
});

maybeMacro('profile agent_profile reference wins over the top-level one', t => {
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
		t.is(withProfile.agent_command, 'codex');
		// Non-claude agent without resume_args: no resume attempt at all.
		t.is(withProfile.agent_resume_args, '');
		t.is(withProfile.agent_is_claude, 'false');

		const otherProfile = runResolver(
			configPath,
			localConfigPath,
			undefined,
			'plain',
		);
		t.is(otherProfile.agent_command, 'claude');
		t.is(otherProfile.agent_is_claude, 'true');
	} finally {
		cleanup();
	}
});

maybeMacro(
	'empty-string profile agent_profile clears an inherited reference',
	t => {
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
			t.is(result.agent_command, 'claude');
			t.is(result.agent_is_claude, 'true');
		} finally {
			cleanup();
		}
	},
);

maybeMacro('is_claude override forces claude treatment for a wrapper', t => {
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
		t.is(result.agent_command, 'claude-local');
		t.is(result.agent_is_claude, 'true');
		t.is(result.agent_resume_args, '--resume {session_id}');
	} finally {
		cleanup();
	}
});

maybeMacro('explicit is_claude false opts a claude-named command out', t => {
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
		t.is(result.agent_command, 'claude');
		t.is(result.agent_is_claude, 'false');
		// Not claude ⇒ no claude resume default either.
		t.is(result.agent_resume_args, '');
	} finally {
		cleanup();
	}
});

maybeMacro('claude predicate splits the first token on any whitespace', t => {
	// Matches isClaudeCommand()'s /\s+/ split in source/config.ts — a
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
		t.is(result.agent_is_claude, 'true');
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
	t => {
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
			t.true(
				stderr.includes('agent profile "codeex" not found in agent_profiles'),
				stderr,
			);
		} finally {
			cleanup();
		}
	},
);

maybeMacro('both init command spellings in one layer is an error', t => {
	const {configPath, homeConfigPath, cleanup} = setupConfigFiles(
		`version: 1
profiles:
  test:
    display_name: Test
`,
		undefined,
		`version: 1
profiles:
  test:
    initialization_command: /new
    claude:
      initialization_command: /old
`,
	);
	try {
		const stderr = runResolverExpectingError(configPath, [
			'--home-config',
			homeConfigPath,
		]);
		t.true(
			stderr.includes(
				`${homeConfigPath}: profiles.test.initialization_command and profiles.test.claude.initialization_command cannot both be specified`,
			),
			stderr,
		);
	} finally {
		cleanup();
	}
});

maybeMacro('agent profiles merge across config layers', t => {
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
		t.is(result.agent_command, 'codex');
		t.is(result.agent_resume_args, 'resume --last');
		t.is(result.agent_is_claude, 'false');
	} finally {
		cleanup();
	}
});

// ============================================================================
// initialization_command rename
// ============================================================================

maybeMacro('init_cmd prefers the new top-level initialization_command', t => {
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
		t.is(result.init_cmd, '/new');
		t.is(result.init_cmd_deprecated, 'false');
	} finally {
		cleanup();
	}
});

maybeMacro(
	'init_cmd: a project on the old spelling beats a migrated home config',
	t => {
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
			t.is(result.init_cmd, '/project');
			t.is(result.init_cmd_deprecated, 'true');
		} finally {
			cleanup();
		}
	},
);

maybeMacro(
	'init_cmd falls back to the deprecated claude spelling and flags it',
	t => {
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
			t.is(result.init_cmd, '/old');
			t.is(result.init_cmd_deprecated, 'true');
		} finally {
			cleanup();
		}
	},
);

// ============================================================================
// model / effort through agent profiles — bash must render what the TUI does
// ============================================================================

const LAUNCH_PARITY_CONFIG = `version: 1
claude:
  model: "claude-opus-5[1m]"
  effort: xhigh
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
`;

for (const [profile, expected] of [
	['default-claude', " --model 'claude-opus-5[1m]' --effort xhigh"],
	['claude-profile', ' --model sonnet --effort xhigh'],
	['codex', ' -m gpt-5.5 -c model_reasoning_effort=high'],
	['bare-codex', ''],
	['opus', ' --model opus --effort xhigh'],
	['aider', " --model='it'\\''s [1m]' --reasoning hard --effort=hard"],
] as const) {
	maybeMacro(
		`model/effort flags for the ${profile} profile match the TUI`,
		t => {
			const fixture = setupConfigFiles(LAUNCH_PARITY_CONFIG);
			t.teardown(fixture.cleanup);
			const config = loadConfigFromPaths({
				projectDir: path.dirname(fixture.configPath),
			});
			const tsFlags = renderAgentLaunchFlags(
				getAgentProfile(config, undefined, profile),
				{
					model: getAgentModel(config, undefined, profile),
					effort: getAgentEffort(config, undefined, profile),
				},
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
			t.is(tsFlags, expected);
			t.is(bashFlags, expected);
		},
	);
}

maybeMacro('model on a CLI with no flag template is an error', t => {
	const fixture = setupConfigFiles(`version: 1
agent_profiles:
  aider:
    command: aider
    model: x
profiles:
  aider:
    display_name: Aider
    agent_profile: aider
`);
	t.teardown(fixture.cleanup);
	const error = t.throws(() =>
		execFileSync(
			'bash',
			[SCRIPT_PATH, '--config', fixture.configPath, '--profile', 'aider'],
			{stdio: 'pipe'},
		),
	);
	t.regex(
		String((error as {stderr?: unknown}).stderr),
		/agent_profiles\.aider\.model: "aider" has no built-in model flag; set model_args/,
	);
});

maybeMacro('a flag template without its placeholder is an error', t => {
	const fixture = setupConfigFiles(`version: 1
agent_profiles:
  codex:
    command: codex
    model_args: -m
profiles:
  codex:
    display_name: Codex
    agent_profile: codex
`);
	t.teardown(fixture.cleanup);
	const error = t.throws(() =>
		execFileSync(
			'bash',
			[SCRIPT_PATH, '--config', fixture.configPath, '--profile', 'codex'],
			{stdio: 'pipe'},
		),
	);
	t.regex(
		String((error as {stderr?: unknown}).stderr),
		/agent_profiles\.codex\.model_args: must contain \{model\}/,
	);
});

maybeMacro('the deprecated claude.model and claude.effort are flagged', t => {
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
	t.teardown(fixture.cleanup);
	const result = runResolver(
		fixture.configPath,
		fixture.localConfigPath,
		fixture.homeConfigPath,
	);
	t.is(result.claude_launch_deprecated, 'claude.effort claude.model');
	const clean = setupConfigFiles(`version: 1
profiles:
  test:
    display_name: Test
`);
	t.teardown(clean.cleanup);
	t.is(
		runResolver(clean.configPath, clean.localConfigPath)
			.claude_launch_deprecated,
		'',
	);
});
