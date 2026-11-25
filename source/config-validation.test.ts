import test from 'ava';
import {ConfigValidationError} from './config-errors.ts';
import {
	DEFAULT_KEYBINDING_KEYS,
	NON_OVERRIDABLE_KEYS,
	RESERVED_KEYS,
	RESERVED_VAR_NAMES,
	validateConfig,
} from './config-validation.ts';
import {
	CODE_IDE_COMMAND,
	validateListView,
} from '../test/helpers/config-fixtures.ts';

// ============================================================================
// Profile emoji + default_emoji Tests
// ============================================================================

test('validateConfig accepts issue_tracker.provider beads without base_url', t => {
	// Beads is local — there is no host to configure.
	const raw = {
		version: 1,
		default_profile: 'test',
		issue_tracker: {provider: 'beads'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig names every supported tracker when one is unknown', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		issue_tracker: {provider: 'bugzilla'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('"linear", "jira", or "beads"'));
});

test('validateConfig rejects non-string default_emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: 123,
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('default_emoji'));
});

test('validateConfig accepts empty-string default_emoji (blank slot)', t => {
	// Empty string means "reserve the emoji slot but render nothing in it",
	// keeping rows aligned when some profiles have an emoji and others don't.
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts valid default_emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍝',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-string profile emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: 42},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.emoji'));
});

test('validateConfig accepts empty-string profile emoji (blank slot)', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: ''},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts valid profile emoji', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: '🚀'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// Profile team_prefix Validation Tests
// ============================================================================

test('validateConfig rejects non-string profile team_prefix', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				team_prefix: 123, // Invalid: should be a string
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.test.team_prefix: must be a string'),
	);
});

test('validateConfig accepts valid string profile team_prefix', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				team_prefix: 'OTH',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// Profile vars Validation Tests
// ============================================================================

test('validateConfig rejects non-string vars value', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {IOS_APP_DIR: 123},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.test.vars.IOS_APP_DIR: must be a string'),
	);
});

test('validateConfig accepts valid string vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {IOS_APP_DIR: '_ios/MyApp', SCHEME: 'MyApp'},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts profile without vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-object vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: 'not an object',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.vars: must be an object'));
});

test('validateConfig rejects null vars', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: null,
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.vars: must be an object'));
});

test('validateConfig accepts empty vars object', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig reports multiple invalid vars values', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {FOO: 123, BAR: true, VALID: 'ok'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.FOO: must be a string'));
	t.truthy(error?.message.includes('vars.BAR: must be a string'));
	// VALID should not appear in error
	t.falsy(error?.message.includes('vars.VALID'));
});

test('validateConfig rejects reserved var name PATH', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {PATH: '/usr/bin'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.PATH: reserved name'));
});

test('validateConfig rejects reserved var name HOME', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {HOME: '/tmp'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.HOME: reserved name'));
});

test('validateConfig rejects reserved built-in template var ISSUE_KEY', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {ISSUE_KEY: 'STA-123'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.ISSUE_KEY: reserved name'));
});

test('validateConfig rejects reserved built-in template var WORKTREE_PATH', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {WORKTREE_PATH: '/tmp/wt'},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('vars.WORKTREE_PATH: reserved name'));
});

test('validateConfig allows non-reserved var names', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
				vars: {
					IOS_APP_DIR: '_ios/MyApp',
					BUNDLE_ID: 'com.example.app',
					SCHEME: 'MyApp',
					MY_CUSTOM_VAR: 'hello',
				},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('RESERVED_VAR_NAMES includes critical shell variables', t => {
	for (const name of ['PATH', 'HOME', 'IFS', 'SHELL', 'USER', 'PWD', 'TERM']) {
		t.true(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`);
	}
});

test('RESERVED_VAR_NAMES includes built-in template variables', t => {
	for (const name of [
		'ISSUE_KEY',
		'WORKTREE_PATH',
		'REPO_ROOT',
		'REPO_NAME',
		'SCRIPT_DIR',
		'PR_URL',
		'VCS_LABEL',
	]) {
		t.true(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`);
	}
});

// ============================================================================
// getDangerouslySkipPermissions Tests
// ============================================================================

test('validateConfig rejects non-boolean dangerously_skip_permissions', t => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: 'yes'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(rawConfig), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('dangerously_skip_permissions: must be a boolean'),
	);
});

test('validateConfig accepts boolean dangerously_skip_permissions', t => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: true},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(rawConfig));
});

