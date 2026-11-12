import fs from 'node:fs';
import test from 'ava';
import {testState} from '../test/helpers/state.ts';
import {resolveSpaceEmoji, resolveSpaceProfileName} from './space-emoji.ts';
import type {PappardelleConfig} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';

function makeConfig(
	overrides: Partial<PappardelleConfig> = {},
): PappardelleConfig {
	return {
		version: 1,
		profiles: {},
		...overrides,
	};
}

function makeIssue(projectName: string | undefined): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: 't',
		state: {name: 'In Progress', color: '#fff'},
		project: projectName ? {name: projectName} : undefined,
	} as unknown as TrackerIssue;
}

test('the rail emoji honors saved profiles and backfills without dropping other state', async t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', emoji: '🅰️'},
			b: {display_name: 'B', emoji: '🅱️', tracker_projects: ['Project B']},
		},
	});
	const args = {
		config,
		spaceState,
		issueKey: 'STA-1',
		cachedIssue: makeIssue('Project B'),
	};
	await spaceState.write('STA-1', {profile: 'a'});
	t.is(resolveSpaceEmoji(args), '🅰️');
	await spaceState.write('STA-2', {
		pipeline: 'passing',
		unresolvedCommentCount: 3,
	});
	t.is(resolveSpaceEmoji({...args, issueKey: 'STA-2'}), '🅱️');
	t.is(spaceState.read('STA-2')?.profile, 'b');
	t.is(spaceState.read('STA-2')?.unresolvedCommentCount, 3);
	t.is(resolveSpaceEmoji({...args, issueKey: undefined}), '');
	// A state file that cannot be read is a space with no saved profile.
	fs.writeFileSync(spaceState.file('STA-3'), '{');
	t.is(resolveSpaceEmoji({...args, issueKey: 'STA-3'}), '🅱️');
});

// ============================================================================
// Persisted-profile fast path — first paint after `idow` writes the profile.
// ============================================================================

test('reads persisted profile and returns its emoji directly', async t => {
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-1', {profile: 'pappardelle'});
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'Pappardelle', emoji: '🍝'}},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-1',
			cachedIssue: null,
		}),
		'🍝',
	);
});

test('persisted profile takes precedence over a cached-issue project match', async t => {
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-1', {profile: 'a'});
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', emoji: '🅰️', tracker_projects: ['Project B']},
			b: {display_name: 'B', emoji: '🅱️', tracker_projects: ['Project B']},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-1',
			cachedIssue: makeIssue('Project B'),
		}),
		'🅰️',
	);
});

// ============================================================================
// Backfill path — covers existing spaces (pre-STA-930) and any space added
// to the rail without going through `idow`. The cached-issue project match
// is no longer a render-time fallback: when it fires, we PERSIST so the
// next call (and every call after) reads the same single source of truth.
// ============================================================================

test('backfills persisted profile from cached-issue project match', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			pappardelle: {
				display_name: 'Pappardelle',
				emoji: '🍝',
				tracker_projects: ['Pappardelle Quality'],
			},
		},
	});
	const result = resolveSpaceEmoji({
		config,
		spaceState,
		issueKey: 'STA-2',
		cachedIssue: makeIssue('Pappardelle Quality'),
	});
	t.is(result, '🍝');
	t.is(spaceState.read('STA-2')?.profile, 'pappardelle');
});

test('after backfill, subsequent calls resolve emoji without needing the cached issue', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			pappardelle: {
				display_name: 'Pappardelle',
				emoji: '🍝',
				tracker_projects: ['Pappardelle Quality'],
			},
		},
	});
	resolveSpaceEmoji({
		config,
		spaceState,
		issueKey: 'STA-2',
		cachedIssue: makeIssue('Pappardelle Quality'),
	});
	// Now act as if the in-memory issue cache was evicted — we still get the
	// emoji from the persisted profile alone.
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-2',
			cachedIssue: null,
		}),
		'🍝',
	);
});

test('does not re-write space-state when profile is already persisted', async t => {
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-3', {profile: 'pappardelle'});
	const filePath = spaceState.file('STA-3');
	const mtimeBefore = fs.statSync(filePath).mtimeMs;
	await new Promise<void>(resolve => {
		setTimeout(resolve, 10);
	});
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'P', emoji: '🍝'}},
	});
	resolveSpaceEmoji({
		config,
		spaceState,
		issueKey: 'STA-3',
		cachedIssue: makeIssue('Some Other Project'),
	});
	t.is(fs.statSync(filePath).mtimeMs, mtimeBefore);
});

test('does not persist when cached-issue project does not match any profile', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			pappardelle: {
				display_name: 'Pappardelle',
				emoji: '🍝',
				tracker_projects: ['Pappardelle Quality'],
			},
		},
	});
	resolveSpaceEmoji({
		config,
		spaceState,
		issueKey: 'STA-4',
		cachedIssue: makeIssue('Some Other Project'),
	});
	t.is(spaceState.read('STA-4'), null);
});

