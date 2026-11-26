import {test, expect} from 'bun:test';
import {thrownBy} from '../test/helpers/thrown.ts';
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

test('validateConfig accepts issue_tracker.provider beads without base_url', () => {
	// Beads is local — there is no host to configure.
	const raw = {
		version: 1,
		default_profile: 'test',
		issue_tracker: {provider: 'beads'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig names every supported tracker when one is unknown', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		issue_tracker: {provider: 'bugzilla'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('"linear", "jira", or "beads"')).toBeTruthy();
});

test('validateConfig rejects non-string default_emoji', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: 123,
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('default_emoji')).toBeTruthy();
});

test('validateConfig accepts empty-string default_emoji (blank slot)', () => {
	// Empty string means "reserve the emoji slot but render nothing in it",
	// keeping rows aligned when some profiles have an emoji and others don't.
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts valid default_emoji', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		default_emoji: '🍝',
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-string profile emoji', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: 42},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('profiles.test.emoji')).toBeTruthy();
});

test('validateConfig accepts empty-string profile emoji (blank slot)', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: ''},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts valid profile emoji', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {keywords: ['test'], display_name: 'Test', emoji: '🚀'},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// Profile team_prefix Validation Tests
// ============================================================================

test('validateConfig rejects non-string profile team_prefix', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('profiles.test.team_prefix: must be a string'),
	).toBeTruthy();
});

test('validateConfig accepts valid string profile team_prefix', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// Profile vars Validation Tests
// ============================================================================

test('validateConfig rejects non-string vars value', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('profiles.test.vars.IOS_APP_DIR: must be a string'),
	).toBeTruthy();
});

test('validateConfig accepts valid string vars', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts profile without vars', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-object vars', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('profiles.test.vars: must be an object'),
	).toBeTruthy();
});

test('validateConfig rejects null vars', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('profiles.test.vars: must be an object'),
	).toBeTruthy();
});

test('validateConfig accepts empty vars object', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig reports multiple invalid vars values', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('vars.FOO: must be a string')).toBeTruthy();
	expect(error?.message.includes('vars.BAR: must be a string')).toBeTruthy();
	// VALID should not appear in error
	expect(error?.message.includes('vars.VALID')).toBeFalsy();
});

test('validateConfig rejects reserved var name PATH', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('vars.PATH: reserved name')).toBeTruthy();
});

test('validateConfig rejects reserved var name HOME', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('vars.HOME: reserved name')).toBeTruthy();
});

test('validateConfig rejects reserved built-in template var ISSUE_KEY', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('vars.ISSUE_KEY: reserved name')).toBeTruthy();
});

test('validateConfig rejects reserved built-in template var WORKTREE_PATH', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('vars.WORKTREE_PATH: reserved name'),
	).toBeTruthy();
});

