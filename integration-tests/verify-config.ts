#!/usr/bin/env npx tsx
/**
 * Local verification of config loading against real .pappardelle.yml files.
 * Tests: config exists → loads → validates → local overrides merge → profile matching
 *
 * NOT an ava test — run manually with `npx tsx integration-tests/verify-config.ts`
 *
 * Must be run from inside a repo that has a .pappardelle.yml.
 */

import {
	configExists,
	loadConfig,
	loadProviderConfigs,
	getIssueWatchlist,
	listProfiles,
	getDefaultProfile,
	getProfile,
	matchProfiles,
	getTeamPrefix,
	getKeybindings,
	getInitializationCommand,
	getDangerouslySkipPermissions,
	type PappardelleConfig,
} from '../source/config.ts';

let failed = false;

function header(title: string) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  ${title}`);
	console.log('='.repeat(60));
}

function pass(msg: string) {
	console.log(`  \u2705 ${msg}`);
}

function fail(msg: string) {
	console.log(`  \u274c ${msg}`);
	failed = true;
}

function info(label: string, value: unknown) {
	const str = JSON.stringify(value) ?? 'undefined';
	// Truncate long values
	console.log(
		`  ${label}: ${str.length > 200 ? str.slice(0, 200) + '...' : str}`,
	);
}

function main() {
	console.log('Config System — Local Verification');

	// ── configExists ──────────────────────────────────────────
	header('configExists()');
	const exists = configExists();
	info('result', exists);

	if (exists) {
		pass('Config file found');
	} else {
		fail('No .pappardelle.yml found — run from a repo that has one');
		process.exit(1);
	}

	// ── loadConfig ────────────────────────────────────────────
	header('loadConfig()');
	let config: PappardelleConfig;
	try {
		config = loadConfig();
		pass('Config loaded and validated successfully');
	} catch (err) {
		fail(`loadConfig() threw: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	// ── loadProviderConfigs ───────────────────────────────────
	header('loadProviderConfigs()');
	const providerConfigs = loadProviderConfigs();
	info('issue_tracker', providerConfigs.issue_tracker);
	info('vcs_host', providerConfigs.vcs_host);

	if (providerConfigs.issue_tracker) {
		pass(`Issue tracker configured: ${providerConfigs.issue_tracker.type}`);
	} else {
		pass('No issue tracker configured (optional)');
	}

	if (providerConfigs.vcs_host) {
		pass(`VCS host configured: ${providerConfigs.vcs_host.type}`);
	} else {
		pass('No VCS host configured (optional)');
	}

	// ── Team prefix ───────────────────────────────────────────
	header('getTeamPrefix()');
	const prefix = getTeamPrefix(config);
	info('prefix', prefix);
	pass(`Team prefix: ${prefix}`);

	// ── Profiles ──────────────────────────────────────────────
	header('Profiles');
	const profiles = listProfiles(config);
	info('count', profiles.length);

	if (profiles.length === 0) {
		pass('No profiles configured (optional)');
	} else {
		pass(`${profiles.length} profiles found`);
		for (const p of profiles) {
			console.log(`    ${p.name} — ${p.displayName}`);
		}

		// Default profile
		try {
			const defaultProfile = getDefaultProfile(config);
			pass(`Default profile: ${defaultProfile.name}`);
		} catch {
			pass('No default profile set');
		}

		// Test getProfile on first profile
		const firstProfile = getProfile(config, profiles[0]!.name);
		if (firstProfile) {
			pass(`getProfile("${profiles[0]!.name}") returned successfully`);
		} else {
			fail(`getProfile("${profiles[0]!.name}") returned undefined`);
		}

		// Test matchProfiles with a profile's display name
		const matches = matchProfiles(config, profiles[0]!.displayName);
		info('matchProfiles result count', matches.length);
		if (matches.length > 0) {
			pass(`matchProfiles matched: ${matches.map(m => m.name).join(', ')}`);
		}
	}

	// ── Issue watchlist ───────────────────────────────────────
	header('getIssueWatchlist()');
	const watchlist = getIssueWatchlist(config);

	if (watchlist) {
		pass('Issue watchlist configured');
		info('assignee', watchlist.assignee);
		info('statuses', watchlist.statuses);
		info('labels', watchlist.labels);

		if (watchlist.assignee) {
			pass('Assignee is set');
		} else {
			fail('Assignee is missing');
		}

		if (Array.isArray(watchlist.statuses) && watchlist.statuses.length > 0) {
			pass(`${watchlist.statuses.length} statuses configured`);
		} else {
			fail('No statuses configured');
		}

		if (watchlist.labels !== undefined) {
			if (Array.isArray(watchlist.labels)) {
				pass(`${watchlist.labels.length} label filters configured`);
			} else {
				fail('labels is not an array');
			}
		} else {
			pass('No label filters (all issues pass through)');
		}
	} else {
		pass('No issue watchlist configured (optional)');
	}

	// ── Keybindings ───────────────────────────────────────────
	header('getKeybindings()');
	const keybindings = getKeybindings(config);
	info('count', keybindings.length);

	if (keybindings.length > 0) {
		pass(`${keybindings.length} keybindings configured`);
		for (const kb of keybindings.slice(0, 5)) {
			console.log(`    ${kb.key} → ${kb.command ?? kb.action ?? '(custom)'}`);
		}

		if (keybindings.length > 5) {
			console.log(`    ... and ${keybindings.length - 5} more`);
		}
	} else {
		pass('No custom keybindings (optional)');
	}

	// ── Claude config ─────────────────────────────────────────
	header('Claude config');
	const initCmd = getInitializationCommand(config);
	const skipPerms = getDangerouslySkipPermissions(config);
	info('initialization_command', initCmd);
	info('dangerously_skip_permissions', skipPerms);

	if (initCmd) {
		pass(
			`Initialization command: ${initCmd.slice(0, 80)}${initCmd.length > 80 ? '...' : ''}`,
		);
	} else {
		pass('No initialization command (optional)');
	}

	pass(`Skip permissions: ${skipPerms}`);

	// ── Summary ───────────────────────────────────────────────
	header('Summary');
	if (failed) {
		fail('Some checks failed — see above');
		process.exit(1);
	} else {
		pass('All config checks passed');
	}
}

main();
