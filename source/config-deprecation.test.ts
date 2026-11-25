import path from 'node:path';
import test from 'ava';
import {getAgentProfile, loadConfigFromPaths} from './config.ts';
import {getRecentErrors} from './logger.ts';
import {setupTempDir} from '../test/helpers/config-fixtures.ts';

test('loadConfigFromPaths warns about a deprecated home spelling shadowed by the project', t => {
	// The merge shares nested objects with the raw layers, so the home layer
	// must be checked before anything rewrites the merged config.
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
profiles:
  shadowedhomewarn:
    display_name: T
    claude:
      initialization_command: old
`,
		'project/.pappardelle.yml': `version: 1
profiles:
  shadowedhomewarn:
    display_name: T
    initialization_command: new
`,
	});
	try {
		loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		const warnings = getRecentErrors().filter(
			entry =>
				entry.message.includes('shadowedhomewarn') &&
				entry.message.includes('~/.pappardelle/.pappardelle.yml'),
		);
		t.is(warnings.length, 1);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths warns about a deprecated init spelling only once per process', t => {
	// The TUI reloads config on every space selection; re-warning on each
	// reload would fill the logger's 10-entry recent-error buffer and evict
	// real errors from the overlay.
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
profiles:
  warnonceprofile:
    display_name: T
    claude:
      initialization_command: old
`,
	});
	try {
		const load = () =>
			loadConfigFromPaths({projectDir: path.join(dir, 'project')});
		load();
		load();
		const warnings = getRecentErrors().filter(entry =>
			entry.message.includes('warnonceprofile'),
		);
		t.is(warnings.length, 1);
	} finally {
		cleanup();
	}
});

test('loadConfigFromPaths warns about claude.model and claude.effort, top-level and per profile', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
claude:
  model: claudemodelwarn
profiles:
  claudeeffortwarn:
    display_name: T
    claude:
      effort: high
`,
	});
	try {
		const config = loadConfigFromPaths({
			projectDir: path.join(dir, 'project'),
		});
		t.is(getAgentProfile(config).model, 'claudemodelwarn');
		const messages = getRecentErrors().map(entry => entry.message);
		t.true(
			messages.some(
				message =>
					message.includes('.pappardelle.yml: claude.model is deprecated') &&
					message.includes('agent_profiles.<name>.model'),
			),
		);
		t.true(
			messages.some(message =>
				message.includes(
					'.pappardelle.yml: profiles.claudeeffortwarn.claude.effort is deprecated',
				),
			),
		);
	} finally {
		cleanup();
	}
});

// An alias is a copy in YAML, so renaming the old spelling where the anchor
// sits must leave every alias of it with the old spelling to rename.
test('a deprecated claude map shared through an alias renames for every profile', t => {
	const {dir, cleanup} = setupTempDir({
		'project/.pappardelle.yml': `version: 1
team_prefix: BASE
default_profile: b
initialization_command: top
issue_tracker: {provider: beads}
profiles:
  a: {display_name: A, claude: &c {initialization_command: legacy}}
  b: {display_name: B, claude: *c}
`,
	});
	try {
		const config = loadConfigFromPaths({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(config.profiles['a']?.initialization_command, 'legacy');
		t.is(config.profiles['b']?.initialization_command, 'legacy');
	} finally {
		cleanup();
	}
});
