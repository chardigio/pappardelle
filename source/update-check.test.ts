import test, {type ExecutionContext} from 'ava';
import fs, {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir, homedir} from 'node:os';
import path from 'node:path';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState} from '../test/helpers/state.ts';
import {
	parseSemver,
	compareSemver,
	readInstalledVersion,
	readInstalledVersionFromGit,
	resolveInstalledVersion,
	resolveDisplayVersion,
	isLocalMode,
	checkForUpdate,
	safeCheckForUpdate,
	type CacheEntry,
	type UpdateCheckDao,
} from './update-check.ts';

function initRepoWithTag(dir: string, tag: string | null): void {
	execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
	execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
	execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
	execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
	writeFileSync(path.join(dir, 'f'), 'x');
	execFileSync('git', ['-C', dir, 'add', '.']);
	execFileSync('git', [
		'-C',
		dir,
		'commit',
		'-q',
		'--no-gpg-sign',
		'-m',
		'init',
	]);
	if (tag) {
		execFileSync('git', ['-C', dir, 'tag', tag]);
	}
}

// ============================================================================
// parseSemver
// ============================================================================

test('parseSemver: plain semver', t => {
	t.deepEqual(parseSemver('0.1.0'), {major: 0, minor: 1, patch: 0});
	t.deepEqual(parseSemver('1.2.3'), {major: 1, minor: 2, patch: 3});
	t.deepEqual(parseSemver('10.20.30'), {major: 10, minor: 20, patch: 30});
});

test('parseSemver: strips leading v', t => {
	t.deepEqual(parseSemver('v1.2.3'), {major: 1, minor: 2, patch: 3});
	t.deepEqual(parseSemver('V0.1.0'), {major: 0, minor: 1, patch: 0});
});

test('parseSemver: rejects garbage', t => {
	t.is(parseSemver(''), null);
	t.is(parseSemver('1.2'), null);
	t.is(parseSemver('1.2.3.4'), null);
	t.is(parseSemver('not-a-version'), null);
	t.is(parseSemver('1.a.3'), null);
});

// ============================================================================
// compareSemver
// ============================================================================

test('compareSemver: equal versions', t => {
	t.is(compareSemver('1.2.3', '1.2.3'), 0);
	t.is(compareSemver('v0.1.0', '0.1.0'), 0);
});

test('compareSemver: major wins over minor/patch', t => {
	t.is(compareSemver('1.0.0', '2.0.0'), -1);
	t.is(compareSemver('2.0.0', '1.99.99'), 1);
});

test('compareSemver: minor wins over patch', t => {
	t.is(compareSemver('1.1.0', '1.2.0'), -1);
	t.is(compareSemver('1.2.0', '1.1.99'), 1);
});

test('compareSemver: patch', t => {
	t.is(compareSemver('1.2.3', '1.2.4'), -1);
	t.is(compareSemver('1.2.5', '1.2.4'), 1);
});

test('compareSemver: unparsable falls back to 0', t => {
	t.is(compareSemver('garbage', '1.2.3'), 0);
	t.is(compareSemver('1.2.3', 'garbage'), 0);
});

// ============================================================================
// readInstalledVersion
// ============================================================================

