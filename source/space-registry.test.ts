import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getRegisteredSpaces,
	addSpace,
	removeSpace,
	isSpaceRegistered,
	setRegistryPath,
	resetRegistryPath,
	getRegistryPathForRepo,
	initForRepo,
	setLockTimingForTests,
	resetLockTimingForTests,
} from './space-registry.ts';
import {getRecentErrors, clearRecentErrors} from './logger.ts';

let tempCounter = 0;
function tempRegistryPath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-registry-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-test-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

test.afterEach(() => {
	resetRegistryPath();
});

test.serial('returns empty array when no file exists', t => {
	setRegistryPath(tempRegistryPath());
	t.deepEqual(getRegisteredSpaces(), []);
});

test.serial('addSpace adds to registry and persists', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);

	t.true(fs.existsSync(p));
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.deepEqual(data, ['STA-100']);
});

test.serial('addSpace is a no-op for duplicates', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	addSpace('STA-100');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);
});

test.serial('removeSpace removes from registry and persists', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	addSpace('STA-200');
	removeSpace('STA-100');

	t.deepEqual(getRegisteredSpaces(), ['STA-200']);
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.deepEqual(data, ['STA-200']);
});

test.serial('removeSpace is a no-op for missing keys', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	removeSpace('STA-999');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);
});

test.serial('isSpaceRegistered returns correct boolean', t => {
	setRegistryPath(tempRegistryPath());

	addSpace('STA-100');
	t.true(isSpaceRegistered('STA-100'));
	t.false(isSpaceRegistered('STA-999'));
});

test.serial('loads persisted data from disk', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, JSON.stringify(['STA-50', 'STA-60']) + '\n');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), ['STA-50', 'STA-60']);
});

test.serial('invalid JSON on disk is silently ignored', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, '{{not json');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), []);
});

test.serial('filters out non-string values from disk', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, JSON.stringify(['STA-1', 42, null, 'STA-2']) + '\n');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), ['STA-1', 'STA-2']);
});

// STA-1416 regression: a removed space must stay removed across restarts, even
// if a stale inner-socket tmux session for that issue key is still around. The
// old startup migration (`seedFromTmux(getLinearIssuesFromTmux())`) used to
// resurrect such keys; removing it means the on-disk registry is now the sole
// source of truth and surviving tmux sessions cannot leak back into the rail.
test.serial(
	'removed space stays removed across simulated restart even if tmux session lingers',
	t => {
		const p = tempRegistryPath();
		setRegistryPath(p);

		// First "run": user opens two spaces, then closes STA-100.
		addSpace('STA-100');
		addSpace('STA-200');
		removeSpace('STA-100');
		t.deepEqual(getRegisteredSpaces(), ['STA-200']);

		// Simulate quit + relaunch: drop in-memory cache, re-read from disk.
		// (A lingering tmux session for STA-100 — whether `killSpaceSessions`
		// failed or a previous session was never torn down — would previously
		// be re-seeded into the registry here. It must not.)
		setRegistryPath(p);

		t.deepEqual(getRegisteredSpaces(), ['STA-200']);
		t.false(isSpaceRegistered('STA-100'));
	},
);

// ============================================================================
// Repo-namespaced registry paths
// ============================================================================

test.serial(
	'getRegistryPathForRepo returns repo-namespaced path under ~/.pappardelle/repos/',
	t => {
		const result = getRegistryPathForRepo('stardust-labs');
		t.true(result.includes('/repos/stardust-labs/open-spaces.json'));
		t.true(result.includes('.pappardelle'));
	},
);

test.serial(
	'getRegistryPathForRepo returns different paths for different repos',
	t => {
		const path1 = getRegistryPathForRepo('stardust-labs');
		const path2 = getRegistryPathForRepo('pappa-chex');
		t.not(path1, path2);
		t.true(path1.includes('stardust-labs'));
		t.true(path2.includes('pappa-chex'));
	},
);