// ============================================================================
// Keybinding Tests
// ============================================================================

test('validateConfig accepts valid keybindings', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 't', name: 'Test', run: 'make test'},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects keybinding with multi-character key', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'bb', name: 'Build', run: 'make build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('must be a single character'));
});

test('validateConfig rejects keybinding with non-overridable reserved key', t => {
	for (const reservedKey of NON_OVERRIDABLE_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key: reservedKey, name: 'Conflict', run: 'echo conflict'}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		const error = t.throws(() => validateConfig(raw), {
			instanceOf: ConfigValidationError,
		});
		t.truthy(error?.message.includes('conflicts with built-in shortcut'));
	}
});

test('validateConfig accepts keybinding that overrides a default key', t => {
	for (const defaultKey of DEFAULT_KEYBINDING_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [
				{
					key: defaultKey,
					name: `Custom ${defaultKey}`,
					run: `echo ${defaultKey}`,
				},
			],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(
			() => validateConfig(raw),
			`"${defaultKey}" should be overridable`,
		);
	}
});

test('validateConfig accepts disabled keybinding for a default key', t => {
	for (const defaultKey of DEFAULT_KEYBINDING_KEYS) {
		const raw = {
			version: 1,
			profiles: {
				test: {display_name: 'Test'},
			},
			keybindings: [{key: defaultKey, disabled: true}],
		};
		t.notThrows(
			() => validateConfig(raw),
			`"${defaultKey}" should be disableable`,
		);
	}
});

test('K is an overridable default key, not a non-overridable one (STA-2111)', t => {
	// The `K` shortcut closes every done/canceled space. It behaves like the
	// other built-in defaults: a user `keybindings:` entry for `K` replaces it.
	t.true(DEFAULT_KEYBINDING_KEYS.has('K'));
	t.false(NON_OVERRIDABLE_KEYS.has('K'));
});

test('RESERVED_KEYS is the union of NON_OVERRIDABLE_KEYS and DEFAULT_KEYBINDING_KEYS', t => {
	const union = new Set([...NON_OVERRIDABLE_KEYS, ...DEFAULT_KEYBINDING_KEYS]);
	t.deepEqual(RESERVED_KEYS, union);
	// No overlap between the two sets
	for (const key of NON_OVERRIDABLE_KEYS) {
		t.false(
			DEFAULT_KEYBINDING_KEYS.has(key),
			`"${key}" should not be in both sets`,
		);
	}
});

test('validateConfig rejects duplicate keybinding keys', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 'b', name: 'Build again', run: 'make build2'},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('already bound'));
});

test('validateConfig rejects keybinding missing name', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'b', run: 'make build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('name: required string field'));
});

test('validateConfig rejects keybinding with no action', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [{key: 'b', name: 'Build'}],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			"must have exactly one of 'run', 'send_to_claude' or 'send_skill'",
		),
	);
});

test('validateConfig rejects a keybinding that both sends text and a skill', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'a', name: 'Both', send_to_claude: '/a', send_skill: 'a'},
		],
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('must have exactly one of'));
});

test('validateConfig accepts send_to_claude keybinding without run', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{
				key: 'a',
				name: 'Address PR feedback',
				send_to_claude: '/address-pr-feedback',
			},
		],
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts uppercase versions of non-overridable keys', t => {
	// Uppercase letters like 'J', 'K', 'N' should be valid even though
	// their lowercase counterparts are non-overridable built-in shortcuts
	const uppercaseReserved = [...NON_OVERRIDABLE_KEYS]
		.filter(k => k !== '?') // '?' has no uppercase
		.map(k => k.toUpperCase());

	for (const key of uppercaseReserved) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, name: `Command ${key}`, run: `echo ${key}`}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(() => validateConfig(raw), `"${key}" should be allowed`);
	}
});

test('validateConfig accepts uppercase versions of default keybinding keys', t => {
	// Uppercase of overridable keys (G, I, D, O, E, P) should be valid custom bindings
	const uppercaseDefaultKeys = [...DEFAULT_KEYBINDING_KEYS].map(k =>
		k.toUpperCase(),
	);

	for (const key of uppercaseDefaultKeys) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, name: `Command ${key}`, run: `echo ${key}`}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.notThrows(() => validateConfig(raw), `"${key}" should be allowed`);
	}
});