test('readInstalledVersion: reads from package.json', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-'));
	const pkg = path.join(dir, 'package.json');
	writeFileSync(pkg, JSON.stringify({name: 'pappardelle', version: '1.2.3'}));
	try {
		t.is(readInstalledVersion(pkg), '1.2.3');
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('readInstalledVersion: returns null when file missing', t => {
	t.is(readInstalledVersion('/definitely/does/not/exist/package.json'), null);
});

test('readInstalledVersion: returns null when version missing', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-'));
	const pkg = path.join(dir, 'package.json');
	writeFileSync(pkg, JSON.stringify({name: 'pappardelle'}));
	try {
		t.is(readInstalledVersion(pkg), null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// ============================================================================
// readInstalledVersionFromGit
// ============================================================================

// These tests build real git repos via execFileSync, which blocks AVA's worker
// thread on a synchronous OS wait. Running many of them concurrently (AVA's
// default) starves AVA's IPC heartbeat for the whole batch's duration, which
// exceeds its idle timeout and reports every test in the file — including
// unrelated instant ones — as pending. Keeping these serial fixes that without
// slowing down the rest of the file.
test.serial(
	'readInstalledVersionFromGit: returns the latest semver tag reachable from HEAD',
	t => {
		const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-git-'));
		try {
			initRepoWithTag(dir, 'v1.2.3');
			t.is(readInstalledVersionFromGit(dir), 'v1.2.3');
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	},
);

test.serial('readInstalledVersionFromGit: ignores non-semver tags', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-git-'));
	try {
		initRepoWithTag(dir, 'not-a-version');
		t.is(readInstalledVersionFromGit(dir), null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial(
	'readInstalledVersionFromGit: returns null when no tags exist',
	t => {
		const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-git-'));
		try {
			initRepoWithTag(dir, null);
			t.is(readInstalledVersionFromGit(dir), null);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	},
);

test('readInstalledVersionFromGit: returns null when not a git repo', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-git-'));
	try {
		t.is(readInstalledVersionFromGit(dir), null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// ============================================================================
// resolveInstalledVersion (git tag preferred, package.json fallback)
// ============================================================================

test.serial('resolveInstalledVersion: uses the git tag when present', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-resolve-'));
	try {
		initRepoWithTag(dir, 'v2.0.0');
		writeFileSync(
			path.join(dir, 'package.json'),
			JSON.stringify({version: '0.1.0'}),
		);
		t.is(resolveInstalledVersion(dir), 'v2.0.0');
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial(
	'resolveInstalledVersion: falls back to package.json when no tags',
	t => {
		const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-resolve-'));
		try {
			initRepoWithTag(dir, null);
			writeFileSync(
				path.join(dir, 'package.json'),
				JSON.stringify({version: '0.1.0'}),
			);
			t.is(resolveInstalledVersion(dir), '0.1.0');
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	},
);

test('resolveInstalledVersion: returns null when neither source works', t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-resolve-'));
	try {
		t.is(resolveInstalledVersion(dir), null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// ============================================================================
// resolveDisplayVersion (help-overlay version: real tag vs -dev build)
// ============================================================================

test.serial(
	'resolveDisplayVersion: real release checkout reports the tag, not dev',
	t => {
		const proj = mkdtempSync(path.join(tmpdir(), 'pap-disp-proj-'));
		const install = mkdtempSync(path.join(tmpdir(), 'pap-disp-inst-'));
		try {
			initRepoWithTag(proj, 'v0.7.9');
			initRepoWithTag(install, 'v0.7.9');
			t.deepEqual(resolveDisplayVersion(proj, install), {
				version: 'v0.7.9',
				isDev: false,
			});
		} finally {
			rmSync(proj, {recursive: true, force: true});
			rmSync(install, {recursive: true, force: true});
		}
	},
);

test.serial(
	'resolveDisplayVersion: monorepo/worktree build reports the installed clone tag, flagged -dev',
	t => {
		// projectDir has no vX.Y.Z tag (mirrors the monorepo); installed clone does.
		const proj = mkdtempSync(path.join(tmpdir(), 'pap-disp-proj-'));
		const install = mkdtempSync(path.join(tmpdir(), 'pap-disp-inst-'));
		try {
			initRepoWithTag(proj, null);
			initRepoWithTag(install, 'v0.7.9');
			t.deepEqual(resolveDisplayVersion(proj, install), {
				version: 'v0.7.9',
				isDev: true,
			});
		} finally {
			rmSync(proj, {recursive: true, force: true});
			rmSync(install, {recursive: true, force: true});
		}
	},
);

test.serial(
	'resolveDisplayVersion: NEVER reports the stale package.json 0.1.0 for a dev build',
	t => {
		// Regression guard for STA-1494: a worktree build whose package.json says
		// 0.1.0 must surface the installed clone's real tag (as -dev), not 0.1.0.
		const proj = mkdtempSync(path.join(tmpdir(), 'pap-disp-proj-'));
		const install = mkdtempSync(path.join(tmpdir(), 'pap-disp-inst-'));
		try {
			initRepoWithTag(proj, null);
			writeFileSync(
				path.join(proj, 'package.json'),
				JSON.stringify({version: '0.1.0'}),
			);
			initRepoWithTag(install, 'v0.7.9');
			const result = resolveDisplayVersion(proj, install);
			t.not(result.version, '0.1.0');
			t.deepEqual(result, {version: 'v0.7.9', isDev: true});
		} finally {
			rmSync(proj, {recursive: true, force: true});
			rmSync(install, {recursive: true, force: true});
		}
	},
);

test.serial(
	'resolveDisplayVersion: returns null version (sha-only) when nothing is resolvable',
	t => {
		const proj = mkdtempSync(path.join(tmpdir(), 'pap-disp-proj-'));
		const install = mkdtempSync(path.join(tmpdir(), 'pap-disp-inst-'));
		try {
			initRepoWithTag(proj, null);
			initRepoWithTag(install, null);
			t.deepEqual(resolveDisplayVersion(proj, install), {
				version: null,
				isDev: false,
			});
		} finally {
			rmSync(proj, {recursive: true, force: true});
			rmSync(install, {recursive: true, force: true});
		}
	},
);

test.serial(
	'resolveDisplayVersion: defaults installedRoot to ~/.pappardelle/repo',
	t => {
		// When projectDir itself carries the tag, the default installedRoot is never
		// consulted, so this is safe to run without touching the real home dir.
		const proj = mkdtempSync(path.join(tmpdir(), 'pap-disp-proj-'));
		try {
			initRepoWithTag(proj, 'v1.2.3');
			t.deepEqual(resolveDisplayVersion(proj), {
				version: 'v1.2.3',
				isDev: false,
			});
		} finally {
			rmSync(proj, {recursive: true, force: true});
		}
	},
);

// ============================================================================
// Cache IO
// ============================================================================

contractTest(
	'a cached check reads back, and a later one replaces it',
	async (t, state) => {
		const {updateCheck} = state.daos;
		t.is(updateCheck.read(), null);

		const entry: CacheEntry = {
			checkedAt: 1_700_000_000_000,
			latestVersion: '0.2.0',
		};
		await updateCheck.write(entry);
		t.deepEqual(updateCheck.read(), entry);

		const later = {checkedAt: 1_700_000_100_000, latestVersion: '0.3.0'};
		await updateCheck.write(later);
		t.deepEqual(updateCheck.read(), later);
	},
);

// The benchmarks and the compiled-binary tests write the file before they
// start Pappardelle, so that it makes no network call.
contractTest(
	'a cache file written before Pappardelle starts is honored',
	(t, state) => {
		const seeded = {checkedAt: 1_700_000_000_000, latestVersion: 'v0.0.0'};
		fs.writeFileSync(
			path.join(state.stateDir, 'update-check.json'),
			JSON.stringify(seeded),
		);
		t.deepEqual(state.daos.updateCheck.read(), seeded);
	},
);

contractTest(
	'a cache file that is malformed, incomplete or removed reads as nothing cached',
	async (t, state) => {
		const {updateCheck} = state.daos;
		const file = path.join(state.stateDir, 'update-check.json');
		await updateCheck.write({checkedAt: 1, latestVersion: '0.2.0'});

		fs.writeFileSync(file, 'not json');
		t.is(updateCheck.read(), null);

		fs.writeFileSync(file, JSON.stringify({checkedAt: 123}));
		t.is(updateCheck.read(), null);

		await updateCheck.write({checkedAt: 2, latestVersion: '0.2.0'});
		fs.rmSync(file);
		t.is(updateCheck.read(), null);
	},
);

test('the two stores leave the same cache file', async t => {
	const files = [];
	for (const sqlite of [false, true]) {
		const state = testState(t, {sqlite});
		await state.daos.updateCheck.write({
			checkedAt: 1_700_000_000_000,
			latestVersion: '0.2.0',
		});
		files.push(
			fs.readFileSync(path.join(state.stateDir, 'update-check.json'), 'utf8'),
		);
	}

	t.is(files[0], files[1]);
	t.deepEqual(JSON.parse(files[0]!), {
		checkedAt: 1_700_000_000_000,
		latestVersion: '0.2.0',
	});
});

// ============================================================================
// isLocalMode
// ============================================================================

test('isLocalMode: true when project dir is outside ~/.pappardelle/repo', t => {
	const projectDir =
		'/Users/charlie/.worktrees/x/STA-864/_dev/scripts/pappardelle';
	t.true(isLocalMode(projectDir));
});

test('isLocalMode: false when project dir matches the installed location', t => {
	const projectDir = path.join(homedir(), '.pappardelle', 'repo');
	t.false(isLocalMode(projectDir));
});

test('isLocalMode: false for a subdir of the installed location', t => {
	// Defensive — if for some reason we pass dist/ instead of the project root.
	const projectDir = path.join(homedir(), '.pappardelle', 'repo', 'dist');
	t.false(isLocalMode(projectDir));
});

// ============================================================================
// checkForUpdate orchestration (no network — uses a fresh cache to avoid it)
// ============================================================================

function setupFakeInstall(
	t: ExecutionContext,
	installed: string,
): {
	projectDir: string;
	cache: UpdateCheckDao;
	cleanup: () => void;
} {
	// Build a fake installed tree under ~/.pappardelle/repo/ so LOCAL_MODE
	// detection passes. We don't write outside of a tmpdir otherwise — we just
	// use mkdtempSync under the real home path and pass that absolute path in.
	//
	// On a machine where pappardelle is actually installed, ~/.pappardelle/repo
	// is itself a git clone, so `git describe` run from this nested dir would
	// walk UP and resolve the *real* installed tag instead of our fake
	// package.json version — making these orchestration tests pass in CI (no
	// clone present) but fail locally. git-init the fake dir so it is its own
	// git boundary: `git describe` finds this empty (untagged) repo, returns
	// null, and resolveInstalledVersion falls back to the package.json below.
	const installedRoot = path.join(homedir(), '.pappardelle', 'repo');
	mkdirSync(installedRoot, {recursive: true});
	const dir = mkdtempSync(path.join(installedRoot, '_test-'));
	initRepoWithTag(dir, null);
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({name: 'pappardelle', version: installed}),
	);
	return {
		projectDir: dir,
		cache: testState(t).daos.updateCheck,
		cleanup: () => rmSync(dir, {recursive: true, force: true}),
	};
}

test('checkForUpdate: returns null when LOCAL_MODE', async t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-uc-'));
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	try {
		const result = await checkForUpdate({
			projectDir: dir,
			cache: testState(t).daos.updateCheck,
		});
		t.is(result, null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial(
	'checkForUpdate: returns null when cache says we are up to date',
	async t => {
		const fake = setupFakeInstall(t, '0.1.0');
		try {
			await fake.cache.write({
				checkedAt: Date.now(),
				latestVersion: '0.1.0',
			});
			const result = await checkForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
			});
			t.is(result, null);
		} finally {
			fake.cleanup();
		}
	},
);

test.serial(
	'checkForUpdate: surfaces update when cache shows a newer version',
	async t => {
		const fake = setupFakeInstall(t, '0.1.0');
		try {
			await fake.cache.write({
				checkedAt: Date.now(),
				latestVersion: 'v0.2.0',
			});
			const result = await checkForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
			});
			t.deepEqual(result, {installedVersion: '0.1.0', latestVersion: 'v0.2.0'});
		} finally {
			fake.cleanup();
		}
	},
);

test.serial(
	'checkForUpdate: returns null when installed version is newer than cached',
	async t => {
		// Can happen if you manually bump package.json locally.
		const fake = setupFakeInstall(t, '0.3.0');
		try {
			await fake.cache.write({
				checkedAt: Date.now(),
				latestVersion: '0.2.0',
			});
			const result = await checkForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
			});
			t.is(result, null);
		} finally {
			fake.cleanup();
		}
	},
);

test.serial(
	'checkForUpdate: bypasses stale cache, calls fetchLatest, and rewrites the cache',
	async t => {
		const fake = setupFakeInstall(t, '0.1.0');
		try {
			const now = 1_800_000_000_000;
			const STALE_TTL_MS = 25 * 60 * 60 * 1000;
			await fake.cache.write({
				checkedAt: now - STALE_TTL_MS,
				latestVersion: 'v0.1.0',
			});

			let fetchCalls = 0;
			const result = await checkForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
				now,
				async fetchLatest() {
					fetchCalls += 1;
					return 'v0.5.0';
				},
			});

			t.is(fetchCalls, 1, 'stub should be called exactly once');
			t.deepEqual(result, {installedVersion: '0.1.0', latestVersion: 'v0.5.0'});

			const refreshed = fake.cache.read();
			t.deepEqual(
				refreshed,
				{checkedAt: now, latestVersion: 'v0.5.0'},
				'cache should be rewritten with the new value and fresh timestamp',
			);
		} finally {
			fake.cleanup();
		}
	},
);

test.serial(
	'checkForUpdate: stale cache + fetchLatest returning null does not corrupt the cache',
	async t => {
		const fake = setupFakeInstall(t, '0.1.0');
		try {
			const now = 1_800_000_000_000;
			const STALE_TTL_MS = 25 * 60 * 60 * 1000;
			const staleEntry: CacheEntry = {
				checkedAt: now - STALE_TTL_MS,
				latestVersion: 'v0.1.0',
			};
			await fake.cache.write(staleEntry);

			const result = await checkForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
				now,
				async fetchLatest() {
					return null;
				},
			});

			t.is(result, null);
			t.deepEqual(
				fake.cache.read(),
				staleEntry,
				'cache must not be overwritten when fetchLatest yields null',
			);
		} finally {
			fake.cleanup();
		}
	},
);

// ============================================================================
// safeCheckForUpdate contract — must never reject, regardless of input
// ============================================================================

test('safeCheckForUpdate: resolves to null for LOCAL_MODE', async t => {
	const dir = mkdtempSync(path.join(tmpdir(), 'pap-safe-'));
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({version: '0.1.0'}),
	);
	try {
		const result = await safeCheckForUpdate({
			projectDir: dir,
			cache: testState(t).daos.updateCheck,
		});
		t.is(result, null);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test.serial(
	'safeCheckForUpdate: swallows a throwing fetchLatest and resolves to null',
	async t => {
		const fake = setupFakeInstall(t, '0.1.0');
		try {
			const now = 1_800_000_000_000;
			// No cache written — orchestrator will go straight to fetchLatest.
			const result = await safeCheckForUpdate({
				projectDir: fake.projectDir,
				cache: fake.cache,
				now,
				async fetchLatest() {
					throw new Error('boom');
				},
			});
			t.is(result, null, 'the wrapper must not propagate the throw');
		} finally {
			fake.cleanup();
		}
	},
);