test.serial('initForRepo sets registry path for the given repo', t => {
	const baseDir = tempDir();
	initForRepo('my-repo', baseDir);

	addSpace('REPO-1');
	t.deepEqual(getRegisteredSpaces(), ['REPO-1']);

	// Verify file is at the repo-namespaced location
	const expectedPath = path.join(
		baseDir,
		'repos',
		'my-repo',
		'open-spaces.json',
	);
	t.true(fs.existsSync(expectedPath));
	const data = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
	t.deepEqual(data, ['REPO-1']);
});

test.serial('initForRepo keeps spaces separate between repos', t => {
	const baseDir = tempDir();

	// Initialize repo A and add spaces
	initForRepo('repo-a', baseDir);
	addSpace('A-1');
	addSpace('A-2');

	// Initialize repo B and add different spaces
	initForRepo('repo-b', baseDir);
	addSpace('B-1');

	// Verify repo B only has its own spaces
	t.deepEqual(getRegisteredSpaces(), ['B-1']);

	// Switch back to repo A and verify its spaces are intact
	initForRepo('repo-a', baseDir);
	t.deepEqual(getRegisteredSpaces(), ['A-1', 'A-2']);
});

// ============================================================================
// Migration from legacy global open-spaces.json
// ============================================================================

test.serial(
	'initForRepo migrates legacy open-spaces.json to repo-specific path',
	t => {
		const baseDir = tempDir();

		// Create legacy file at the old global location
		const legacyPath = path.join(baseDir, 'open-spaces.json');
		fs.writeFileSync(legacyPath, JSON.stringify(['STA-100', 'STA-200']) + '\n');

		// Initialize for a repo — should migrate legacy data
		initForRepo('stardust-labs', baseDir);

		t.deepEqual(getRegisteredSpaces(), ['STA-100', 'STA-200']);

		// Verify new repo-specific file exists
		const repoPath = path.join(
			baseDir,
			'repos',
			'stardust-labs',
			'open-spaces.json',
		);
		t.true(fs.existsSync(repoPath));

		// Verify legacy file was moved (not copied)
		t.false(fs.existsSync(legacyPath));
	},
);

test.serial(
	'initForRepo does NOT overwrite existing repo-specific file with legacy data, but still removes legacy',
	t => {
		const baseDir = tempDir();

		// Create legacy file
		const legacyPath = path.join(baseDir, 'open-spaces.json');
		fs.writeFileSync(legacyPath, JSON.stringify(['OLD-1', 'OLD-2']) + '\n');

		// Create repo-specific file (already migrated previously)
		const repoDir = path.join(baseDir, 'repos', 'stardust-labs');
		fs.mkdirSync(repoDir, {recursive: true});
		const repoPath = path.join(repoDir, 'open-spaces.json');
		fs.writeFileSync(repoPath, JSON.stringify(['NEW-1']) + '\n');

		// Initialize — should use existing repo file, not legacy
		initForRepo('stardust-labs', baseDir);
		t.deepEqual(getRegisteredSpaces(), ['NEW-1']);

		// Legacy file should be deleted even though repo file already existed
		t.false(fs.existsSync(legacyPath));
		t.true(fs.existsSync(repoPath));
	},
);

test.serial('initForRepo works cleanly when no legacy file exists', t => {
	const baseDir = tempDir();

	// No legacy file, no repo file — fresh start
	initForRepo('fresh-repo', baseDir);
	t.deepEqual(getRegisteredSpaces(), []);

	addSpace('FRESH-1');
	t.deepEqual(getRegisteredSpaces(), ['FRESH-1']);
});

// ============================================================================
// STA-1553: concurrency safety — disk is the source of truth, writes merge
//
// The registry is shared by every Pappardelle instance running against the same
// repo (multiple windows + each instance's independent watchlist auto-spawn
// loop). The old design read disk once into a process-lifetime cache and then
// persisted via full-array overwrite, so a stale instance would clobber another
// instance's additions — silently dropping live spaces from open-spaces.json
// while their inner-socket sessions + worktrees stayed alive, which the startup
// reaper then killed ("reaped N orphaned inner-socket session(s)"). These tests
// pin the read-modify-write-under-lock fix: each mutation re-reads fresh disk
// state and applies only its own delta.
// ============================================================================