test('validateConfig rejects disabled keybinding for a non-overridable key', t => {
	// disabled: true should not bypass the non-overridable key restriction
	for (const key of NON_OVERRIDABLE_KEYS) {
		const raw = {
			version: 1,
			default_profile: 'test',
			keybindings: [{key, disabled: true}],
			profiles: {
				test: {
					keywords: ['test'],
					display_name: 'Test',
				},
			},
		};
		t.throws(
			() => validateConfig(raw),
			undefined,
			`"${key}" should not be disableable`,
		);
	}
});

test('validateConfig rejects non-array keybindings', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: 'not an array',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('keybindings: must be an array'));
});

// ============================================================================
// Optional default_profile Tests
// ============================================================================

test('validateConfig accepts config without default_profile (uses first profile)', t => {
	const raw = {
		version: 1,
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
	// After validation, default_profile should be set to first profile key
	t.is((raw as Record<string, unknown>)['default_profile'], 'my-app');
});

test('validateConfig rejects empty string default_profile', t => {
	const raw = {
		version: 1,
		default_profile: '',
		profiles: {
			test: {
				keywords: ['test'],
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('default_profile'));
});

// ============================================================================
// Optional keywords Tests
// ============================================================================

test('validateConfig accepts profile without keywords', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				display_name: 'Test',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-array keywords', t => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				keywords: 'not-an-array',
				display_name: 'Test',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('keywords: must be an array'));
});

test('minimal config with just team_prefix and one profile validates', t => {
	const raw = {
		version: 1,
		team_prefix: 'PROJ',
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// Validation: disabled keybindings
// ============================================================================

test('validation accepts disabled keybinding without name/run/send_to_claude', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'r', disabled: true}],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validation still rejects disabled keybinding with reserved key', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'j', disabled: true}],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('"j" conflicts with built-in')));
});

test('validation still rejects disabled keybinding with invalid key', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'ab', disabled: true}],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('must be a single character')));
});

// ============================================================================
// Per-profile claude and post_worktree_init validation
// ============================================================================

test('validateConfig accepts profile with valid claude.initialization_command', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: '/do'},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-string claude.initialization_command', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: 42},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('claude.initialization_command: must be a string'),
		),
	);
});

test('validateConfig rejects profile with non-object claude section', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: 'not-an-object',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(error!.errors.some(e => e.includes('claude: must be an object')));
});

test('validateConfig accepts profile with valid post_worktree_init array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: [
					{name: 'Copy files', run: 'cp a b'},
					{run: 'echo done'},
				],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-array post_worktree_init', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: 'not-an-array',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e => e.includes('post_worktree_init: must be an array')),
	);
});

test('validateConfig rejects profile post_worktree_init entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: [{name: 'Missing run field'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('post_worktree_init[0].run: required string field'),
		),
	);
});

// ============================================================================
// post_workspace_init (rename of post_worktree_init) and backwards compat
// ============================================================================

test('validateConfig accepts global post_workspace_init as replacement for post_worktree_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			// eslint-disable-next-line no-template-curly-in-string
			{name: 'Copy env', run: 'cp .env ${WORKTREE_PATH}/.env'},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts post_worktree_init for backwards compat (global)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_worktree_init: [{name: 'Copy env', run: 'cp .env .env.bak'}],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at global level', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [{name: 'A', run: 'echo a'}],
		post_worktree_init: [{name: 'B', run: 'echo b'}],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	);
});

test('validateConfig accepts profile-level post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_workspace_init: [{name: 'Setup', run: 'echo setup'}],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at profile level', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_workspace_init: [{name: 'A', run: 'echo a'}],
				post_worktree_init: [{name: 'B', run: 'echo b'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	);
});

// ============================================================================
// pre_workspace_deinit validation
// ============================================================================

test('validateConfig accepts global pre_workspace_deinit array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{
				name: 'Close issue',
				// eslint-disable-next-line no-template-curly-in-string
				run: 'linctl issue update ${ISSUE_KEY} --state Done',
			},
			{run: 'echo cleanup'},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects global non-array pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: 'not-an-array',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	);
});

test('validateConfig rejects global pre_workspace_deinit entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [{name: 'No run'}],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	);
});

test('validateConfig accepts profile-level pre_workspace_deinit array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Cleanup', run: 'rm -rf tmp/'}],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile non-array pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: 42,
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	);
});

test('validateConfig rejects profile pre_workspace_deinit entry missing run', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Missing run'}],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	);
});

// ============================================================================
// continue_on_error validation
// ============================================================================

