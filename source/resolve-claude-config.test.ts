import test from 'ava';
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_PATH = path.resolve(
	import.meta.dirname!,
	'..',
	'scripts',
	'resolve-claude-config.sh',
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
 * Run the resolve-claude-config.sh script and parse its JSON output.
 */
function runResolver(
	configPath: string,
	localConfigPath: string,
	homeConfigPath?: string,
): {init_cmd: string; skip_permissions: string} {
	let cmd = `bash "${SCRIPT_PATH}" --config "${configPath}" --local-config "${localConfigPath}"`;
	if (homeConfigPath) {
		cmd += ` --home-config "${homeConfigPath}"`;
	}

	const output = execSync(cmd, {encoding: 'utf-8'}).trim();
	return JSON.parse(output) as {init_cmd: string; skip_permissions: string};
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