test.serial(
	'getRegisteredSpaces reflects out-of-band disk writes (no stale cache)',
	t => {
		const p = tempRegistryPath();
		setRegistryPath(p);

		addSpace('STA-100');
		t.deepEqual(getRegisteredSpaces(), ['STA-100']);

		// Another instance adds STA-200 directly to disk. We must see it on the
		// next read — the old in-memory cache would have hidden it.
		fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200']) + '\n');
		t.deepEqual(getRegisteredSpaces(), ['STA-100', 'STA-200']);
	},
);

test.serial(
	'addSpace merges with out-of-band additions instead of clobbering them',
	t => {
		const p = tempRegistryPath();
		setRegistryPath(p);

		addSpace('STA-100');

		// Simulate a concurrent instance adding STA-200 between our reads.
		fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200']) + '\n');

		// Our instance now opens STA-300. It must re-read the fresh disk state
		// and append, preserving STA-200 rather than writing a stale [STA-100,…].
		addSpace('STA-300');

		const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
		t.deepEqual(new Set(onDisk), new Set(['STA-100', 'STA-200', 'STA-300']));
	},
);

test.serial(
	'removeSpace preserves out-of-band additions from another instance',
	t => {
		const p = tempRegistryPath();
		setRegistryPath(p);

		addSpace('STA-100');
		addSpace('STA-200');

		// Concurrent instance auto-spawns STA-300.
		fs.writeFileSync(
			p,
			JSON.stringify(['STA-100', 'STA-200', 'STA-300']) + '\n',
		);

		// We close STA-100. STA-300 must survive — only our own delta applies.
		removeSpace('STA-100');

		const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
		t.deepEqual(new Set(onDisk), new Set(['STA-200', 'STA-300']));
	},
);

test.serial(
	'removeSpace honors an out-of-band removal of the same key (idempotent)',
	t => {
		const p = tempRegistryPath();
		setRegistryPath(p);

		addSpace('STA-100');
		addSpace('STA-200');

		// Another instance already closed STA-100.
		fs.writeFileSync(p, JSON.stringify(['STA-200']) + '\n');

		// Our close of STA-100 should be a clean no-op that leaves STA-200 intact.
		removeSpace('STA-100');

		const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
		t.deepEqual(onDisk, ['STA-200']);
	},
);

test.serial('writes leave no leftover temp or lock files behind', t => {
	const dir = tempDir();
	const p = path.join(dir, 'open-spaces.json');
	setRegistryPath(p);

	addSpace('STA-1');
	addSpace('STA-2');
	removeSpace('STA-1');

	// Atomic temp files (rename target) and the advisory lock must be cleaned up.
	const leftovers = fs
		.readdirSync(dir)
		.filter(f => f !== 'open-spaces.json')
		.sort();
	t.deepEqual(leftovers, []);
});

test.serial(
	'a persistently-held lock falls back to a lock-less write and warns',
	t => {
		const dir = tempDir();
		const p = path.join(dir, 'open-spaces.json');
		setRegistryPath(p);

		// Simulate another instance holding the lock: a fresh lock file that the
		// stale-steal threshold (set high below) will never reclaim.
		const lockPath = `${p}.lock`;
		fs.writeFileSync(lockPath, '');

		// Exercise the fallback in milliseconds instead of the real ~5s timeout.
		setLockTimingForTests({timeoutMs: 40, retryMs: 5, staleMs: 60_000});
		clearRecentErrors();

		try {
			addSpace('STA-1');

			// The write must still land — the UI never deadlocks on a wedged holder.
			t.deepEqual(getRegisteredSpaces(), ['STA-1']);

			// …and the lost-update-reopening fallback must be surfaced as a warning.
			const warned = getRecentErrors().some(
				e => e.level === 'warn' && e.message.includes('proceeding without it'),
			);
			t.true(warned);

			// The foreign lock was never ours; the fallback must leave it intact.
			t.true(fs.existsSync(lockPath));
		} finally {
			resetLockTimingForTests();
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Already gone — fine.
			}
		}
	},
);