test('validateConfig accepts continue_on_error in post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: true},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts continue_on_error in pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: true},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts continue_on_error: false in pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: false},
		],
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-boolean continue_on_error in global post_workspace_init', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: 'yes'},
		],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('post_workspace_init[0].continue_on_error: must be a boolean'),
		),
	);
});

test('validateConfig rejects non-boolean continue_on_error in global pre_workspace_deinit', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm tmp/', continue_on_error: 1},
		],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes(
				'pre_workspace_deinit[0].continue_on_error: must be a boolean',
			),
		),
	);
});

test('validateConfig rejects non-boolean continue_on_error in profile commands', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				commands: [
					{name: 'Build', run: 'make build', continue_on_error: 'always'},
				],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('commands[0].continue_on_error: must be a boolean'),
		),
	);
});

test('validation detects duplicate keys even if one is disabled', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [
			{key: 'b', name: 'Build', run: 'make build'},
			{key: 'b', disabled: true},
		],
	};
	const err = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(err!.errors.some(e => e.includes('"b" is already bound')));
});

// ============================================================================
// issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts valid issue_watchlist with assignee and statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 'In Progress'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist with explicit assignee', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'charlie@example.com',
			statuses: ['In Review'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist that is not an object', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: 'not-an-object',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('issue_watchlist: must be an object'));
});

test('validateConfig accepts issue_watchlist without assignee (optional)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-string assignee', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 42,
			statuses: ['To Do'],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.assignee: must be a string'),
	);
});

test('validateConfig rejects issue_watchlist without statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with non-array statuses', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: 'To Do',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with empty statuses array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: [],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects issue_watchlist with non-string statuses entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.statuses[1]: must be a string'),
	);
});

test('validateConfig accepts config without issue_watchlist', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// Per-profile issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts a profile-level issue_watchlist', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'Charlie Personal',
				team_prefix: 'CHAZ',
				issue_watchlist: {assignee: 'me', statuses: ['For Pappardelle']},
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a profile issue_watchlist that is not an object', t => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: 'nope'}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('profiles.chaz.issue_watchlist: must be an object'),
	);
});

test('validateConfig rejects a profile issue_watchlist without statuses', t => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: {assignee: 'me'}}},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.statuses: required non-empty array',
		),
	);
});

test('validateConfig rejects a profile issue_watchlist with non-string assignee', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {assignee: 5, statuses: ['To Do']},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.assignee: must be a string',
		),
	);
});

test('validateConfig rejects a profile issue_watchlist with an empty key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {statuses: ['To Do'], key_prefixes: ['STA', '']},
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.key_prefixes[1]: must not be empty',
		),
	);
});

// ============================================================================
// issue_watchlist labels Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with labels', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['pappardelle', 'platform'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist without labels (optional)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-array labels', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: 'not-an-array',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('issue_watchlist.labels: must be an array'));
});

test('validateConfig rejects issue_watchlist with non-string label entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['valid', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.labels[1]: must be a string'),
	);
});

test('validateConfig accepts issue_watchlist with empty labels array', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: [],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// issue_watchlist key_prefixes Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with key_prefixes', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 'ENG'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist without key_prefixes (optional)', t => {
	// Off-by-default regression: the field is optional and absence is valid.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts issue_watchlist with empty key_prefixes array', t => {
	// Empty array means "watch every prefix" — same as omitting the field.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: [],
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects issue_watchlist with non-array key_prefixes', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: 'not-an-array',
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('issue_watchlist.key_prefixes: must be an array'),
	);
});

test('validateConfig rejects issue_watchlist with non-string key_prefix entries', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 123],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must be a string',
		),
	);
});

test('validateConfig rejects issue_watchlist with empty-string key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', ''],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must not be empty',
		),
	);
});

test('validateConfig rejects issue_watchlist with whitespace-only key_prefix', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['   '],
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'issue_watchlist.key_prefixes[0]: must not be empty',
		),
	);
});

test('validateConfig rejects sous_chef without workspace_aware_agents', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		sous_chef: true,
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('sous_chef: needs workspace_aware_agents'));
	t.notThrows(() => validateConfig({...raw, workspace_aware_agents: true}));
});

test('validateConfig rejects sous_chef with a non-boolean value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		sous_chef: 'on',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('sous_chef: must be a boolean'));
});

// ============================================================================
// auto_remove_when_done Validation Tests
// ============================================================================