test('validateConfig allows non-reserved var names', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('RESERVED_VAR_NAMES includes critical shell variables', () => {
	for (const name of ['PATH', 'HOME', 'IFS', 'SHELL', 'USER', 'PWD', 'TERM']) {
		expect(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`).toBe(
			true,
		);
	}
});

test('RESERVED_VAR_NAMES includes built-in template variables', () => {
	for (const name of [
		'ISSUE_KEY',
		'WORKTREE_PATH',
		'REPO_ROOT',
		'REPO_NAME',
		'SCRIPT_DIR',
		'PR_URL',
		'VCS_LABEL',
	]) {
		expect(RESERVED_VAR_NAMES.has(name), `${name} should be reserved`).toBe(
			true,
		);
	}
});

// ============================================================================
// getDangerouslySkipPermissions Tests
// ============================================================================

test('validateConfig rejects non-boolean dangerously_skip_permissions', () => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: 'yes'},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = thrownBy(
		() => validateConfig(rawConfig),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('dangerously_skip_permissions: must be a boolean'),
	).toBeTruthy();
});

test('validateConfig accepts boolean dangerously_skip_permissions', () => {
	const rawConfig = {
		version: 1,
		default_profile: 'test',
		claude: {dangerously_skip_permissions: true},
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	expect(() => validateConfig(rawConfig)).not.toThrow();
});

// ============================================================================
// Keybinding Tests
// ============================================================================

test('validateConfig accepts valid keybindings', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects keybinding with multi-character key', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('must be a single character')).toBeTruthy();
});

test('validateConfig rejects keybinding with non-overridable reserved key', () => {
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
		const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
		expect(
			error?.message.includes('conflicts with built-in shortcut'),
		).toBeTruthy();
	}
});

test('validateConfig accepts keybinding that overrides a default key', () => {
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
		expect(
			() => validateConfig(raw),
			`"${defaultKey}" should be overridable`,
		).not.toThrow();
	}
});

test('validateConfig accepts disabled keybinding for a default key', () => {
	for (const defaultKey of DEFAULT_KEYBINDING_KEYS) {
		const raw = {
			version: 1,
			profiles: {
				test: {display_name: 'Test'},
			},
			keybindings: [{key: defaultKey, disabled: true}],
		};
		expect(
			() => validateConfig(raw),
			`"${defaultKey}" should be disableable`,
		).not.toThrow();
	}
});

test('K is an overridable default key, not a non-overridable one (STA-2111)', () => {
	// The `K` shortcut closes every done/canceled space. It behaves like the
	// other built-in defaults: a user `keybindings:` entry for `K` replaces it.
	expect(DEFAULT_KEYBINDING_KEYS.has('K')).toBe(true);
	expect(NON_OVERRIDABLE_KEYS.has('K')).toBe(false);
});

test('RESERVED_KEYS is the union of NON_OVERRIDABLE_KEYS and DEFAULT_KEYBINDING_KEYS', () => {
	const union = new Set([...NON_OVERRIDABLE_KEYS, ...DEFAULT_KEYBINDING_KEYS]);
	expect(RESERVED_KEYS).toStrictEqual(union);
	// No overlap between the two sets
	for (const key of NON_OVERRIDABLE_KEYS) {
		expect(
			DEFAULT_KEYBINDING_KEYS.has(key),
			`"${key}" should not be in both sets`,
		).toBe(false);
	}
});

test('validateConfig rejects duplicate keybinding keys', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('already bound')).toBeTruthy();
});

test('validateConfig rejects keybinding missing name', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('name: required string field')).toBeTruthy();
});

test('validateConfig rejects keybinding with no action', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			"must have exactly one of 'run', 'send_to_claude' or 'send_skill'",
		),
	).toBeTruthy();
});

test('validateConfig rejects a keybinding that both sends text and a skill', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		keybindings: [
			{key: 'a', name: 'Both', send_to_claude: '/a', send_skill: 'a'},
		],
		profiles: {test: {keywords: ['test'], display_name: 'Test'}},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('must have exactly one of')).toBeTruthy();
});

test('validateConfig accepts send_to_claude keybinding without run', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts uppercase versions of non-overridable keys', () => {
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
		expect(
			() => validateConfig(raw),
			`"${key}" should be allowed`,
		).not.toThrow();
	}
});

test('validateConfig accepts uppercase versions of default keybinding keys', () => {
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
		expect(
			() => validateConfig(raw),
			`"${key}" should be allowed`,
		).not.toThrow();
	}
});

test('validateConfig rejects disabled keybinding for a non-overridable key', () => {
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
		expect(
			() => validateConfig(raw),
			`"${key}" should not be disableable`,
		).toThrow();
	}
});

test('validateConfig rejects non-array keybindings', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('keybindings: must be an array')).toBeTruthy();
});

// ============================================================================
// Optional default_profile Tests
// ============================================================================

test('validateConfig accepts config without default_profile (uses first profile)', () => {
	const raw = {
		version: 1,
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
	// After validation, default_profile should be set to first profile key
	expect((raw as Record<string, unknown>)['default_profile']).toBe('my-app');
});

test('validateConfig rejects empty string default_profile', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('default_profile')).toBeTruthy();
});

// ============================================================================
// Optional keywords Tests
// ============================================================================

test('validateConfig accepts profile without keywords', () => {
	const raw = {
		version: 1,
		default_profile: 'test',
		profiles: {
			test: {
				display_name: 'Test',
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-array keywords', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('keywords: must be an array')).toBeTruthy();
});

test('minimal config with just team_prefix and one profile validates', () => {
	const raw = {
		version: 1,
		team_prefix: 'PROJ',
		profiles: {
			'my-app': {
				display_name: 'My App',
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// Validation: disabled keybindings
// ============================================================================

test('validation accepts disabled keybinding without name/run/send_to_claude', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'r', disabled: true}],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validation still rejects disabled keybinding with reserved key', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'j', disabled: true}],
	};
	const err = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(err!.errors.some(e => e.includes('"j" conflicts with built-in'))).toBe(
		true,
	);
});

test('validation still rejects disabled keybinding with invalid key', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
		keybindings: [{key: 'ab', disabled: true}],
	};
	const err = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(err!.errors.some(e => e.includes('must be a single character'))).toBe(
		true,
	);
});

// ============================================================================
// Per-profile claude and post_worktree_init validation
// ============================================================================

test('validateConfig accepts profile with valid claude.initialization_command', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: '/do'},
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects profile with non-string claude.initialization_command', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: {initialization_command: 42},
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('claude.initialization_command: must be a string'),
		),
	).toBe(true);
});

test('validateConfig rejects profile with non-object claude section', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				claude: 'not-an-object',
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error!.errors.some(e => e.includes('claude: must be an object'))).toBe(
		true,
	);
});

test('validateConfig accepts profile with valid post_worktree_init array', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects profile with non-array post_worktree_init', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: 'not-an-array',
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e => e.includes('post_worktree_init: must be an array')),
	).toBe(true);
});

test('validateConfig rejects profile post_worktree_init entry missing run', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_worktree_init: [{name: 'Missing run field'}],
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('post_worktree_init[0].run: required string field'),
		),
	).toBe(true);
});

// ============================================================================
// post_workspace_init (rename of post_worktree_init) and backwards compat
// ============================================================================

test('validateConfig accepts global post_workspace_init as replacement for post_worktree_init', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			// eslint-disable-next-line no-template-curly-in-string
			{name: 'Copy env', run: 'cp .env ${WORKTREE_PATH}/.env'},
		],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts post_worktree_init for backwards compat (global)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_worktree_init: [{name: 'Copy env', run: 'cp .env .env.bak'}],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at global level', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [{name: 'A', run: 'echo a'}],
		post_worktree_init: [{name: 'B', run: 'echo b'}],
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	).toBe(true);
});

test('validateConfig accepts profile-level post_workspace_init', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				post_workspace_init: [{name: 'Setup', run: 'echo setup'}],
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects both post_workspace_init and post_worktree_init at profile level', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes(
				'post_workspace_init and post_worktree_init cannot both be specified',
			),
		),
	).toBe(true);
});

// ============================================================================
// pre_workspace_deinit validation
// ============================================================================

test('validateConfig accepts global pre_workspace_deinit array', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects global non-array pre_workspace_deinit', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: 'not-an-array',
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	).toBe(true);
});

test('validateConfig rejects global pre_workspace_deinit entry missing run', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [{name: 'No run'}],
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	).toBe(true);
});

test('validateConfig accepts profile-level pre_workspace_deinit array', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Cleanup', run: 'rm -rf tmp/'}],
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects profile non-array pre_workspace_deinit', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: 42,
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit: must be an array'),
		),
	).toBe(true);
});

test('validateConfig rejects profile pre_workspace_deinit entry missing run', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				pre_workspace_deinit: [{name: 'Missing run'}],
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('pre_workspace_deinit[0].run: required string field'),
		),
	).toBe(true);
});

// ============================================================================
// continue_on_error validation
// ============================================================================

test('validateConfig accepts continue_on_error in post_workspace_init', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: true},
		],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts continue_on_error in pre_workspace_deinit', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: true},
		],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts continue_on_error: false in pre_workspace_deinit', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm -rf tmp/', continue_on_error: false},
		],
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-boolean continue_on_error in global post_workspace_init', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		post_workspace_init: [
			{name: 'Install', run: 'npm install', continue_on_error: 'yes'},
		],
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('post_workspace_init[0].continue_on_error: must be a boolean'),
		),
	).toBe(true);
});

test('validateConfig rejects non-boolean continue_on_error in global pre_workspace_deinit', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		pre_workspace_deinit: [
			{name: 'Cleanup', run: 'rm tmp/', continue_on_error: 1},
		],
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes(
				'pre_workspace_deinit[0].continue_on_error: must be a boolean',
			),
		),
	).toBe(true);
});

test('validateConfig rejects non-boolean continue_on_error in profile commands', () => {
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
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('commands[0].continue_on_error: must be a boolean'),
		),
	).toBe(true);
});

test('validation detects duplicate keys even if one is disabled', () => {
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
	const err = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(err!.errors.some(e => e.includes('"b" is already bound'))).toBe(true);
});

// ============================================================================
// issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts valid issue_watchlist with assignee and statuses', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 'In Progress'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts issue_watchlist with explicit assignee', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'charlie@example.com',
			statuses: ['In Review'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects issue_watchlist that is not an object', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: 'not-an-object',
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist: must be an object'),
	).toBeTruthy();
});

test('validateConfig accepts issue_watchlist without assignee (optional)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			statuses: ['To Do'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects issue_watchlist with non-string assignee', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 42,
			statuses: ['To Do'],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist.assignee: must be a string'),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist without statuses', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with non-array statuses', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: 'To Do',
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with empty statuses array', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: [],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.statuses: required non-empty array',
		),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with non-string statuses entries', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do', 123],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist.statuses[1]: must be a string'),
	).toBeTruthy();
});

test('validateConfig accepts config without issue_watchlist', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// Per-profile issue_watchlist Validation Tests
// ============================================================================

test('validateConfig accepts a profile-level issue_watchlist', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects a profile issue_watchlist that is not an object', () => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: 'nope'}},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('profiles.chaz.issue_watchlist: must be an object'),
	).toBeTruthy();
});

test('validateConfig rejects a profile issue_watchlist without statuses', () => {
	const raw = {
		version: 1,
		profiles: {chaz: {display_name: 'X', issue_watchlist: {assignee: 'me'}}},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.statuses: required non-empty array',
		),
	).toBeTruthy();
});

test('validateConfig rejects a profile issue_watchlist with non-string assignee', () => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {assignee: 5, statuses: ['To Do']},
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.assignee: must be a string',
		),
	).toBeTruthy();
});

test('validateConfig rejects a profile issue_watchlist with an empty key_prefix', () => {
	const raw = {
		version: 1,
		profiles: {
			chaz: {
				display_name: 'X',
				issue_watchlist: {statuses: ['To Do'], key_prefixes: ['STA', '']},
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'profiles.chaz.issue_watchlist.key_prefixes[1]: must not be empty',
		),
	).toBeTruthy();
});

// ============================================================================
// issue_watchlist labels Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with labels', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['pappardelle', 'platform'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts issue_watchlist without labels (optional)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects issue_watchlist with non-array labels', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: 'not-an-array',
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist.labels: must be an array'),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with non-string label entries', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: ['valid', 123],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist.labels[1]: must be a string'),
	).toBeTruthy();
});

test('validateConfig accepts issue_watchlist with empty labels array', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			labels: [],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// issue_watchlist key_prefixes Validation Tests
// ============================================================================

test('validateConfig accepts issue_watchlist with key_prefixes', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 'ENG'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts issue_watchlist without key_prefixes (optional)', () => {
	// Off-by-default regression: the field is optional and absence is valid.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts issue_watchlist with empty key_prefixes array', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects issue_watchlist with non-array key_prefixes', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: 'not-an-array',
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('issue_watchlist.key_prefixes: must be an array'),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with non-string key_prefix entries', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', 123],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must be a string',
		),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with empty-string key_prefix', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['STA', ''],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.key_prefixes[1]: must not be empty',
		),
	).toBeTruthy();
});

test('validateConfig rejects issue_watchlist with whitespace-only key_prefix', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		issue_watchlist: {
			assignee: 'me',
			statuses: ['To Do'],
			key_prefixes: ['   '],
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'issue_watchlist.key_prefixes[0]: must not be empty',
		),
	).toBeTruthy();
});

test('validateConfig rejects sous_chef without workspace_aware_agents', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		sous_chef: true,
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('sous_chef: needs workspace_aware_agents'),
	).toBeTruthy();
	expect(() =>
		validateConfig({...raw, workspace_aware_agents: true}),
	).not.toThrow();
});

test('validateConfig rejects sous_chef with a non-boolean value', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		sous_chef: 'on',
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('sous_chef: must be a boolean')).toBeTruthy();
});

// ============================================================================
// auto_remove_when_done Validation Tests
// ============================================================================

test('validateConfig accepts auto_remove_when_done set to true', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: true,
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts auto_remove_when_done set to false', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: false,
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts config without auto_remove_when_done (off by default)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects auto_remove_when_done with a non-boolean value', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 'yes',
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('auto_remove_when_done: must be a boolean'),
	).toBeTruthy();
});

test('validateConfig rejects auto_remove_when_done with a numeric value', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		auto_remove_when_done: 1,
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('auto_remove_when_done: must be a boolean'),
	).toBeTruthy();
});

// ============================================================================
// companion_command Validation Tests
// ============================================================================

test('validateConfig accepts top-level companion_command string', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 'gitui',
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts an empty-string companion_command (plain shell)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: '',
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts config without companion_command (default applies)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-string companion_command', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		companion_command: 42,
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('companion_command: must be a string'),
	).toBeTruthy();
});

test('validateConfig accepts a per-profile companion_command string', () => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: 'make run'},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects a non-string per-profile companion_command', () => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', companion_command: ['make', 'run']},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'profiles.backend.companion_command: must be a string',
		),
	).toBeTruthy();
});

// ============================================================================
// getCompanionCommand Tests
// ============================================================================

test('validateConfig checks each companion split', () => {
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

	expect(
		validate([
			{name: 'tests', command: 'bun test', split: 'down', size: '30%'},
			{name: 'logs-2', command: 'tail -f log', size: 12},
		]),
	).not.toThrow();
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
		const error = thrownBy(validate(splits), ConfigValidationError);
		expect(String(error?.message).includes(message)).toBe(true);
	}

	const error = thrownBy(
		validate([{name: 'A', command: 'x'}], true),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('profiles.test.companion_splits[0].name'),
	).toBe(true);
});

// ============================================================================
// ide_command Validation Tests
// ============================================================================

test('validateConfig accepts top-level ide_command string', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: CODE_IDE_COMMAND,
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts an empty-string ide_command (d disabled)', () => {
	// Rejecting this would be a trap: an invalid key throws from loadConfig, and
	// the TUI swallows that by running with no config at all.
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: '',
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects non-string ide_command', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		ide_command: 42,
	};
	const error = thrownBy(() => validateConfig(raw));
	expect(error?.message.includes('ide_command: must be a string')).toBeTruthy();
});

test('validateConfig accepts a per-profile ide_command string', () => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', ide_command: 'nvim-qt'},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects a non-string per-profile ide_command', () => {
	const raw = {
		version: 1,
		profiles: {
			backend: {display_name: 'Backend', ide_command: ['code', '.']},
		},
	};
	const error = thrownBy(() => validateConfig(raw));
	expect(
		error?.message.includes('profiles.backend.ide_command: must be a string'),
	).toBeTruthy();
});

// ============================================================================
// tracker_projects Validation Tests
// ============================================================================

test('validateConfig accepts profile with valid tracker_projects array', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 'The Hive Quality'],
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts profile without tracker_projects (optional)', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {display_name: 'Test'},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects profile with non-array tracker_projects', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: 'The Hive',
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('tracker_projects: must be an array when specified'),
		),
	).toBe(true);
});

test('validateConfig rejects profile with non-string tracker_projects entries', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: ['The Hive', 42],
			},
		},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error!.errors.some(e =>
			e.includes('tracker_projects[1]: must be a string'),
		),
	).toBe(true);
});

test('validateConfig accepts profile with empty tracker_projects array', () => {
	const raw = {
		version: 1,
		profiles: {
			test: {
				display_name: 'Test',
				tracker_projects: [],
			},
		},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// state_colors Validation Tests
// ============================================================================

test('validateConfig accepts config without state_colors (off by default)', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts an empty state_colors map', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {},
	};
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig accepts hex and ANSI color names in state_colors', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

test('validateConfig rejects a non-object state_colors', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: 'cyan',
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('state_colors: must be an object'),
	).toBeTruthy();
});

test('validateConfig rejects an array state_colors', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: ['cyan'],
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('state_colors: must be an object'),
	).toBeTruthy();
});

test('validateConfig rejects an unknown color name', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: 'chartreuse'},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'state_colors."Done": must be a hex color (#rgb or #rrggbb) or an ANSI color name',
		),
	).toBeTruthy();
});

test('validateConfig rejects malformed hex', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: '#12345'},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('state_colors."Done"')).toBeTruthy();
});

test('validateConfig rejects a non-string color value', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {Done: 123},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('state_colors."Done"')).toBeTruthy();
});

test('validateConfig rejects an empty state name', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {'   ': 'cyan'},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes('state_colors: state names must not be empty'),
	).toBeTruthy();
});

test('validateConfig rejects state names that differ only in case', () => {
	const raw = {
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		state_colors: {'In Progress': 'cyan', 'in progress': 'red'},
	};
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(
		error?.message.includes(
			'state_colors: duplicate state name "in progress" (names are matched case-insensitively)',
		),
	).toBeTruthy();
});

// ============================================================================
// getStateColors Tests
// ============================================================================

test('validateConfig accepts both list_view layouts', () => {
	for (const layout of ['single_line', 'two_line']) {
		expect(() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: {layout},
			}),
		).not.toThrow();
	}
});

test('validateConfig rejects an unknown list_view layout', () => {
	const error = thrownBy(
		() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: {layout: 'three_line'},
			}),
		ConfigValidationError,
	);
	expect(
		error?.message.includes(
			'list_view.layout: must be "single_line" or "two_line"',
		),
	).toBeTruthy();
});

test('validateConfig rejects a non-object list_view', () => {
	const error = thrownBy(
		() =>
			validateConfig({
				version: 1,
				profiles: {test: {display_name: 'Test'}},
				list_view: 'two_line',
			}),
		ConfigValidationError,
	);
	expect(error?.message.includes('list_view: must be an object')).toBeTruthy();
});

// layout — starting pane widths for the 3-column layout.

const validateLayout = (layout: unknown) => () => {
	validateConfig({
		version: 1,
		profiles: {test: {display_name: 'Test'}},
		layout,
	});
};

test('validateConfig accepts column and percent pane widths', () => {
	expect(
		validateLayout({
			rail_width: 30,
			claude_width: '45%',
			companion_width: '12.5%',
		}),
	).not.toThrow();
	expect(validateLayout({companion_width: '100%'})).not.toThrow();
	expect(validateLayout({})).not.toThrow();
});

test('validateConfig rejects pane widths that are not columns or percentages', () => {
	for (const value of [0, -5, 12.5, '30', '0%', '101%', 'wide', true]) {
		const error = thrownBy(
			validateLayout({rail_width: value}),
			ConfigValidationError,
		);
		expect(
			error?.message.includes(
				'layout.rail_width: must be a positive whole number',
			),
			`value ${String(value)}`,
		).toBeTruthy();
	}
});

test('validateConfig rejects a non-object layout', () => {
	const error = thrownBy(validateLayout('10/45/45'), ConfigValidationError);
	expect(error?.message.includes('layout: must be an object')).toBeTruthy();
});

// ============================================================================
// issue_watchlist max_workspaces Validation Tests (STE-25)
// ============================================================================

test('validateConfig accepts max_workspaces on top-level and profile watchlists', () => {
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
	expect(() => validateConfig(raw)).not.toThrow();
});

for (const bad of [0, -1, 1.5, '5']) {
	test(`validateConfig rejects max_workspaces: ${JSON.stringify(bad)}`, () => {
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
		const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
		expect(
			error?.message.includes(
				'issue_watchlist.max_workspaces: must be an integer >= 1',
			),
		).toBeTruthy();
		expect(
			error?.message.includes(
				'profiles.chaz.issue_watchlist.max_workspaces: must be an integer >= 1',
			),
		).toBeTruthy();
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

test('validateConfig rejects non-object agent_profiles', () => {
	const error = thrownBy(
		() => validateConfig(agentProfilesConfig({agent_profiles: ['x']})),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('agent_profiles: must be an object'),
	).toBeTruthy();
});

test('validateConfig rejects an agent_profiles entry without command', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({agent_profiles: {codex: {args: '--yolo'}}}),
			),
		ConfigValidationError,
	);
	expect(error?.message.includes('agent_profiles.codex.command')).toBeTruthy();
});

test('validateConfig rejects an empty agent profile command', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({agent_profiles: {codex: {command: '  '}}}),
			),
		ConfigValidationError,
	);
	expect(error?.message.includes('agent_profiles.codex.command')).toBeTruthy();
});

test('validateConfig rejects non-string agent profile args and resume_args', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						codex: {command: 'codex', args: 1, resume_args: true},
					},
				}),
			),
		ConfigValidationError,
	);
	expect(error?.message.includes('agent_profiles.codex.args')).toBeTruthy();
	expect(
		error?.message.includes('agent_profiles.codex.resume_args'),
	).toBeTruthy();
});

test('validateConfig rejects agent profile fields spanning lines', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						codex: {command: 'codex', args: '--yolo\n--search\n'},
					},
				}),
			),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('agent_profiles.codex.args: must be a single line'),
	).toBeTruthy();
});

test('validateConfig rejects agent profile env that is not a map of strings', () => {
	const error = thrownBy(
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
		ConfigValidationError,
	);
	const message = error?.message ?? '';
	expect(message.includes('agent_profiles.list.env: must be a map')).toBe(true);
	expect(
		message.includes(
			'agent_profiles.typed.env.1BAD: must be an environment variable name',
		),
	).toBe(true);
	expect(
		message.includes(
			'agent_profiles.typed.env.A-B: must be an environment variable name',
		),
	).toBe(true);
	expect(
		message.includes(
			'agent_profiles.typed.env.PAPPARDELLE_SPACE: PAPPARDELLE_ variables are set by pappardelle',
		),
	).toBe(true);
	expect(
		message.includes('agent_profiles.typed.env.NUMBER: must be a string'),
	).toBe(true);
});

test('validateConfig accepts agent profile env of strings', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {
					opus: {command: 'claude', env: {CODE_MODE: '1', _X2: ''}},
				},
			}),
		),
	).not.toThrow();
});

test('validateConfig accepts the trailing newline of a YAML block scalar', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {codex: {command: 'codex', args: '--yolo\n'}},
			}),
		),
	).not.toThrow();
});

test('validateConfig rejects non-boolean is_claude', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {w: {command: 'w', is_claude: 'yes'}},
				}),
			),
		ConfigValidationError,
	);
	expect(error?.message.includes('agent_profiles.w.is_claude')).toBeTruthy();
});

test('validateConfig rejects model or effort on a CLI with no flag template', () => {
	const error = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {aider: {command: 'aider', model: 'x', effort: 'y'}},
				}),
			),
		ConfigValidationError,
	);
	expect(error?.message.includes('agent_profiles.aider.model')).toBeTruthy();
	expect(error?.message.includes('set model_args')).toBeTruthy();
	expect(error?.message.includes('agent_profiles.aider.effort')).toBeTruthy();
});

test('validateConfig accepts model and effort on claude, codex, or with a template', () => {
	expect(() =>
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
	).not.toThrow();
});

for (const promptArgs of ['-i', '', '-i {prompt} {prompt}']) {
	test(`validateConfig rejects prompt_args ${JSON.stringify(promptArgs)}`, () => {
		const error = thrownBy(
			() =>
				validateConfig(
					agentProfilesConfig({
						agent_profiles: {agy: {command: 'agy', prompt_args: promptArgs}},
					}),
				),
			ConfigValidationError,
		);
		expect(
			error?.message.includes(
				'agent_profiles.agy.prompt_args: must contain {prompt} exactly once',
			),
		).toBeTruthy();
	});
}

test('validateConfig accepts prompt_args with one {prompt}', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {agy: {command: 'agy', prompt_args: '-i {prompt}'}},
			}),
		),
	).not.toThrow();
});

test('validateConfig accepts a minimal agy profile with a model', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {agy: {command: 'agy', model: 'gemini-4-argon-medium'}},
			}),
		),
	).not.toThrow();
});

test('validateConfig accepts agy mode values and empty string to clear', () => {
	for (const mode of ['accept-edits', 'auto', 'plan', '']) {
		expect(() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {agy: {command: 'agy', mode}},
				}),
			),
		).not.toThrow();
	}
});

test('validateConfig rejects invalid, non-string, or multi-line agy mode', () => {
	for (const [mode, expectedError] of [
		['yolo', 'must be "accept-edits", "auto", or "plan"'],
		[123, 'must be a string'],
		['plan\nauto', 'must be a single line'],
	] as const) {
		const error = thrownBy(
			() =>
				validateConfig(
					agentProfilesConfig({
						agent_profiles: {agy: {command: 'agy', mode}},
					}),
				),
			ConfigValidationError,
		);
		expect(
			error?.errors.some(
				e =>
					e.includes('agent_profiles.agy.mode:') && e.includes(expectedError),
			),
		).toBe(true);
	}
});

test('validateConfig rejects mode on a CLI with no mode_args template and accepts custom mode_args', () => {
	const missingTemplate = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {codex: {command: 'codex', mode: 'plan'}},
				}),
			),
		ConfigValidationError,
	);
	expect(
		missingTemplate?.message.includes(
			'agent_profiles.codex.mode: "codex" has no built-in mode flag; set mode_args',
		),
	).toBeTruthy();

	const badTemplate = thrownBy(
		() =>
			validateConfig(
				agentProfilesConfig({
					agent_profiles: {
						aider: {command: 'aider', mode: 'plan', mode_args: '--mode'},
					},
				}),
			),
		ConfigValidationError,
	);
	expect(
		badTemplate?.message.includes(
			'agent_profiles.aider.mode_args: must contain {mode}',
		),
	).toBeTruthy();

	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {
					aider: {command: 'aider', mode: 'plan', mode_args: '--mode {mode}'},
				},
			}),
		),
	).not.toThrow();
});

test('validateConfig rejects combining an effort-suffixed agy model id with effort', () => {
	for (const model of [
		'gemini-4-hydrogen-low',
		'gemini-4-hydrogen-medium',
		'gemini-4-neon-high',
		'claude-opus-5-5-xhigh',
		'gpt-oss-120b-max',
	]) {
		const error = thrownBy(
			() =>
				validateConfig(
					agentProfilesConfig({
						agent_profiles: {
							agy: {command: '/usr/local/bin/agy', model, effort: 'high'},
						},
					}),
				),
			ConfigValidationError,
		);
		expect(
			error?.errors.some(
				e =>
					e.includes(`agent_profiles.agy: model "${model}"`) &&
					e.includes('already includes an effort suffix'),
			),
		).toBe(true);
	}
});

test('validateConfig accepts unsuffixed agy model + effort, suffixed without effort, and suffixed non-agy + effort', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {
					base: {command: 'agy', model: 'gemini-4-hydrogen', effort: 'high'},
					cleared: {
						command: 'agy',
						model: 'gemini-4-hydrogen-medium',
						effort: '',
					},
					claude: {
						command: 'claude',
						model: 'claude-opus-5-5-medium',
						effort: 'high',
					},
					codex: {
						command: 'codex',
						model: 'gpt-5-medium',
						effort: 'high',
					},
					gated: {
						command: 'agy',
						is_claude: true,
						model: 'gemini-4-hydrogen-medium',
						effort: 'high',
					},
				},
			}),
		),
	).not.toThrow();
});

test('validateConfig rejects a flag template without its placeholder', () => {
	const error = thrownBy(
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
		ConfigValidationError,
	);
	expect(
		error?.message.includes(
			'agent_profiles.codex.model_args: must contain {model}',
		),
	).toBeTruthy();
	expect(
		error?.message.includes(
			'agent_profiles.codex.effort_args: must contain {effort}',
		),
	).toBeTruthy();
});

test('validateConfig rejects a top-level agent_profile reference to an unknown name', () => {
	const error = thrownBy(
		() => validateConfig(agentProfilesConfig({agent_profile: 'codex'})),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('agent profile "codex" not found'),
	).toBeTruthy();
});

test('validateConfig accepts agent_profile "claude" without an agent_profiles entry', () => {
	expect(() =>
		validateConfig(agentProfilesConfig({agent_profile: 'claude'})),
	).not.toThrow();
});

test('validateConfig accepts a top-level agent_profile reference to a defined agent profile', () => {
	expect(() =>
		validateConfig(
			agentProfilesConfig({
				agent_profiles: {codex: {command: 'codex'}},
				agent_profile: 'codex',
			}),
		),
	).not.toThrow();
});

test('validateConfig rejects a profile agent_profile reference to an unknown name', () => {
	const raw = agentProfilesConfig({});
	(raw['profiles'] as Record<string, Record<string, unknown>>)['test']![
		'agent_profile'
	] = 'codex';
	const error = thrownBy(() => validateConfig(raw), ConfigValidationError);
	expect(error?.message.includes('profiles.test.agent_profile')).toBeTruthy();
});

test('validateConfig accepts an empty-string profile agent_profile (clears inherited)', () => {
	const raw = agentProfilesConfig({});
	(raw['profiles'] as Record<string, Record<string, unknown>>)['test']![
		'agent_profile'
	] = '';
	expect(() => validateConfig(raw)).not.toThrow();
});

// ============================================================================
// initialization_command — rename + deprecated fallback
// ============================================================================

test('validateConfig rejects non-string initialization_command', () => {
	const error = thrownBy(
		() => validateConfig(agentProfilesConfig({initialization_command: 5})),
		ConfigValidationError,
	);
	expect(
		error?.message.includes('initialization_command: must be a string'),
	).toBeTruthy();
});

// ============================================================================
// list_view.group_by / list_view.groups
// ============================================================================

test('validateConfig accepts custom groups by status and category', () => {
	expect(
		validateListView({
			group_by: 'status',
			groups: [
				{name: 'Doing', color: 'blue', categories: ['todo', 'in_progress']},
				{name: 'QA', color: '#a78bfa', statuses: ['In Review', 'QA']},
				{name: 'Done', color: 'green', categories: ['done']},
			],
		}),
	).toBe('');
});

test('validateConfig rejects groups that the rail could not place', () => {
	const message = validateListView({
		groups: [
			{name: 'Doing', color: 'blue', categories: ['todo']},
			{name: 'Review', color: 'chartreuse', statuses: ['In Review']},
			{name: 'review', color: 'blue', statuses: ['in review']},
			{name: 'Empty', color: 'blue'},
			{name: 'Odd', color: 'blue', categories: ['started']},
		],
	});
	expect(message.includes('list_view.groups[1].color:')).toBe(true);
	expect(
		message.includes('list_view.groups[2].name: duplicate group "review"'),
	).toBe(true);
	expect(
		message.includes(
			'list_view.groups[2].statuses: "in review" is already in list_view.groups[1]',
		),
	).toBe(true);
	expect(
		message.includes('list_view.groups[3]: needs statuses, categories or both'),
	).toBe(true);
	expect(message.includes('list_view.groups[4].categories:')).toBe(true);
	expect(
		validateListView({groups: []}).includes('must be a non-empty list'),
	).toBe(true);
	expect(
		validateListView({
			groups: [{name: 'Nothing', color: 'blue', statuses: [], categories: []}],
		}).includes('list_view.groups[0]: needs statuses, categories or both'),
	).toBe(true);
});

// ============================================================================
// sous_chef_key
// ============================================================================

const withSousChefKey = (value: unknown) => ({
	version: 1,
	profiles: {test: {display_name: 'Test'}},
	sous_chef_key: value,
});

test('validateConfig accepts a sous_chef_key name or false', () => {
	expect(() => validateConfig(withSousChefKey('M-j'))).not.toThrow();
	expect(() => validateConfig(withSousChefKey(false))).not.toThrow();
});

for (const value of ['', '  ', true, 3]) {
	test(`validateConfig rejects sous_chef_key ${JSON.stringify(value)}`, () => {
		const error = thrownBy(
			() => validateConfig(withSousChefKey(value)),
			ConfigValidationError,
		);
		expect(
			error?.message.includes(
				'sous_chef_key: must be a tmux key name or false',
			),
		).toBe(true);
	});
}