test('does not persist when cached issue is null', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'P', emoji: '🍝'}},
	});
	resolveSpaceEmoji({
		config,
		spaceState,
		issueKey: 'STA-5',
		cachedIssue: null,
	});
	t.is(spaceState.read('STA-5'), null);
});

// ============================================================================
// Stale persisted profile — single source of truth: the persisted name is
// authoritative. If it no longer maps to a real config entry we let the
// footgun guard render a blank slot, rather than re-introducing a second
// resolution path. Users can recover by editing/deleting the json.
// ============================================================================

test('persisted profile that no longer exists in config returns blank slot, not a cached-issue fallthrough', async t => {
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-8', {profile: 'deleted_profile'});
	const config = makeConfig({
		profiles: {
			pappardelle: {
				display_name: 'Pappardelle',
				emoji: '🍝',
				tracker_projects: ['Pappardelle Quality'],
			},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-8',
			cachedIssue: makeIssue('Pappardelle Quality'),
		}),
		'',
	);
});

// ============================================================================
// Footgun guard from getProfileEmoji — unmatched rows still reserve the
// emoji column so they line up with emoji-bearing siblings.
// ============================================================================

test('returns blank slot when no profile resolves and any sibling has emoji', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', emoji: '🎸'},
			b: {display_name: 'B'},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-6',
			cachedIssue: null,
		}),
		'',
	);
});

test('returns blank slot when issueKey is undefined (main worktree) and a sibling has emoji', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {a: {display_name: 'A', emoji: '🎸'}},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: undefined,
			cachedIssue: null,
		}),
		'',
	);
});

// ============================================================================
// Master-equivalence: emoji-free configs must stay byte-identical to master,
// even though backfill still writes the profile name (it's harmless metadata).
// ============================================================================

test('emoji-free config returns undefined for every signal combination', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', tracker_projects: ['Project A']},
			b: {display_name: 'B'},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-9',
			cachedIssue: makeIssue('Project A'),
		}),
		undefined,
	);
	t.is(
		resolveSpaceEmoji({
			config,
			spaceState,
			issueKey: 'STA-9',
			cachedIssue: null,
		}),
		undefined,
	);
});

// ============================================================================
// null config — happens when .pappardelle.yml is missing or invalid; the TUI
// loads with config: null and downstream lookups must not crash or write.
// ============================================================================

test('null config returns undefined and does not persist anything', t => {
	const {spaceState} = testState(t).daos;
	t.is(
		resolveSpaceEmoji({
			config: null,
			spaceState,
			issueKey: 'STA-10',
			cachedIssue: makeIssue('Project A'),
		}),
		undefined,
	);
	t.is(spaceState.read('STA-10'), null);
});

// ============================================================================
// resolveSpaceProfileName — the shared lookup behind both the rail emoji and
// the `d` key's ide_command. Emoji-free configs still need a profile name, so
// these assert the name rather than the emoji it happens to produce.
// ============================================================================

test('resolveSpaceProfileName returns the persisted profile', async t => {
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-20', {profile: 'backend'});
	const config = makeConfig({
		profiles: {backend: {display_name: 'Backend'}},
	});
	t.is(
		resolveSpaceProfileName({
			config,
			spaceState,
			issueKey: 'STA-20',
			cachedIssue: null,
		}),
		'backend',
	);
});

test('resolveSpaceProfileName prefers the persisted profile over a project match', async t => {
	// The case title-keyword matching gets wrong: a space created as `a` whose
	// issue belongs to `b`'s project must still resolve to `a`.
	const {spaceState} = testState(t).daos;
	await spaceState.write('STA-21', {profile: 'a'});
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A'},
			b: {display_name: 'B', tracker_projects: ['Project B']},
		},
	});
	t.is(
		resolveSpaceProfileName({
			config,
			spaceState,
			issueKey: 'STA-21',
			cachedIssue: makeIssue('Project B'),
		}),
		'a',
	);
});

test('resolveSpaceProfileName backfills from a project match and persists it', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({
		profiles: {
			backend: {display_name: 'Backend', tracker_projects: ['Project B']},
		},
	});
	t.is(
		resolveSpaceProfileName({
			config,
			spaceState,
			issueKey: 'STA-22',
			cachedIssue: makeIssue('Project B'),
		}),
		'backend',
	);
	t.is(spaceState.read('STA-22')?.profile, 'backend');
});

test('resolveSpaceProfileName returns undefined with neither signal', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({profiles: {backend: {display_name: 'Backend'}}});
	t.is(
		resolveSpaceProfileName({
			config,
			spaceState,
			issueKey: 'STA-23',
			cachedIssue: null,
		}),
		undefined,
	);
	t.is(spaceState.read('STA-23'), null);
});

test('resolveSpaceProfileName returns undefined for the main worktree row', t => {
	const {spaceState} = testState(t).daos;
	const config = makeConfig({profiles: {backend: {display_name: 'Backend'}}});
	t.is(
		resolveSpaceProfileName({
			config,
			spaceState,
			issueKey: undefined,
			cachedIssue: makeIssue('Project B'),
		}),
		undefined,
	);
});