test('validateConfig accepts auto_remove_when_done set to true', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: true,
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts auto_remove_when_done set to false', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: false,
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts config without auto_remove_when_done (off by default)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects auto_remove_when_done with a non-boolean value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 'yes',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('auto_remove_when_done: must be a boolean'));
});

test('validateConfig rejects auto_remove_when_done with a numeric value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 1,
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('auto_remove_when_done: must be a boolean'));
});

// ============================================================================
// companion_command Validation Tests
// ============================================================================

test('validateConfig accepts top-level companion_command string', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 'gitui',
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts an empty-string companion_command (plain shell)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: '',
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts config without companion_command (default applies)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-string companion_command', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 42,
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('companion_command: must be a string'));
});

test('validateConfig accepts a per-profile companion_command string', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: 'make run'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a non-string per-profile companion_command', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: ['make', 'run']},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'profiles.backend.companion_command: must be a string',
		),
	);
});

// ============================================================================
// getCompanionCommand Tests
// ============================================================================

test('validateConfig checks each companion split', t => {
	const validate =
		(splits: unknown, inProfile = false) =>
		() => {
			validateConfig({
				version: 1,
				profiles: {
					test: {
						display_name: 'Test',
						...(inProfile ? {companion_splits: splits} : {}),
					},
				},
				...(inProfile ? {} : {companion_splits: splits}),
			});
		};

	t.notThrows(
		validate([
			{name: 'tests', command: 'bun test', split: 'down', size: '30%'},
			{name: 'logs-2', command: 'tail -f log', size: 12},
		]),
	);
	for (const [splits, message] of [
		[{name: 'x'}, 'companion_splits: must be a list'],
		[[{name: 'Tests', command: 'x'}], 'companion_splits[0].name'],
		[[{name: 'main', command: 'x'}], 'not main'],
		[[{name: 'a~b', command: 'x'}], 'companion_splits[0].name'],
		[
			[
				{name: 'a', command: 'x'},
				{name: 'a', command: 'y'},
			],
			'a is listed twice',
		],
		[[{name: 'a'}], 'companion_splits[0].command'],
		[[{name: 'a', command: 'x', split: 'left'}], 'right or down'],
		[[{name: 'a', command: 'x', size: '30'}], 'companion_splits[0].size'],
	] as const) {
		const error = t.throws(validate(splits), {
			instanceOf: ConfigValidationError,
		});
		t.true(String(error?.message).includes(message));
	}

	const error = t.throws(validate([{name: 'A', command: 'x'}], true), {
		instanceOf: ConfigValidationError,
	});
	t.true(error?.message.includes('profiles.test.companion_splits[0].name'));
});

// ============================================================================
// ide_command Validation Tests
// ============================================================================

test('validateConfig accepts top-level ide_command string', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: CODE_IDE_COMMAND,
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts an empty-string ide_command (d disabled)', t => {
	// Rejecting this would be a trap: an invalid key throws from loadConfig, and
	// the TUI swallows that by running with no config at all.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: '',
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects non-string ide_command', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: 42,
	};
	const error = t.throws(() => validateConfig(raw));
	t.truthy(error?.message.includes('ide_command: must be a string'));
});

test('validateConfig accepts a per-profile ide_command string', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', ide_command: 'nvim-qt'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a non-string per-profile ide_command', t => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', ide_command: ['code', '.']},
		},
	};
	const error = t.throws(() => validateConfig(raw));
	t.truthy(
		error?.message.includes('profiles.backend.ide_command: must be a string'),
	);
});

// ============================================================================
// tracker_projects Validation Tests
// ============================================================================

test('validateConfig accepts profile with valid tracker_projects array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 'The Hive Quality'],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts profile without tracker_projects (optional)', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects profile with non-array tracker_projects', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: 'The Hive',
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('tracker_projects: must be an array when specified'),
		),
	);
});

test('validateConfig rejects profile with non-string tracker_projects entries', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 42],
			},
		},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.true(
		error!.errors.some(e =>
			e.includes('tracker_projects[1]: must be a string'),
		),
	);
});

test('validateConfig accepts profile with empty tracker_projects array', t => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: [],
			},
		},
	};
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// state_colors Validation Tests
// ============================================================================

test('validateConfig accepts config without state_colors (off by default)', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts an empty state_colors map', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig accepts hex and ANSI color names in state_colors', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {
			'In Progress': '#f2c94c',
			'In Review': 'cyan',
			Done: '#abc',
			Blocked: 'redBright',
		},
	};
	t.notThrows(() => validateConfig(raw));
});

