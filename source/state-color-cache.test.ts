import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	StateColorCache,
	initStateColorCacheDir,
	resetStateColorCacheDir,
} from './providers/state-color-cache.ts';

let tempCounter = 0;
function tempCachePath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-scc-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-scc-dir-test-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

test('get returns null for unknown state', t => {
	const cache = new StateColorCache(tempCachePath());
	t.is(cache.get('Unknown'), null);
});

test('update stores color in memory', t => {
	const cache = new StateColorCache(tempCachePath());
	cache.update('Done', '#74d09f');
	t.is(cache.get('Done'), '#74d09f');
});

test('update persists to disk', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('In Progress', '#f2c94c');

	t.true(fs.existsSync(p));
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.is(data['In Progress'], '#f2c94c');
});

test('constructor loads persisted colors from disk', t => {
	const p = tempCachePath();
	fs.writeFileSync(p, JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n');

	const cache = new StateColorCache(p);
	t.is(cache.get('Done'), '#aaa');
	t.is(cache.get('Todo'), '#bbb');
});

test('update does not write when color is unchanged', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('Done', '#74d09f');

	const stat1 = fs.statSync(p);
	cache.update('Done', '#74d09f');
	const stat2 = fs.statSync(p);

	t.is(stat1.mtimeMs, stat2.mtimeMs);
});

test('invalid JSON on disk is silently ignored', t => {
	const p = tempCachePath();
	fs.writeFileSync(p, '{{not json');

	const cache = new StateColorCache(p);
	t.is(cache.get('Done'), null);
});

test('missing file on disk is silently ignored', t => {
	const cache = new StateColorCache(tempCachePath());
	t.is(cache.get('Done'), null);
});

test('multiple updates accumulate in the persisted file', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('Done', '#aaa');
	cache.update('In Progress', '#bbb');
	cache.update('Todo', '#ccc');

	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.is(data['Done'], '#aaa');
	t.is(data['In Progress'], '#bbb');
	t.is(data['Todo'], '#ccc');
});

// ============================================================================
// Repo-namespaced state color cache
// ============================================================================

test.serial(
	'initStateColorCacheDir sets default path for new StateColorCache instances',
	t => {
		const baseDir = tempDir();
		const repoDir = path.join(baseDir, 'repos', 'my-repo');
		fs.mkdirSync(repoDir, {recursive: true});

		initStateColorCacheDir(repoDir);

		const cache = new StateColorCache();
		cache.update('Done', '#74d09f');

		const expectedPath = path.join(repoDir, 'state-colors.json');
		t.true(fs.existsSync(expectedPath));

		resetStateColorCacheDir();
	},
);

test.serial(
	'initStateColorCacheDir migrates legacy state-colors.json by moving it',
	t => {
		const baseDir = tempDir();
		const repoDir = path.join(baseDir, 'repos', 'my-repo');

		// Create legacy file
		const legacyPath = path.join(baseDir, 'state-colors.json');
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n',
		);

		initStateColorCacheDir(repoDir, baseDir);

		// New cache should have migrated data
		const cache = new StateColorCache();
		t.is(cache.get('Done'), '#aaa');
		t.is(cache.get('Todo'), '#bbb');

		// Legacy file should be gone
		t.false(fs.existsSync(legacyPath));

		// Repo-specific file should exist
		const repoPath = path.join(repoDir, 'state-colors.json');
		t.true(fs.existsSync(repoPath));

		resetStateColorCacheDir();
	},
);

test.serial(
	'initStateColorCacheDir deletes legacy file even if repo file already exists',
	t => {
		const baseDir = tempDir();
		const repoDir = path.join(baseDir, 'repos', 'my-repo');
		fs.mkdirSync(repoDir, {recursive: true});

		// Create legacy file
		const legacyPath = path.join(baseDir, 'state-colors.json');
		fs.writeFileSync(legacyPath, JSON.stringify({Done: '#old'}) + '\n');

		// Create repo-specific file
		const repoPath = path.join(repoDir, 'state-colors.json');
		fs.writeFileSync(repoPath, JSON.stringify({Done: '#new'}) + '\n');

		initStateColorCacheDir(repoDir, baseDir);

		// Legacy file should be deleted
		t.false(fs.existsSync(legacyPath));

		// Repo file should be preserved
		const cache = new StateColorCache();
		t.is(cache.get('Done'), '#new');

		resetStateColorCacheDir();
	},
);
