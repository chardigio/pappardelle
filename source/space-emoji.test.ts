import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {resolveSpaceEmoji} from './space-emoji.ts';
import {readSpaceState, writeSpaceState} from './space-state.ts';
import type {PappardelleConfig} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';

let tempCounter = 0;

function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-space-emoji-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

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

// ============================================================================
// Persisted-profile fast path — first paint after `idow` writes the profile.
// ============================================================================

test('reads persisted profile and returns its emoji directly', t => {
	const base = tempDir();
	writeSpaceState('repo', 'STA-1', {profile: 'pappardelle'}, base);
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'Pappardelle', emoji: '🍝'}},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-1',
			cachedIssue: null,
			baseDir: base,
		}),
		'🍝',
	);
});

test('persisted profile takes precedence over a cached-issue project match', t => {
	const base = tempDir();
	writeSpaceState('repo', 'STA-1', {profile: 'a'}, base);
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', emoji: '🅰️', tracker_projects: ['Project B']},
			b: {display_name: 'B', emoji: '🅱️', tracker_projects: ['Project B']},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-1',
			cachedIssue: makeIssue('Project B'),
			baseDir: base,
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
	const base = tempDir();
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
		repoName: 'repo',
		issueKey: 'STA-2',
		cachedIssue: makeIssue('Pappardelle Quality'),
		baseDir: base,
	});
	t.is(result, '🍝');
	t.is(readSpaceState('repo', 'STA-2', base)?.profile, 'pappardelle');
});

test('after backfill, subsequent calls resolve emoji without needing the cached issue', t => {
	const base = tempDir();
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
		repoName: 'repo',
		issueKey: 'STA-2',
		cachedIssue: makeIssue('Pappardelle Quality'),
		baseDir: base,
	});
	// Now act as if the in-memory issue cache was evicted — we still get the
	// emoji from the persisted profile alone.
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-2',
			cachedIssue: null,
			baseDir: base,
		}),
		'🍝',
	);
});

test('does not re-write space-state when profile is already persisted', async t => {
	const base = tempDir();
	writeSpaceState('repo', 'STA-3', {profile: 'pappardelle'}, base);
	const filePath = path.join(
		base,
		'repos',
		'repo',
		'space-state',
		'STA-3.json',
	);
	const mtimeBefore = fs.statSync(filePath).mtimeMs;
	await new Promise<void>(resolve => {
		setTimeout(resolve, 10);
	});
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'P', emoji: '🍝'}},
	});
	resolveSpaceEmoji({
		config,
		repoName: 'repo',
		issueKey: 'STA-3',
		cachedIssue: makeIssue('Some Other Project'),
		baseDir: base,
	});
	t.is(fs.statSync(filePath).mtimeMs, mtimeBefore);
});

test('does not persist when cached-issue project does not match any profile', t => {
	const base = tempDir();
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
		repoName: 'repo',
		issueKey: 'STA-4',
		cachedIssue: makeIssue('Some Other Project'),
		baseDir: base,
	});
	t.is(readSpaceState('repo', 'STA-4', base), null);
});

test('does not persist when cached issue is null', t => {
	const base = tempDir();
	const config = makeConfig({
		profiles: {pappardelle: {display_name: 'P', emoji: '🍝'}},
	});
	resolveSpaceEmoji({
		config,
		repoName: 'repo',
		issueKey: 'STA-5',
		cachedIssue: null,
		baseDir: base,
	});
	t.is(readSpaceState('repo', 'STA-5', base), null);
});

// ============================================================================
// Stale persisted profile — single source of truth: the persisted name is
// authoritative. If it no longer maps to a real config entry we let the
// footgun guard render a blank slot, rather than re-introducing a second
// resolution path. Users can recover by editing/deleting the json.
// ============================================================================

test('persisted profile that no longer exists in config returns blank slot, not a cached-issue fallthrough', t => {
	const base = tempDir();
	writeSpaceState('repo', 'STA-8', {profile: 'deleted_profile'}, base);
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
			repoName: 'repo',
			issueKey: 'STA-8',
			cachedIssue: makeIssue('Pappardelle Quality'),
			baseDir: base,
		}),
		'',
	);
});

// ============================================================================
// Footgun guard from getProfileEmoji — unmatched rows still reserve the
// emoji column so they line up with emoji-bearing siblings.
// ============================================================================

test('returns blank slot when no profile resolves and any sibling has emoji', t => {
	const base = tempDir();
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', emoji: '🎸'},
			b: {display_name: 'B'},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-6',
			cachedIssue: null,
			baseDir: base,
		}),
		'',
	);
});

test('returns blank slot when issueKey is undefined (main worktree) and a sibling has emoji', t => {
	const base = tempDir();
	const config = makeConfig({
		profiles: {a: {display_name: 'A', emoji: '🎸'}},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: undefined,
			cachedIssue: null,
			baseDir: base,
		}),
		'',
	);
});

// ============================================================================
// Master-equivalence: emoji-free configs must stay byte-identical to master,
// even though backfill still writes the profile name (it's harmless metadata).
// ============================================================================

test('emoji-free config returns undefined for every signal combination', t => {
	const base = tempDir();
	const config = makeConfig({
		profiles: {
			a: {display_name: 'A', tracker_projects: ['Project A']},
			b: {display_name: 'B'},
		},
	});
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-9',
			cachedIssue: makeIssue('Project A'),
			baseDir: base,
		}),
		undefined,
	);
	t.is(
		resolveSpaceEmoji({
			config,
			repoName: 'repo',
			issueKey: 'STA-9',
			cachedIssue: null,
			baseDir: base,
		}),
		undefined,
	);
});

// ============================================================================
// null config — happens when .pappardelle.yml is missing or invalid; the TUI
// loads with config: null and downstream lookups must not crash or write.
// ============================================================================

test('null config returns undefined and does not persist anything', t => {
	const base = tempDir();
	t.is(
		resolveSpaceEmoji({
			config: null,
			repoName: 'repo',
			issueKey: 'STA-10',
			cachedIssue: makeIssue('Project A'),
			baseDir: base,
		}),
		undefined,
	);
	t.is(readSpaceState('repo', 'STA-10', base), null);
});