test('validateConfig rejects a non-object state_colors', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: 'cyan',
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('state_colors: must be an object'));
});

test('validateConfig rejects an array state_colors', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: ['cyan'],
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('state_colors: must be an object'));
});

test('validateConfig rejects an unknown color name', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: 'chartreuse'},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'state_colors."Done": must be a hex color (#rgb or #rrggbb) or an ANSI color name',
		),
	);
});

test('validateConfig rejects malformed hex', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: '#12345'},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('state_colors."Done"'));
});

test('validateConfig rejects a non-string color value', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: 123},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('state_colors."Done"'));
});

test('validateConfig rejects an empty state name', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {'   ': 'cyan'},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes('state_colors: state names must not be empty'),
	);
});

test('validateConfig rejects state names that differ only in case', t => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {'In Progress': 'cyan', 'in progress': 'red'},
	};
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(
		error?.message.includes(
			'state_colors: duplicate state name "in progress" (names are matched case-insensitively)',
		),
	);
});

// ============================================================================
// getStateColors Tests
// ============================================================================

test('validateConfig accepts both list_view layouts', t => {
	for (const layout of ['single_line', 'two_line']) {
		t.notThrows(() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: {layout},
			}),
		);
	}
});

test('validateConfig rejects an unknown list_view layout', t => {
	const error = t.throws(
		() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: {layout: 'three_line'},
			}),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(
		error?.message.includes(
			'list_view.layout: must be "single_line" or "two_line"',
		),
	);
});

test('validateConfig rejects a non-object list_view', t => {
	const error = t.throws(
		() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: 'two_line',
			}),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('list_view: must be an object'));
});

// layout — starting pane widths for the 3-column layout.

const validateLayout = (layout: unknown) => () => {
	validateConfig({
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		layout,
	});
};

test('validateConfig accepts column and percent pane widths', t => {
	t.notThrows(
		validateLayout({
			rail_width: 30,
			claude_width: '45%',
			companion_width: '12.5%',
		}),
	);
	t.notThrows(validateLayout({companion_width: '100%'}));
	t.notThrows(validateLayout({}));
});

test('validateConfig rejects pane widths that are not columns or percentages', t => {
	for (const value of [0, -5, 12.5, '30', '0%', '101%', 'wide', true]) {
		const error = t.throws(validateLayout({rail_width: value}), {
			instanceOf: ConfigValidationError,
		});
		t.truthy(
			error?.message.includes(
				'layout.rail_width: must be a positive whole number',
			),
			`value ${String(value)}`,
		);
	}
});

test('validateConfig rejects a non-object layout', t => {
	const error = t.throws(validateLayout('10/45/45'), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('layout: must be an object'));
});

// ============================================================================
// issue_watchlist max_workspaces Validation Tests (STE-25)
// ============================================================================

test('validateConfig accepts max_workspaces on top-level and profile watchlists', t => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {statuses: ['For Pappardelle'], max_workspaces: 1},
			},
		},
		issue_watchlist: {statuses: ['To Do'], max_workspaces: 5},
	};
	t.notThrows(() => validateConfig(raw));
});

for (const bad of [0, -1, 1.5, '5']) {
	test(`validateConfig rejects max_workspaces: ${JSON.stringify(bad)}`, t => {
		const raw = {
			version: 1,
			profiles: {
				chaz: {
					display_name: 'X',
					issue_watchlist: {statuses: ['To Do'], max_workspaces: bad},
				},
			},
			issue_watchlist: {statuses: ['To Do'], max_workspaces: bad},
		};
		const error = t.throws(() => validateConfig(raw), {
			instanceOf: ConfigValidationError,
		});
		t.truthy(
			error?.message.includes(
				'issue_watchlist.max_workspaces: must be an integer >= 1',
			),
		);
		t.truthy(
			error?.message.includes(
				'profiles.chaz.issue_watchlist.max_workspaces: must be an integer >= 1',
			),
		);
	});
}

// ============================================================================
// Agent profiles — validation
// ============================================================================

function agentProfilesConfig(
	extra: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 1,
		default_profile: 'test',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
		...extra,
	};
}

test('validateConfig rejects non-object agent_profiles', t => {
	const error = t.throws(
		() => validateConfig(agentProfilesConfig({agent_profiles: ['x']})),
		{
			instanceOf: ConfigValidationError,
		},
	);
	t.truthy(error?.message.includes('agent_profiles: must be an object'));
});

test('validateConfig rejects an agent_profiles entry without command', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({agent_profiles: {codex: {args: '--yolo'}}}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('agent_profiles.codex.command'));
});

test('validateConfig rejects an empty agent profile command', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({agent_profiles: {codex: {command: '  '}}}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('agent_profiles.codex.command'));
});

test('validateConfig rejects non-string agent profile args and resume_args', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						codex: {command: 'codex', args: 1, resume_args: true},
					},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('agent_profiles.codex.args'));
	t.truthy(error?.message.includes('agent_profiles.codex.resume_args'));
});

test('validateConfig rejects agent profile fields spanning lines', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						codex: {command: 'codex', args: '--yolo\n--search\n'},
					},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(
		error?.message.includes('agent_profiles.codex.args: must be a single line'),
	);
});

test('validateConfig rejects agent profile env that is not a map of strings', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						list: {command: 'claude', env: ['FOO=1']},
						typed: {
							command: 'claude',
							env: {
								'1BAD': 'x',
								'A-B': 'x',
								PAPPARDELLE_SPACE: 'x',
								NUMBER: 1,
							},
						},
					},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	const message = error?.message ?? '';
	t.true(message.includes('agent_profiles.list.env: must be a map'));
	t.true(
		message.includes(
			'agent_profiles.typed.env.1BAD: must be an environment variable name',
		),
	);
	t.true(
		message.includes(
			'agent_profiles.typed.env.A-B: must be an environment variable name',
		),
	);
	t.true(
		message.includes(
			'agent_profiles.typed.env.PAPPARDELLE_SPACE: PAPPARDELLE_ variables are set by pappardelle',
		),
	);
	t.true(message.includes('agent_profiles.typed.env.NUMBER: must be a string'));
});

test('validateConfig accepts agent profile env of strings', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {
					opus: {command: 'claude', env: {CODE_MODE: '1', _X2: ''}},
				},
			}),
		),
	);
});

test('validateConfig accepts the trailing newline of a YAML block scalar', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {codex: {command: 'codex', args: '--yolo\n'}},
			}),
		),
	);
});

test('validateConfig rejects non-boolean is_claude', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {w: {command: 'w', is_claude: 'yes'}},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('agent_profiles.w.is_claude'));
});

test('validateConfig rejects model or effort on a CLI with no flag template', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {aider: {command: 'aider', model: 'x', effort: 'y'}},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('agent_profiles.aider.model'));
	t.truthy(error?.message.includes('set model_args'));
	t.truthy(error?.message.includes('agent_profiles.aider.effort'));
});

test('validateConfig accepts model and effort on claude, codex, or with a template', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {
					opus: {command: 'claude', model: 'opus', effort: 'max'},
					wrapped: {command: 'claude-local', is_claude: true, model: 'opus'},
					codex: {command: '/opt/bin/codex', model: 'gpt-5.5', effort: 'high'},
					aider: {
						command: 'aider',
						model: 'x',
						model_args: '--model={model}',
					},
				},
			}),
		),
	);
});

for (const promptArgs of ['-i', '', '-i {prompt} {prompt}']) {
	test(`validateConfig rejects prompt_args ${JSON.stringify(promptArgs)}`, t => {
		const error = t.throws(
			() =>
				validateConfig(
					agentProfilesConfig({
						agent_profiles: {agy: {command: 'agy', prompt_args: promptArgs}},
					}),
				),
			{instanceOf: ConfigValidationError},
		);
		t.truthy(
			error?.message.includes(
				'agent_profiles.agy.prompt_args: must contain {prompt} exactly once',
			),
		);
	});
}

test('validateConfig accepts prompt_args with one {prompt}', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {agy: {command: 'agy', prompt_args: '-i {prompt}'}},
			}),
		),
	);
});

test('validateConfig accepts a minimal agy profile with a model', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {agy: {command: 'agy', model: 'gemini-4-argon-medium'}},
			}),
		),
	);
});

test('validateConfig rejects a flag template without its placeholder', t => {
	const error = t.throws(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						codex: {
							command: 'codex',
							model_args: '-m',
							effort_args: '-c model_reasoning_effort=high',
						},
					},
				}),
			),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(
		error?.message.includes(
			'agent_profiles.codex.model_args: must contain {model}',
		),
	);
	t.truthy(
		error?.message.includes(
			'agent_profiles.codex.effort_args: must contain {effort}',
		),
	);
});

test('validateConfig rejects a top-level agent_profile reference to an unknown name', t => {
	const error = t.throws(
		() => validateConfig(agentProfilesConfig({agent_profile: 'codex'})),
		{
			instanceOf: ConfigValidationError,
		},
	);
	t.truthy(error?.message.includes('agent profile "codex" not found'));
});

test('validateConfig accepts agent_profile "claude" without an agent_profiles entry', t => {
	t.notThrows(() =>
		validateConfig(agentProfilesConfig({agent_profile: 'claude'})),
	);
});

test('validateConfig accepts a top-level agent_profile reference to a defined agent profile', t => {
	t.notThrows(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {codex: {command: 'codex'}},
				agent_profile: 'codex',
			}),
		),
	);
});

test('validateConfig rejects a profile agent_profile reference to an unknown name', t => {
	const raw = agentProfilesConfig({});
	(raw['profiles'] as Record<string, Record<string, unknown>>)['test']![
		'agent_profile'
	] = 'codex';
	const error = t.throws(() => validateConfig(raw), {
		instanceOf: ConfigValidationError,
	});
	t.truthy(error?.message.includes('profiles.test.agent_profile'));
});

test('validateConfig accepts an empty-string profile agent_profile (clears inherited)', t => {
	const raw = agentProfilesConfig({});
	(raw['profiles'] as Record<string, Record<string, unknown>>)['test']![
		'agent_profile'
	] = '';
	t.notThrows(() => validateConfig(raw));
});

// ============================================================================
// initialization_command — rename + deprecated fallback
// ============================================================================

test('validateConfig rejects non-string initialization_command', t => {
	const error = t.throws(
		() => validateConfig(agentProfilesConfig({initialization_command: 5})),
		{instanceOf: ConfigValidationError},
	);
	t.truthy(error?.message.includes('initialization_command: must be a string'));
});

// ============================================================================
// list_view.group_by / list_view.groups
// ============================================================================

test('validateConfig accepts custom groups by status and category', t => {
	t.is(
		validateListView({
			group_by: 'status',
			groups: [
				{name: 'Doing', color: 'blue', categories: ['todo', 'in_progress']},
				{name: 'QA', color: '#a78bfa', statuses: ['In Review', 'QA']},
				{name: 'Done', color: 'green', categories: ['done']},
			],
		}),
		'',
	);
});

test('validateConfig rejects groups that the rail could not place', t => {
	const message = validateListView({
		groups: [
			{name: 'Doing', color: 'blue', categories: ['todo']},
			{name: 'Review', color: 'chartreuse', statuses: ['In Review']},
			{name: 'review', color: 'blue', statuses: ['in review']},
			{name: 'Empty', color: 'blue'},
			{name: 'Odd', color: 'blue', categories: ['started']},
		],
	});
	t.true(message.includes('list_view.groups[1].color:'));
	t.true(
		message.includes('list_view.groups[2].name: duplicate group "review"'),
	);
	t.true(
		message.includes(
			'list_view.groups[2].statuses: "in review" is already in list_view.groups[1]',
		),
	);
	t.true(
		message.includes('list_view.groups[3]: needs statuses, categories or both'),
	);
	t.true(message.includes('list_view.groups[4].categories:'));
	t.true(validateListView({groups: []}).includes('must be a non-empty list'));
	t.true(
		validateListView({
			groups: [{name: 'Nothing', color: 'blue', statuses: [], categories: []}],
		}).includes('list_view.groups[0]: needs statuses, categories or both'),
	);
});

// ============================================================================
// sous_chef_key
// ============================================================================

const withSousChefKey = (value: unknown) => ({
	version: 1,
	profiles: {test: {display_name: 'Test'}},
	sous_chef_key: value,
});

test('validateConfig accepts a sous_chef_key name or false', t => {
	t.notThrows(() => validateConfig(withSousChefKey('M-j')));
	t.notThrows(() => validateConfig(withSousChefKey(false)));
});

for (const value of ['', '  ', true, 3]) {
	test(`validateConfig rejects sous_chef_key ${JSON.stringify(value)}`, t => {
		const error = t.throws(() => validateConfig(withSousChefKey(value)), {
			instanceOf: ConfigValidationError,
		});
		t.true(
			error?.message.includes(
				'sous_chef_key: must be a tmux key name or false',
			),
		);
	});
}
